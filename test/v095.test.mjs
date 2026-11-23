import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { QQChannel, normalizeQqEvent, stripQqMention } from "../src/channels/qq.mjs";
import { WechatChannel } from "../src/channels/wechat.mjs";
import { WecomChannel } from "../src/channels/wecom.mjs";
import { ChannelConfigStore } from "../src/channels/store.mjs";
import { MessageRouter } from "../src/channels/router.mjs";
import { maskConfig } from "../src/channels/secrets.mjs";
import { TaskStore } from "../src/store.mjs";
import { AgentHub } from "../src/hub.mjs";
import { createHubServer } from "../src/server.mjs";

const FAKE_CLAUDE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
const MCP_BIN = fileURLToPath(new URL("../bin/dsh-agent-hub-mcp.mjs", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url));

class FakeWebSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.sent = [];
    this.closed = false;
  }
  send(payload) {
    this.sent.push(JSON.parse(payload));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
  receive(packet) {
    this.emit("message", JSON.stringify(packet));
  }
}

test("QQ 通道：官方 WebSocket 长连接、指令路由（/员工 /派 /换）与消息发送", async () => {
  assert.equal(stripQqMention("<@!1020001> /员工"), "/员工");
  const norm = normalizeQqEvent("GROUP_AT_MESSAGE_CREATE", {
    id: "m_1",
    group_openid: "grp_99",
    content: "<@!1020001> /派 @2 跑测试",
    author: { member_openid: "u_1" },
  });
  assert.equal(norm.chatId, "qq:group:grp_99");
  assert.equal(norm.text, "/派 @2 跑测试");

  const apiCalls = [];
  let wsInstance = null;
  const qq = new QQChannel({
    throttleMs: 0,
    fetchImpl: async (url, init = {}) => {
      apiCalls.push({ url, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
      if (url.includes("getAppAccessToken")) {
        return new Response(JSON.stringify({ access_token: "qq_tok_12345", expires_in: 7200 }), { status: 200 });
      }
      if (url.endsWith("/gateway")) {
        return new Response(JSON.stringify({ url: "wss://mock.qq.gateway/ws" }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "sent_1" }), { status: 200 });
    },
    webSocketFactory: (url) => {
      wsInstance = new FakeWebSocket(url);
      return wsInstance;
    },
  });

  const cfg = qq.normalize({ appId: "1020001", clientSecret: "secret_xyz999", enabled: true });
  assert.equal(maskConfig(cfg).clientSecret, "****z999");

  const tested = await qq.test(cfg);
  assert.equal(tested.ok, true);
  assert.match(tested.message, /wss:\/\/mock\.qq\.gateway\/ws/);

  const connected = [];
  const inbounds = [];
  const startPromise = qq.start({
    config: cfg,
    getConfig: () => cfg,
    logger: { log() {}, warn() {} },
    onConnected: (info) => connected.push(info),
    onMessage: (msg) => inbounds.push(msg),
    onActivity: () => {},
  });

  // 等待 FakeWebSocket 创建
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(wsInstance, "应该创建 WebSocket 实例");
  wsInstance.receive({ op: 10, d: { heartbeat_interval: 60_000 } });
  assert.equal(wsInstance.sent[0].op, 2, "收到 Hello 后应立即发 Identify");

  wsInstance.receive({ op: 0, s: 1, t: "READY", d: { user: { id: "bot_1", username: "AgentHubBot" } } });
  assert.equal(connected.length, 1);
  assert.equal(connected[0].me.name, "AgentHubBot");

  wsInstance.receive({
    op: 0,
    s: 2,
    t: "C2C_MESSAGE_CREATE",
    d: { id: "msg_100", content: "/员工", author: { user_openid: "open_u1", username: "老板" } },
  });
  // 重复 msg_id 去重
  wsInstance.receive({
    op: 0,
    s: 3,
    t: "C2C_MESSAGE_CREATE",
    d: { id: "msg_100", content: "/员工", author: { user_openid: "open_u1", username: "老板" } },
  });
  assert.equal(inbounds.length, 1);
  assert.equal(inbounds[0].chatId, "qq:c2c:open_u1");
  assert.equal(inbounds[0].text, "/员工");

  await qq.send("qq:c2c:open_u1", "收到，已派活", { config: cfg });
  await qq.send("qq:group:grp_99", "群消息回执", { config: cfg });
  const c2cCall = apiCalls.find((c) => c.url.includes("/v2/users/open_u1/messages"));
  const grpCall = apiCalls.find((c) => c.url.includes("/v2/groups/grp_99/messages"));
  assert.equal(c2cCall.body.content, "收到，已派活");
  assert.equal(c2cCall.body.msg_id, "msg_100");
  assert.equal(grpCall.body.content, "群消息回执");

  await qq.stop();
  await startPromise;
});

test("合规微信桥接与企业微信 Webhook 通道：健康检查、轮询收消息、发送与密钥掩码", async () => {
  const bridgeSent = [];
  const wecomSent = [];
  let polled = 0;

  const mockBridge = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;

    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, loggedIn: true, accountId: "wx_me", nickname: "合规测试号" }));
      return;
    }
    if (req.url.startsWith("/poll")) {
      polled += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      if (polled === 1) {
        res.end(JSON.stringify({
          nextCursor: "c1",
          messages: [{ id: "w1", chatId: "friend_42", senderName: "老板", text: "/状态" }],
        }));
      } else {
        setTimeout(() => {
          res.end(JSON.stringify({ nextCursor: "c1", messages: [] }));
        }, 120);
      }
      return;
    }
    if (req.url === "/send") {
      bridgeSent.push({ auth: req.headers.authorization, body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/wecom-webhook") {
      wecomSent.push(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ errcode: 0, errmsg: "ok" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => mockBridge.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${mockBridge.address().port}`;

  try {
    const wechat = new WechatChannel({ throttleMs: 0 });
    const wxCfg = wechat.normalize({ bridgeUrl: base, bridgeToken: "wx_secret_8888", enabled: true });
    assert.equal(maskConfig(wxCfg).bridgeToken, "****8888");
    const wxTest = await wechat.test(wxCfg);
    assert.equal(wxTest.ok, true);
    assert.match(wxTest.message, /合规测试号/);

    const received = [];
    const run = wechat.start({
      config: wxCfg,
      getConfig: () => wxCfg,
      logger: { log() {}, warn() {} },
      onConnected: () => {},
      onActivity: () => {},
      onMessage: (msg) => {
        received.push(msg);
        wechat.stop();
      },
    });
    await run;
    assert.equal(received.length, 1);
    assert.equal(received[0].chatId, "wx:friend_42");
    assert.equal(received[0].text, "/状态");

    await wechat.send("wx:friend_42", "任务完成了", { config: wxCfg });
    assert.equal(bridgeSent.length, 1);
    assert.equal(bridgeSent[0].auth, "Bearer wx_secret_8888");
    assert.equal(bridgeSent[0].body.chatId, "friend_42");

    // 企业微信官方群机器人 Webhook 模式
    const wecom = new WecomChannel({ throttleMs: 0 });
    const wcCfg = wecom.normalize({
      mode: "webhook",
      webhookUrl: `${base}/wecom-webhook`,
      enabled: true,
    });
    assert.match(maskConfig(wcCfg).webhookUrl, /^\*\*\*\*/);
    assert.equal((await wecom.test(wcCfg)).ok, true);
    await wecom.send("wecom:webhook", "任务完成通知", { config: wcCfg });
    assert.equal(wecomSent.length, 1);
    assert.equal(wecomSent[0].msgtype, "text");
    assert.equal(wecomSent[0].text.content, "任务完成通知");
  } finally {
    await new Promise((resolve) => mockBridge.close(resolve));
  }
});

test("多通道主动通知推送：完成/等你自动推给已开启通知的通道，关闭开关则不推，且不重复推", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-hub-notify-"));
  const configStore = new ChannelConfigStore(join(dir, "channels.json")).load();
  const sent = [];

  try {
    configStore.patch("telegram", { enabled: true, notifyEnabled: true, token: "t1" });
    configStore.upsertBinding("telegram", { chatId: "tg:100" });

    configStore.patch("qq", { enabled: true, notifyEnabled: true, appId: "1", clientSecret: "s" });
    configStore.upsertBinding("qq", { chatId: "qq:c2c:u1" });

    // 飞书关闭了主动通知，不应收到网页派活的广播
    configStore.patch("feishu", { enabled: true, notifyEnabled: false, appId: "cli_1", appSecret: "s" });
    configStore.upsertBinding("feishu", { chatId: "fs:oc_1" });

    // 企业微信 webhook 模式启用了通知，无需 allowlist 也能直推
    configStore.patch("wecom", { enabled: true, notifyEnabled: true, mode: "webhook", webhookUrl: "https://example.invalid/hook" });

    const router = new MessageRouter({
      configStore,
      hub: {
        taskDetail: (id) => ({
          id,
          title: id === "t_ok" ? "整理周报" : "跑构建脚本",
          role: "main",
          result: id === "t_ok" ? "周报已生成 docs/weekly.md" : null,
          error: id === "t_fail" ? "退出码 1：缺少依赖" : null,
        }),
      },
      logger: { warn() {}, log() {} },
      send: async (channelId, chatId, body) => {
        sent.push({ channelId, chatId, body });
      },
      resolveChannel: () => ({ implemented: true }),
    });

    // 1. 网页派发任务完成 → Telegram / QQ / WeCom 均收到，Feishu(notifyEnabled:false) 不收到
    await router.onTaskEvent({ type: "task", taskId: "t_ok", role: "main", status: "completed", stage: "done", title: "整理周报" });
    assert.deepEqual(
      sent.map((item) => `${item.channelId}:${item.chatId}`).sort(),
      ["qq:qq:c2c:u1", "telegram:tg:100", "wecom:wecom:webhook"],
    );
    assert.match(sent[0].body, /周报已生成/);

    // 2. 再次触发同一终态不重复推
    const beforeCount = sent.length;
    await router.onTaskEvent({ type: "task", taskId: "t_ok", role: "main", status: "completed", stage: "done", title: "整理周报" });
    assert.equal(sent.length, beforeCount);

    // 3. 任务失败落入「等你」→ 推送失败卡点摘要
    await router.onTaskEvent({ type: "task", taskId: "t_fail", role: "main", status: "failed", stage: "waiting", title: "跑构建脚本" });
    const failMsgs = sent.slice(beforeCount);
    assert.equal(failMsgs.length, 3);
    assert.match(failMsgs[0].body, /缺少依赖/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP 断连友好提示：本地 Hub 未启动时 STDIO 入口返回中文引导而非原始堆栈", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_BIN],
    env: { ...process.env, DSH_HUB_URL: "http://127.0.0.1:1" },
    stderr: "pipe",
  });
  const client = new Client({ name: "mcp-offline-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const res = await client.callTool({ name: "list_workers", arguments: {} });
    assert.equal(res.isError, true);
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.code, "HUB_UNREACHABLE");
    assert.match(body.error, /未检测到运行中的本地 CyberForeman/);
    assert.match(body.error, /npm start/);
    assert.match(body.hint, /启动本地 CyberForeman/);
    assert.ok(!/ECONNREFUSED|at\s+fetch/i.test(body.error), "不应暴露原始网络堆栈");
  } finally {
    await client.close().catch(() => {});
  }
});

test("模板全功能编辑（PUT /api/templates/:id）与重启中断任务一键批量重派（POST /api/tasks/retry-interrupted）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-hub-v095-http-"));
  const dataDir = join(dir, "data");

  // 预先制造两个 Hub 重启时被标为 interrupted 的主任务（其中一个员工已停用，用于校验 skipped）
  const preStore = new TaskStore(dataDir).init();
  const t1 = preStore.createTask({ workerId: "claude-ok", kind: "claude-cli", title: "中断任务A", prompt: "第一个任务：恢复A", cwd: ROOT });
  preStore.updateTask(t1.id, { status: "running" });
  const t2 = preStore.createTask({ workerId: "claude-off", kind: "claude-cli", title: "中断任务B", prompt: "第一个任务：恢复B", cwd: ROOT });
  preStore.updateTask(t2.id, { status: "running" });

  const ctx = await createHubServer({
    channels: false,
    config: {
      port: 0,
      dataDir,
      workers: {
        "claude-ok": {
          name: "正常员工",
          kind: "claude-cli",
          command: process.execPath,
          argsPrefix: [FAKE_CLAUDE],
          cwd: ROOT,
          permissionMode: "acceptEdits",
        },
        "claude-off": {
          name: "停用员工",
          kind: "claude-cli",
          command: process.execPath,
          argsPrefix: [FAKE_CLAUDE],
          cwd: ROOT,
          permissionMode: "acceptEdits",
          disabled: true,
        },
      },
    },
  });

  await new Promise((resolve, reject) => {
    ctx.server.once("error", reject);
    ctx.server.listen(0, "127.0.0.1", resolve);
  });
  const base = `http://127.0.0.1:${ctx.server.address().port}`;
  const req = (path, { method = "GET", body } = {}) => fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, data: await r.json() }));

  try {
    // 1. 模板全功能编辑：新建 → 编辑名称/内容/员工/目录 → 清空可选字段
    const created = await req("/api/templates", {
      method: "POST",
      body: { name: "旧模板", prompt: "旧内容", workerId: "claude-ok", cwd: ROOT },
    });
    assert.equal(created.status, 201);
    const tplId = created.data.template.id;

    const updated = await req(`/api/templates/${tplId}`, {
      method: "PUT",
      body: { name: "新模板名", prompt: "更新后的提示词", workerId: "", cwd: "" },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.template.id, tplId);
    assert.equal(updated.data.template.name, "新模板名");
    assert.equal(updated.data.template.prompt, "更新后的提示词");
    assert.equal(updated.data.template.workerId, undefined, "清空默认员工应生效");
    assert.equal(updated.data.template.cwd, undefined, "清空默认目录应生效");

    // 2. 启动后两个任务应已被 TaskStore.init() 标为 interrupted
    assert.equal(ctx.store.getTask(t1.id).status, "interrupted");
    assert.equal(ctx.store.getTask(t2.id).status, "interrupted");

    // 一键批量重派
    const batch = await req("/api/tasks/retry-interrupted", { method: "POST", body: {} });
    assert.equal(batch.status, 200);
    assert.equal(batch.data.count, 1);
    assert.equal(batch.data.retried[0].id, t1.id);
    assert.equal(batch.data.skipped.length, 1);
    assert.equal(batch.data.skipped[0].id, t2.id);

    const waited = await req(`/api/tasks/${t1.id}/wait`, { method: "POST", body: { timeoutSeconds: 8 } });
    assert.equal(waited.data.task.status, "completed");
    assert.equal(waited.data.task.manualRetries, 1);
    assert.match(waited.data.task.result, /RECEIVED:第一个任务/);
    assert.equal(ctx.store.getTask(t2.id).status, "interrupted", "停用员工的任务应保持 interrupted");
  } finally {
    await ctx.hub.stopAll();
    await new Promise((resolve) => ctx.server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
