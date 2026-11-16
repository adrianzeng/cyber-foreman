import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskStore } from "../src/store.mjs";
import { AgentHub } from "../src/hub.mjs";
import { ChannelConfigStore } from "../src/channels/store.mjs";
import { ChannelManager, backoffMs } from "../src/channels/index.mjs";
import { DedupeRing, MergeWindow, splitText } from "../src/channels/base.mjs";
import { MessageRouter } from "../src/channels/router.mjs";
import { TelegramChannel, toInboundMessage } from "../src/channels/telegram.mjs";
import { createHubServer } from "../src/server.mjs";

const FAKE_CLAUDE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TOKEN = "123456:ABCdefGHIjkl";
const API_USERNAME = "dsh_hub_bot";
const QUIET = { log() {}, warn() {}, error() {} };

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function waitFor(predicate, timeoutMs = 12_000, label = "条件") {
  return new Promise((resolvePromise, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      let value;
      try {
        value = predicate();
      } catch (error) {
        reject(error);
        return;
      }
      if (value) {
        resolvePromise(value);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`等待${label}超时`));
        return;
      }
      setTimeout(tick, 40);
    };
    tick();
  });
}

/**
 * 假的 Telegram Bot API：只实现我们真正用到的四个方法。
 * 这样可以精确控制 429 / 500 / 重复 update，不用连真实网络。
 */
function createFakeBotApi() {
  const state = {
    updates: [],
    sent: [],
    getMeCalls: 0,
    getUpdatesCalls: 0,
    rateLimitTimes: 0,
    failGetUpdatesTimes: 0,
    nextUpdateId: 1,
    nextMessageId: 1,
    lastOffset: null,
  };

  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const matched = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(url.pathname);
      const reply = (status, payload) => {
        const text = JSON.stringify(payload);
        response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
        response.end(text);
      };
      if (!matched) return reply(404, { ok: false, description: "Not Found" });
      const [, token, method] = matched;
      if (token !== TOKEN) return reply(401, { ok: false, description: "Unauthorized" });
      let payload = {};
      try {
        payload = body ? JSON.parse(body) : {};
      } catch {
        payload = {};
      }

      if (method === "getMe") {
        state.getMeCalls += 1;
        return reply(200, { ok: true, result: { id: 42, username: API_USERNAME, first_name: "DSH", is_bot: true } });
      }
      if (method === "getUpdates") {
        state.getUpdatesCalls += 1;
        state.lastOffset = payload.offset ?? null;
        if (state.failGetUpdatesTimes > 0) {
          state.failGetUpdatesTimes -= 1;
          return reply(500, { ok: false, description: "Internal Server Error" });
        }
        const items = state.updates.splice(0, state.updates.length);
        return reply(200, { ok: true, result: items });
      }
      if (method === "sendMessage") {
        if (state.rateLimitTimes > 0) {
          state.rateLimitTimes -= 1;
          return reply(429, {
            ok: false,
            description: "Too Many Requests: retry after 0",
            parameters: { retry_after: 0 },
          });
        }
        state.sent.push({ chatId: payload.chat_id, text: String(payload.text || ""), at: Date.now() });
        return reply(200, { ok: true, result: { message_id: state.nextMessageId++ } });
      }
      return reply(404, { ok: false, description: "Not Found" });
    });
  });

  return {
    state,
    server,
    async listen() {
      await new Promise((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolvePromise);
      });
      this.base = `http://127.0.0.1:${server.address().port}`;
      return this.base;
    },
    async close() {
      await new Promise((resolvePromise) => server.close(resolvePromise));
    },
    /** 往队列里塞一条文本消息，返回 update_id。 */
    pushText(text, options = {}) {
      const updateId = options.updateId ?? state.nextUpdateId++;
      if (!options.updateId) state.nextUpdateId = updateId + 1;
      const chatId = options.chatId ?? 837465123;
      const update = {
        update_id: updateId,
        message: {
          message_id: updateId,
          date: Math.floor(Date.now() / 1000),
          chat: {
            id: chatId,
            type: options.chatType || "private",
            title: options.chatTitle,
          },
          from: {
            id: 7,
            is_bot: false,
            first_name: options.firstName || "阿德",
            username: options.username || "ade",
          },
          text,
        },
      };
      state.updates.push(update);
      return updateId;
    },
    texts() {
      return state.sent.map((item) => item.text);
    },
  };
}

function makeStack(options = {}) {
  const directory = tempDir("agent-hub-telegram-");
  const dataDir = join(directory, "data");
  const store = new TaskStore(dataDir).init();
  const workers = {
    "claude-1": {
      name: "Claude 一号",
      kind: "claude-cli",
      command: process.execPath,
      argsPrefix: [FAKE_CLAUDE],
      cwd: ROOT,
      permissionMode: "acceptEdits",
      ...(options.worker || {}),
    },
  };
  const hub = new AgentHub({ store, workers });
  const configStore = new ChannelConfigStore(join(dataDir, "channels.json")).load();
  const telegram = options.telegram || new TelegramChannel({ throttleMs: 0 });
  const manager = new ChannelManager({
    configStore,
    hub,
    store,
    logger: QUIET,
    adapters: new Map([["telegram", telegram]]),
  });
  return {
    directory,
    dataDir,
    store,
    hub,
    configStore,
    telegram,
    manager,
    async start() {
      await manager.load();
      await manager.startEnabled();
      return this;
    },
    async cleanup() {
      await manager.stopAll();
      await hub.stopAll();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("Telegram 纯函数：消息归一化、回环去重、分段", () => {
  const me = { username: API_USERNAME };

  const direct = toInboundMessage({
    message_id: 1,
    date: 1_700_000_000,
    chat: { id: 837465123, type: "private" },
    from: { id: 7, first_name: "阿德", username: "ade" },
    text: "/派 整理 README",
  }, me);
  assert.equal(direct.channelId, "telegram");
  assert.equal(direct.chatId, "tg:837465123");
  assert.equal(direct.chatType, "p2p");
  assert.equal(direct.senderName, "@ade");
  assert.equal(direct.text, "/派 整理 README");
  assert.equal(direct.messageId, "tg:837465123:1");

  const groupNoMention = toInboundMessage({
    message_id: 2,
    chat: { id: -100, type: "supergroup", title: "项目群" },
    from: { id: 7, first_name: "阿德" },
    text: "随便聊聊",
  }, me);
  assert.equal(groupNoMention, null, "群里没 @我 就不该进 Router");

  const groupMention = toInboundMessage({
    message_id: 3,
    chat: { id: -100, type: "supergroup", title: "项目群" },
    from: { id: 7, first_name: "阿德" },
    text: `@${API_USERNAME} /派 整理 README`,
  }, me);
  assert.equal(groupMention.chatType, "group");
  assert.equal(groupMention.mentionsMe, true);
  assert.equal(groupMention.text, "/派 整理 README");

  const groupCommand = toInboundMessage({
    message_id: 4,
    chat: { id: -100, type: "supergroup", title: "项目群" },
    from: { id: 7, first_name: "阿德" },
    text: `/派@${API_USERNAME} 整理 README`,
  }, me);
  assert.equal(groupCommand.text, "/派 整理 README");

  const nonText = toInboundMessage({
    message_id: 5,
    chat: { id: 9, type: "private" },
    from: { id: 7, first_name: "阿德" },
  }, me);
  assert.equal(nonText.text, "");

  const ring = new DedupeRing(3);
  assert.equal(ring.seen("a"), false);
  assert.equal(ring.seen("a"), true);
  ring.seen("b");
  ring.seen("c");
  ring.seen("d");
  assert.equal(ring.seen("a"), false, "超出容量的旧 id 应被忘掉");

  const long = `${"一行内容".repeat(4000)}`;
  const { parts, truncated } = splitText(long, 3900, 3);
  assert.equal(parts.length, 3);
  assert.equal(truncated, true);
  for (const part of parts) assert.ok(part.length <= 3900);
});

test("Telegram 端到端：/绑定 → 派活 → 回执先到 → 完成推送", async () => {
  const api = await createFakeBotApi();
  await api.listen();
  const stack = makeStack();
  try {
    stack.configStore.patch("telegram", { token: TOKEN, apiBase: api.base, enabled: true });
    await stack.start();

    await waitFor(
      () => stack.manager.describe("telegram").state === "running",
      10_000,
      "通道连上",
    );
    assert.equal(stack.manager.describe("telegram").me.username, API_USERNAME);

    // 1) 未绑定：固定话术，不产生任务
    api.pushText("/派 整理 README");
    await waitFor(() => api.texts().some((text) => text.includes("还没绑定")), 10_000, "未绑定提示");
    assert.equal(stack.store.counts().total, 0, "未绑定不能产生任务");

    // 2) 配对码绑定
    const pair = stack.configStore.createPairCode("telegram");
    api.pushText(`/绑定 ${pair.code}`, { updateId: 900 });
    await waitFor(() => api.texts().some((text) => text.includes("绑定成功")), 10_000, "绑定回执");
    assert.ok(stack.configStore.findBinding("tg:837465123"));
    assert.equal(stack.configStore.pairCodeFor("telegram"), null, "配对码用后即焚");

    // 3) 长任务：回执必须在 CLI 还没结束时就到达
    api.pushText("/派 SLOW_ME 长任务", { updateId: 901 });
    await waitFor(() => api.texts().some((item) => item.includes("收到，已派给")), 10_000, "派活回执");
    const receiptIndex = api.texts().findIndex((item) => item.includes("收到，已派给"));
    assert.ok(receiptIndex >= 0);
    const runningTask = stack.store.listTasks({ limit: 1 })[0];
    assert.equal(stack.store.getTask(runningTask.id).status, "running", "回执到达时任务应还在跑");
    assert.match(api.texts()[receiptIndex], /Claude 一号/);
    assert.match(api.texts()[receiptIndex], /长任务/);

    // 4) 停止 → 推一条「已停止」
    stack.hub.stopTask(runningTask.id);
    await waitFor(() => api.texts().some((text) => text.includes("已停止")), 12_000, "停止推送");

    // 5) 普通任务：完成推送
    api.pushText("/派 第一个任务：端到端", { updateId: 902 });
    await waitFor(() => api.texts().some((text) => text.includes("跑完了")), 12_000, "完成推送");
    const completedPush = api.texts().find((text) => text.includes("跑完了"));
    assert.match(completedPush, /RECEIVED:第一个任务/);

    // 6) 重复 update_id 不重复派活
    const before = stack.store.counts().total;
    api.pushText("/派 第一个任务：去重", { updateId: 903 });
    await waitFor(() => stack.store.counts().total === before + 1, 10_000, "去重前的派活");
    api.state.updates.push({
      update_id: 903,
      message: {
        message_id: 903,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 837465123, type: "private" },
        from: { id: 7, first_name: "阿德", username: "ade" },
        text: "/派 第一个任务：去重",
      },
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 800));
    assert.equal(stack.store.counts().total, before + 1, "同一个 update_id 只能派一次");
  } finally {
    await stack.cleanup();
    await api.close();
  }
});

test("Telegram 发送：3900 字分段 ≤3 段、429 按 retry_after 重试不丢消息", async () => {
  const api = await createFakeBotApi();
  await api.listen();
  const channel = new TelegramChannel({ throttleMs: 0 });
  try {
    const config = { token: TOKEN, apiBase: api.base };
    const long = Array.from({ length: 700 }, (_, index) => `第 ${index} 行：这是一段用来验证分段行为的文本。`).join("\n");
    assert.ok(long.length > 11_800, `准备的长文本要超过 3 段（实际 ${long.length} 字）`);

    const result = await channel.send("tg:837465123", long, { config });
    assert.equal(result.segments, 3);
    assert.equal(api.state.sent.length, 3);
    for (const item of api.state.sent) assert.ok(item.text.length <= 3950, "每段都必须在 3900 字附近");
    assert.match(api.texts()[2], /完整内容去面板看/);

    // 429：第一次被限流，第二次成功，消息不能丢
    api.state.sent.length = 0;
    api.state.rateLimitTimes = 1;
    await channel.send("tg:837465123", "限流后也要送到", { config });
    assert.equal(api.state.sent.length, 1);
    assert.equal(api.state.sent[0].text, "限流后也要送到");

    // Token 错 → 中文错误，且不能把 token 带进消息
    api.state.sent.length = 0;
    const wrong = new TelegramChannel({ throttleMs: 0 });
    const failed = await wrong.test({ token: "999999:wrongwrongwrong", apiBase: api.base });
    assert.equal(failed.ok, false);
    assert.match(failed.message, /Token/);
  } finally {
    await channel.stop();
    await api.close();
  }
});

test("Telegram 500：通道进 error 退避，Hub 与 HTTP 不受影响，错误已脱敏", async () => {
  const api = await createFakeBotApi();
  await api.listen();
  const directory = tempDir("agent-hub-telegram-500-");
  const config = {
    port: 0,
    dataDir: join(directory, "data"),
    workers: {
      "claude-1": {
        name: "Claude 一号",
        kind: "claude-cli",
        command: process.execPath,
        argsPrefix: [FAKE_CLAUDE],
        cwd: ROOT,
        permissionMode: "acceptEdits",
      },
    },
  };
  const context = await createHubServer({ config, logger: QUIET });
  try {
    await new Promise((resolvePromise, reject) => {
      context.server.once("error", reject);
      context.server.listen(0, "127.0.0.1", resolvePromise);
    });
    const base = `http://127.0.0.1:${context.server.address().port}`;

    api.state.failGetUpdatesTimes = 999;
    context.channelStore.patch("telegram", { token: TOKEN, apiBase: api.base, enabled: true });
    await context.channelManager.restart("telegram");

    const view = await waitFor(
      () => {
        const current = context.channelManager.describe("telegram");
        return current.state === "error" ? current : null;
      },
      12_000,
      "通道进入 error",
    );
    assert.ok(view.lastError, "必须有 lastError");
    assert.equal(view.lastError.includes(TOKEN), false, "错误里不能出现 token");
    assert.match(view.lastError, /Telegram 返回 500|稍后会自动重试|服务出问题/);
    assert.ok(view.status.reconnects >= 1);

    // HTTP 完全不受影响
    const health = await fetch(`${base}/api/health`).then((response) => response.json());
    assert.equal(health.service, "dsh-agent-hub");
    const channels = await fetch(`${base}/api/channels`).then((response) => response.json());
    const telegram = channels.channels.find((item) => item.id === "telegram");
    assert.equal(telegram.implemented, true);
    assert.equal(telegram.state, "error");
    assert.equal(JSON.stringify(channels).includes(TOKEN), false, "通道列表里不能出现 token 明文");

    // 任务照常能派（通道挂了不影响 Hub）
    const created = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "第一个任务：通道挂了也要能派" }),
    }).then((response) => response.json());
    const done = await fetch(`${base}/api/tasks/${created.task.id}/wait`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeoutSeconds: 10 }),
    }).then((response) => response.json());
    assert.equal(done.task.status, "completed");
  } finally {
    await context.channelManager.stopAll();
    await context.hub.stopAll();
    await new Promise((resolvePromise) => context.server.close(resolvePromise));
    rmSync(directory, { recursive: true, force: true });
    await api.close();
  }
});

test("600ms 合并窗口：同会话同任务连发 3 条并成 1 次插话，且保留 parts", async () => {
  const directory = tempDir("agent-hub-merge-");
  const dataDir = join(directory, "data");
  const store = new TaskStore(dataDir).init();
  const configStore = new ChannelConfigStore(join(dataDir, "channels.json")).load();
  const calls = [];
  const hub = {
    listWorkers: () => [{ id: "claude-1", name: "Claude 一号", enabled: true }],
    steerTask(id, text, opts) {
      calls.push({ id, text, opts });
      return { delivered: "steer", task: { id, title: "在跑的任务" } };
    },
    askSide: () => ({ task: { id: "task_side" } }),
  };
  const sent = [];
  const router = new MessageRouter({
    configStore,
    hub,
    store,
    logger: QUIET,
    mergeWindowMs: 60,
    send: async (channelId, chatId, text) => { sent.push(text); },
    resolveChannel: () => ({ label: "Telegram" }),
  });
  try {
    configStore.upsertBinding("telegram", { chatId: "tg:1", workerId: "claude-1" });
    const task = store.createTask({
      workerId: "claude-1",
      kind: "claude-cli",
      title: "在跑的任务",
      prompt: "在跑的任务",
      cwd: ROOT,
    });
    store.updateTask(task.id, { status: "running" });
    configStore.addDelivery({ taskId: task.id, channelId: "telegram", chatId: "tg:1" });

    // 三条消息在窗口内连发
    await router.handle({ channelId: "telegram", chatId: "tg:1", text: "第一句" });
    await router.handle({ channelId: "telegram", chatId: "tg:1", text: "第二句" });
    await router.handle({ channelId: "telegram", chatId: "tg:1", text: "第三句" });

    assert.equal(calls.length, 0, "窗口内不该立刻写进去");
    await waitFor(() => calls.length === 1, 2000, "合并后写入");
    assert.equal(calls[0].text, "第一句\n\n第二句\n\n第三句");
    assert.deepEqual(calls[0].opts.parts, ["第一句", "第二句", "第三句"]);
    await waitFor(() => sent.some((text) => text.includes("已插话")), 2000, "合并回执");
  } finally {
    router.mergeWindow?.clear();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("MergeWindow 清理与退避常量", () => {
  const flushed = [];
  const window = new MergeWindow({ windowMs: 50, onFlush: (parts) => flushed.push(parts) });
  window.push("k", "a");
  window.push("k", "b");
  window.clear();
  assert.equal(flushed.length, 0, "clear() 之后不该再触发回调");
  window.push("k2", "c");
  return new Promise((resolvePromise) => {
    setTimeout(() => {
      assert.deepEqual(flushed, [["c"]]);
      resolvePromise();
    }, 120);
  });
});

test("backoffMs 在通道层与 manager 里是同一份实现", () => {
  assert.equal(backoffMs(1), 1000);
  assert.equal(backoffMs(2), 2000);
  assert.equal(backoffMs(30), 60_000);
});
