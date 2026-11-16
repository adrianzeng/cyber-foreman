import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHANNEL_IDS,
  ChannelConfigStore,
  MAX_ALLOWLIST,
  MAX_DELIVERIES,
} from "../src/channels/store.mjs";
import { mask, maskConfig, mergeMasked, scrub } from "../src/channels/secrets.mjs";
import { parseIntent, shortId } from "../src/channels/intent.mjs";
import { MessageRouter } from "../src/channels/router.mjs";
import { backoffMs } from "../src/channels/index.mjs";
import { TaskStore } from "../src/store.mjs";
import { AgentHub } from "../src/hub.mjs";
import { createHubServer } from "../src/server.mjs";

const TOKEN = "123456:ABCdefGHIjkl";

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeConfigStore() {
  const directory = tempDir("agent-hub-channel-store-");
  const store = new ChannelConfigStore(join(directory, "channels.json")).load();
  return {
    store,
    file: join(directory, "channels.json"),
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test("通道配置仓库：4 个通道、改配置落盘、重开还在", () => {
  const ctx = makeConfigStore();
  try {
    assert.deepEqual(CHANNEL_IDS, ["telegram", "feishu", "wecom", "wechat"]);
    for (const id of CHANNEL_IDS) {
      const config = ctx.store.get(id);
      assert.ok(config, `${id} 应该有默认配置`);
      assert.equal(config.enabled, false);
      assert.deepEqual(config.allowlist, []);
      assert.equal(config.pairCode, null);
    }
    assert.equal(ctx.store.get("telegram").apiBase, "https://api.telegram.org");
    assert.equal(ctx.store.get("feishu").domain, "open.feishu.cn");

    ctx.store.patch("telegram", { token: TOKEN, enabled: true, apiBase: "https://tg.example.com" });
    ctx.store.patch("telegram", { defaults: { workerId: "claude-1" } });
    const reopened = new ChannelConfigStore(ctx.file).load();
    const telegram = reopened.get("telegram");
    assert.equal(telegram.token, TOKEN);
    assert.equal(telegram.enabled, true);
    assert.equal(telegram.apiBase, "https://tg.example.com");
    assert.equal(telegram.defaults.workerId, "claude-1");

    assert.throws(() => ctx.store.get("nope"), /没有这个通道/);
  } finally {
    ctx.cleanup();
  }
});

test("白名单：绑定、整表替换、上限 30、解绑", () => {
  const ctx = makeConfigStore();
  try {
    const entry = ctx.store.upsertBinding("telegram", {
      chatId: "tg:1",
      chatType: "p2p",
      chatTitle: "阿德",
      workerId: "claude-1",
    });
    assert.equal(entry.chatId, "tg:1");
    assert.equal(entry.boundBy, "manual");
    assert.equal(entry.enabled, true);

    const found = ctx.store.findBinding("tg:1");
    assert.equal(found.channelId, "telegram");
    assert.equal(found.entry.workerId, "claude-1");
    assert.equal(ctx.store.findBinding("tg:unknown"), null);

    // 再绑一次同一个会话是覆盖，不是追加
    ctx.store.upsertBinding("telegram", { chatId: "tg:1", chatTitle: "改过的名字" });
    assert.equal(ctx.store.get("telegram").allowlist.length, 1);
    assert.equal(ctx.store.get("telegram").allowlist[0].chatTitle, "改过的名字");

    // 上限 30，超了从最旧的挤掉
    for (let index = 0; index < MAX_ALLOWLIST + 5; index += 1) {
      ctx.store.upsertBinding("telegram", { chatId: `tg:${100 + index}` });
    }
    const list = ctx.store.get("telegram").allowlist;
    assert.equal(list.length, MAX_ALLOWLIST);
    assert.equal(list.some((item) => item.chatId === "tg:1"), false, "最旧的应该被挤掉");
    assert.equal(list.some((item) => item.chatId === `tg:${100 + MAX_ALLOWLIST + 4}`), true);

    // 缺 chatId 要报错
    assert.throws(() => ctx.store.upsertBinding("telegram", {}), /chatId/);

    // 整表替换 + 坏条目提示第几条
    assert.throws(
      () => ctx.store.setAllowlist("telegram", [{ chatId: "tg:9" }, { chatTitle: "没有 chatId" }]),
      /第 2 个绑定项/,
    );
    ctx.store.setAllowlist("telegram", [{ chatId: "tg:9" }]);
    assert.equal(ctx.store.get("telegram").allowlist.length, 1);

    assert.equal(ctx.store.removeBinding("telegram", "tg:9"), true);
    assert.equal(ctx.store.removeBinding("telegram", "tg:9"), false);
    assert.equal(ctx.store.get("telegram").allowlist.length, 0);
  } finally {
    ctx.cleanup();
  }
});

test("配对码：6 位数字、10 分钟过期、用后即焚", () => {
  const ctx = makeConfigStore();
  try {
    const pair = ctx.store.createPairCode("wecom");
    assert.match(pair.code, /^\d{6}$/);
    assert.ok(Date.parse(pair.expiresAt) > Date.now());

    const live = ctx.store.pairCodeFor("wecom");
    assert.equal(live.code, pair.code);
    assert.ok(live.remainingMs > 0);

    assert.equal(ctx.store.consumePairCode("wecom", "000000"), false, "错的码不能通过");
    assert.equal(ctx.store.consumePairCode("wecom", pair.code), true);
    assert.equal(ctx.store.pairCodeFor("wecom"), null, "用后即焚");
    assert.equal(ctx.store.consumePairCode("wecom", pair.code), false);

    const expired = ctx.store.createPairCode("telegram", { ttlMs: 60_000, now: Date.now() - 120_000 });
    assert.ok(expired.code);
    assert.equal(ctx.store.pairCodeFor("telegram"), null, "过期的码不算有效");
  } finally {
    ctx.cleanup();
  }
});

test("投递记录与编号顺序：最多 200 条、按会话可查、lastList 落盘", () => {
  const ctx = makeConfigStore();
  try {
    ctx.store.addDelivery({ taskId: "task_1", channelId: "telegram", chatId: "tg:1", kind: "main" });
    // 同任务同会话只留一条
    ctx.store.addDelivery({ taskId: "task_1", channelId: "telegram", chatId: "tg:1", lastNotifiedStatus: "queued" });
    assert.equal(ctx.store.deliveriesFor("task_1").length, 1);

    ctx.store.recordDelivery("task_1", { pushedAt: "2026-01-01T00:00:00.000Z", lastNotifiedStatus: "completed" });
    const [delivery] = ctx.store.deliveriesFor("task_1");
    assert.equal(delivery.lastNotifiedStatus, "completed");
    assert.ok(delivery.pushedAt);

    for (let index = 0; index < MAX_DELIVERIES + 10; index += 1) {
      ctx.store.addDelivery({ taskId: `task_${index}`, channelId: "telegram", chatId: "tg:2" });
    }
    assert.equal(ctx.store.deliveriesFor("task_1").length, 0, "最旧的投递记录要被挤掉");
    assert.equal(ctx.store.deliveriesForChat("tg:2").length <= MAX_DELIVERIES, true);

    ctx.store.setLastList("tg:1", ["task_a", "task_b"]);
    const reopened = new ChannelConfigStore(ctx.file).load();
    assert.deepEqual(reopened.getLastList("tg:1"), ["task_a", "task_b"]);
    assert.deepEqual(reopened.getLastList("tg:none"), []);

    assert.throws(() => ctx.store.addDelivery({ taskId: "", channelId: "telegram", chatId: "tg:1" }), /缺少/);
  } finally {
    ctx.cleanup();
  }
});

test("脱敏：掩码、掩码回传保留原值、显式清空、日志 scrub", () => {
  const current = { token: TOKEN, appSecret: "abcdef1234567890", apiBase: "https://api.telegram.org", enabled: true };

  assert.equal(mask(TOKEN), "****Ijkl");
  assert.equal(mask(""), "");
  assert.equal(mask("abc"), "****");

  // 未改：传空 / 传掩码 → 保留原值
  assert.equal(mergeMasked({ token: "" }, current).token, TOKEN);
  assert.equal(mergeMasked({ token: "****Ijkl" }, current).token, TOKEN);
  assert.equal(mergeMasked({ appSecret: mask(current.appSecret) }, current).appSecret, current.appSecret);
  // 显式清空
  assert.equal(mergeMasked({ token: "", clearToken: true }, current).token, "");
  // 真的换了新值
  assert.equal(mergeMasked({ token: "999:newTokenValue" }, current).token, "999:newTokenValue");
  // 非敏感字段照常覆盖
  assert.equal(mergeMasked({ apiBase: "https://x" }, current).apiBase, "https://x");
  // clearToken 不进配置
  assert.equal(Object.hasOwn(mergeMasked({ token: "", clearToken: true }, current), "clearToken"), false);

  const text = `GET https://api.telegram.org/bot${TOKEN}/getUpdates failed, secret=${current.appSecret}`;
  const cleaned = scrub(text, current);
  assert.equal(cleaned.includes(TOKEN), false);
  assert.equal(cleaned.includes(current.appSecret), false);
  assert.match(cleaned, /\*\*\*\*Ijkl/);

  // 数组形式也支持；太短的值不动
  assert.equal(scrub("a 123456 b", ["123456"]).includes("123456"), false);
  assert.equal(scrub("a 123 b", ["123"]), "a 123 b");

  const masked = maskConfig(current);
  assert.equal(masked.token, "****Ijkl");
  assert.equal(masked.enabled, true);
  assert.equal(masked.apiBase, "https://api.telegram.org");
});

test("意图解析：所有命令分支", () => {
  const tasks = [
    { id: "task_20260101000000_aaaaaa", title: "整理 README", workerId: "claude-1", status: "running" },
    { id: "task_20260101000001_bbbbbb", title: "改样式", workerId: "codex-1", status: "completed" },
  ];

  assert.equal(parseIntent("", {}).kind, "empty");
  assert.equal(shortId(tasks[0].id), "aaaaaa");

  // 无 running → 派活
  const plain = parseIntent("整理 README", { tasks, running: [] });
  assert.equal(plain.kind, "dispatch");
  assert.equal(plain.text, "整理 README");
  assert.equal(plain.auto, true);

  // 一个 running → 插话
  const autoSteer = parseIntent("顺手把图也换掉", { tasks, running: [tasks[0]] });
  assert.equal(autoSteer.kind, "steer");
  assert.equal(autoSteer.auto, true);
  assert.equal(autoSteer.targetTaskId, tasks[0].id);

  // 多个 running → 不猜
  const ambiguous = parseIntent("顺手把图也换掉", { tasks, running: [tasks[0], tasks[1]] });
  assert.equal(ambiguous.kind, "ambiguous");
  assert.equal(ambiguous.candidates.length, 2);
  assert.equal(ambiguous.candidates[0].index, 1);

  assert.equal(parseIntent("/派 整理 README", { tasks }).kind, "dispatch");
  assert.equal(parseIntent("／派 整理 README", { tasks }).kind, "dispatch", "全角斜杠也要认");
  assert.equal(parseIntent("/派 2 个文件里的错字", { tasks }).text, "2 个文件里的错字", "派活不吞开头数字");

  const steer = parseIntent("/插 2 换个方向", { tasks });
  assert.equal(steer.kind, "steer");
  assert.equal(steer.targetIndex, 2);
  assert.equal(steer.targetTaskId, tasks[1].id);
  assert.equal(steer.text, "换个方向");

  const steerByShort = parseIntent("/插 bbbbbb 换个方向", { tasks });
  assert.equal(steerByShort.targetTaskId, tasks[1].id);

  const steerBadIndex = parseIntent("/插 9 换个方向", { tasks });
  assert.equal(steerBadIndex.invalidIndex, true);

  const side = parseIntent("/问 这个仓库怎么构建", { tasks });
  assert.equal(side.kind, "side");
  assert.equal(side.targetTaskId, null);
  assert.equal(side.text, "这个仓库怎么构建");

  const sideTarget = parseIntent("/问 2 这个仓库怎么构建", { tasks });
  assert.equal(sideTarget.targetTaskId, tasks[1].id);
  assert.equal(sideTarget.text, "这个仓库怎么构建");

  const sideNumericQuestion = parseIntent("/问 9 个 CPU 够用吗", { tasks });
  assert.equal(sideNumericQuestion.targetTaskId, null, "编号解不出来就整句当问题");
  assert.equal(sideNumericQuestion.text, "9 个 CPU 够用吗");

  assert.equal(parseIntent("/任务", { tasks }).kind, "list");
  assert.equal(parseIntent("/看 1", { tasks }).targetTaskId, tasks[0].id);
  assert.equal(parseIntent("/停", { tasks }).kind, "stop");
  assert.equal(parseIntent("/重派 2", { tasks }).targetTaskId, tasks[1].id);
  assert.equal(parseIntent("/处理 2", { tasks }).kind, "ack");
  assert.equal(parseIntent("/状态", { tasks }).kind, "status");
  assert.equal(parseIntent("/换 Codex 一号", { tasks }).workerName, "Codex 一号");
  assert.equal(parseIntent("/清空", { tasks }).kind, "clear");
  assert.equal(parseIntent("/绑定 123456", { tasks }).text, "123456");
  assert.equal(parseIntent("/帮", { tasks }).kind, "help");

  const unknown = parseIntent("/啦啦啦", { tasks });
  assert.equal(unknown.kind, "unknown");
  assert.match(unknown.hint, /\/帮/);

  // 英文别名
  assert.equal(parseIntent("/list", { tasks }).kind, "list");
  assert.equal(parseIntent("/status", { tasks }).kind, "status");
});

function makeFakeHub(options = {}) {
  const calls = { dispatch: [], steer: [], side: [], stop: [], retry: [], ack: [], detail: [] };
  const workers = options.workers || [{ id: "claude-1", name: "Claude 一号", enabled: true }];
  const taskId = options.taskId || "task_20260101000000_ab12cd";
  const details = options.details || {};
  const hub = {
    calls,
    workers,
    details,
    listWorkers: () => hub.workers,
    dispatch(input) {
      calls.dispatch.push(input);
      if (options.dispatchError) throw options.dispatchError;
      return { id: taskId, workerId: input.workerId || workers[0].id, title: "整理 README", status: "queued", role: "main" };
    },
    steerTask(id, text, opts) {
      calls.steer.push({ id, text, opts });
      if (options.steerError) throw options.steerError;
      return { delivered: "steer", task: { id, title: "整理 README" }, warning: options.steerWarning || null };
    },
    askSide(input) {
      calls.side.push(input);
      if (options.sideError) throw options.sideError;
      return {
        task: { id: "task_20260101000001_side01", status: "queued", role: "side" },
        note: options.sideNote || null,
      };
    },
    stopTask(id) {
      calls.stop.push(id);
      return { id, status: "cancelling" };
    },
    retryTask(id) {
      calls.retry.push(id);
      return { id, status: "queued" };
    },
    acknowledgeTask(id) {
      calls.ack.push(id);
      return { id, acknowledgedAt: new Date().toISOString() };
    },
    taskDetail(id) {
      calls.detail.push(id);
      return details[id] || null;
    },
  };
  return hub;
}

function makeRouter(options = {}) {
  const directory = tempDir("agent-hub-router-");
  const dataDir = join(directory, "data");
  const store = new TaskStore(dataDir).init();
  const configStore = new ChannelConfigStore(join(dataDir, "channels.json")).load();
  const hub = options.hub || makeFakeHub(options.hubOptions || {});
  const sent = [];
  const router = new MessageRouter({
    configStore,
    hub,
    store,
    logger: { warn() {}, error() {}, log() {} },
    // 单测里不等 600ms 合并窗口（合并本身在 telegram.test 里单独验）
    mergeWindowMs: 0,
    send: async (channelId, chatId, text) => {
      sent.push({ channelId, chatId, text });
    },
    resolveChannel: (id) => (id === "telegram" ? { label: "Telegram" } : null),
  });
  return {
    router,
    configStore,
    store,
    hub,
    sent,
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
    texts: () => sent.map((item) => item.text),
  };
}

function seedTask(store, { status = "queued", workerId = "claude-1", title = "整理 README" } = {}) {
  const task = store.createTask({
    workerId,
    kind: "claude-cli",
    title,
    prompt: title,
    cwd: process.cwd(),
  });
  if (status !== "queued") store.updateTask(task.id, { status, startedAt: new Date().toISOString() });
  return store.getTask(task.id);
}

test("未绑定会话：固定话术、不派活、不产生任务", async () => {
  const ctx = makeRouter();
  try {
    await ctx.router.handle({ channelId: "telegram", chatId: "tg:9", text: "/派 整理 README" });
    assert.equal(ctx.hub.calls.dispatch.length, 0);
    assert.equal(ctx.configStore.deliveriesForChat("tg:9").length, 0);
    assert.match(ctx.texts()[0], /还没绑定/);
    assert.match(ctx.texts()[0], /\/绑定 123456/);

    // 未绑定也能用 /帮
    await ctx.router.handle({ channelId: "telegram", chatId: "tg:9", text: "/帮" });
    assert.match(ctx.texts()[1], /\/派/);
    assert.equal(ctx.hub.calls.dispatch.length, 0);
  } finally {
    ctx.cleanup();
  }
});

test("绑定：配对码正确才生效，且用后即焚", async () => {
  const ctx = makeRouter();
  try {
    await ctx.router.handle({ channelId: "telegram", chatId: "tg:1", text: "/绑定 111111" });
    assert.match(ctx.texts().at(-1), /配对码不对|过期/);

    const pair = ctx.configStore.createPairCode("telegram");
    await ctx.router.handle({ channelId: "telegram", chatId: "tg:1", text: `/绑定 ${pair.code}` });
    assert.match(ctx.texts().at(-1), /绑定成功/);
    assert.ok(ctx.configStore.findBinding("tg:1"));
    assert.equal(ctx.configStore.pairCodeFor("telegram"), null, "用后即焚");

    // 同一个码不能再用
    await ctx.router.handle({ channelId: "telegram", chatId: "tg:2", text: `/绑定 ${pair.code}` });
    assert.match(ctx.texts().at(-1), /配对码不对|过期/);
    assert.equal(ctx.configStore.findBinding("tg:2"), null);
  } finally {
    ctx.cleanup();
  }
});

test("派活：回执在任务结束前就发出，并记下投递", async () => {
  const ctx = makeRouter();
  try {
    ctx.configStore.upsertBinding("telegram", { chatId: "tg:1", workerId: "claude-1" });
    await ctx.router.handle({ channelId: "telegram", chatId: "tg:1", text: "/派 整理 README" });

    assert.equal(ctx.hub.calls.dispatch.length, 1);
    assert.equal(ctx.hub.calls.dispatch[0].workerId, "claude-1");
    assert.equal(ctx.hub.calls.dispatch[0].prompt, "整理 README");
    const receipt = ctx.texts().at(-1);
    assert.match(receipt, /收到/);
    assert.match(receipt, /ab12cd/);
    assert.match(receipt, /Claude 一号/);

    const deliveries = ctx.configStore.deliveriesForChat("tg:1");
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].kind, "main");
    assert.equal(deliveries[0].lastNotifiedStatus, "queued");
  } finally {
    ctx.cleanup();
  }
});

test("无前缀文本：没 running 就派活，一个 running 就插话，多个 running 不猜", async () => {
  const ctx = makeRouter();
  try {
    ctx.configStore.upsertBinding("telegram", { chatId: "tg:1", workerId: "claude-1" });

    // 没 running → 派活
    await ctx.router.handle({ channelId: "telegram", chatId: "tg:1", text: "整理 README" });
    assert.equal(ctx.hub.calls.dispatch.length, 1);

    // 一个 running → 插话
    const running = seedTask(ctx.store, { status: "running", title: "在跑的任务 A" });
    ctx.configStore.addDelivery({ taskId: running.id, channelId: "telegram", chatId: "tg:1" });
    await ctx.router.handle({ channelId: "telegram", chatId: "tg:1", text: "顺手把图也换掉" });
    assert.equal(ctx.hub.calls.steer.length, 1);
    assert.equal(ctx.hub.calls.steer[0].id, running.id);
    assert.equal(ctx.hub.calls.steer[0].text, "顺手把图也换掉");
    assert.equal(ctx.hub.calls.dispatch.length, 1, "插话不应另外派活");

    // 两个 running → 不猜，也不派活
    const second = seedTask(ctx.store, { status: "running", title: "在跑的任务 B", workerId: "codex-1" });
    ctx.configStore.addDelivery({ taskId: second.id, channelId: "telegram", chatId: "tg:1" });
    await ctx.router.handle({ channelId: "telegram", chatId: "tg:1", text: "两条都要改" });
    assert.equal(ctx.hub.calls.steer.length, 1, "多个 running 时不能瞎插");
    assert.equal(ctx.hub.calls.dispatch.length, 1);
    assert.match(ctx.texts().at(-1), /有 \d 个任务在跑|现在有 2 个任务在跑/);
    assert.match(ctx.texts().at(-1), /\/插/);
  } finally {
    ctx.cleanup();
  }
});

test("插话不支持时自动降级侧问，并把降级原因说明白", async () => {
  const unsupported = new Error("Codex 不支持插话");
  unsupported.code = "STEER_UNSUPPORTED";
  const ctx = makeRouter({ hubOptions: { steerError: unsupported } });
  try {
    ctx.configStore.upsertBinding("telegram", { chatId: "tg:1", workerId: "codex-1" });
    const running = seedTask(ctx.store, { status: "running", workerId: "codex-1", title: "在跑的 Codex 任务" });
    ctx.configStore.addDelivery({ taskId: running.id, channelId: "telegram", chatId: "tg:1" });

    await ctx.router.handle({ channelId: "telegram", chatId: "tg:1", text: "/插 1 换个方向" });

    assert.equal(ctx.hub.calls.side.length, 1);
    assert.equal(ctx.hub.calls.side[0].parentTaskId, running.id);
    assert.equal(ctx.hub.calls.side[0].question, "换个方向");
    const reply = ctx.texts().at(-1);
    assert.match(reply, /不支持插话/);
    assert.match(reply, /侧问/);
    assert.match(reply, /答好推给你/);
    // 侧问也要记投递，否则答案推不回来
    const deliveries = ctx.configStore.deliveriesFor("task_20260101000001_side01");
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].kind, "side");
  } finally {
    ctx.cleanup();
  }
});

test("插话失败必须带中文原因，不静默", async () => {
  const notRunning = new Error("任务已经停下了，用 /重派 再来一次");
  notRunning.code = "STEER_NOT_RUNNING";
  const ctx = makeRouter({ hubOptions: { steerError: notRunning } });
  try {
    ctx.configStore.upsertBinding("telegram", { chatId: "tg:1", workerId: "claude-1" });
    const done = seedTask(ctx.store, { status: "running", title: "刚停下的任务" });
    ctx.configStore.addDelivery({ taskId: done.id, channelId: "telegram", chatId: "tg:1" });

    await ctx.router.handle({ channelId: "telegram", chatId: "tg:1", text: "/插 1 再改一下" });
    const reply = ctx.texts().at(-1);
    assert.match(reply, /任务已经停下了/);
    assert.match(reply, /任务现在不在跑/);
    assert.equal(ctx.hub.calls.side.length, 0, "状态不对时不该自动侧问");
  } finally {
    ctx.cleanup();
  }
});

test("预算警告会原样转述给用户", async () => {
  const ctx = makeRouter({ hubOptions: { steerWarning: "已用 $3.2 / 上限 $4.0，插话会继续消耗，到顶就停" } });
  try {
    ctx.configStore.upsertBinding("telegram", { chatId: "tg:1", workerId: "claude-1" });
    const running = seedTask(ctx.store, { status: "running" });
    ctx.configStore.addDelivery({ taskId: running.id, channelId: "telegram", chatId: "tg:1" });

    await ctx.router.handle({ channelId: "telegram", chatId: "tg:1", text: "/插 1 再加一句" });
    assert.match(ctx.texts().at(-1), /已用 \$3\.2/);
  } finally {
    ctx.cleanup();
  }
});

test("任务事件：running 不推、终态推一次、侧问答案单独推", async () => {
  const ctx = makeRouter({
    hubOptions: {
      details: {
        task_20260101000001_side01: {
          id: "task_20260101000001_side01",
          title: "侧问 · 构建命令是什么",
          status: "completed",
          result: "npm run build",
          role: "side",
        },
      },
    },
  });
  try {
    ctx.configStore.upsertBinding("telegram", { chatId: "tg:1", workerId: "claude-1" });
    const task = seedTask(ctx.store, { status: "running" });
    ctx.hub.details[task.id] = {
      id: task.id,
      title: "整理 README",
      status: "completed",
      result: "都改好了，产物在 docs/result.md",
      role: "main",
    };
    ctx.configStore.addDelivery({
      taskId: task.id,
      channelId: "telegram",
      chatId: "tg:1",
      lastNotifiedStatus: "queued",
    });

    await ctx.router.onTaskEvent({ type: "task", taskId: task.id, status: "running", stage: "running", role: "main", title: "整理 README" });
    assert.equal(ctx.sent.length, 0, "running 期间不该刷屏");

    await ctx.router.onTaskEvent({ type: "task", taskId: task.id, status: "completed", stage: "done", role: "main", title: "整理 README" });
    assert.equal(ctx.sent.length, 1);
    assert.match(ctx.texts()[0], /跑完了/);
    assert.match(ctx.texts()[0], /docs\/result\.md/);

    // 重复事件不重复推
    await ctx.router.onTaskEvent({ type: "task", taskId: task.id, status: "completed", stage: "done", role: "main", title: "整理 README" });
    assert.equal(ctx.sent.length, 1);

    // 侧问答案
    ctx.configStore.addDelivery({
      taskId: "task_20260101000001_side01",
      channelId: "telegram",
      chatId: "tg:1",
      kind: "side",
    });
    await ctx.router.onTaskEvent({
      type: "task",
      taskId: "task_20260101000001_side01",
      status: "completed",
      stage: "done",
      role: "side",
      title: "侧问 · 构建命令是什么",
    });
    assert.equal(ctx.sent.length, 2);
    assert.match(ctx.texts()[1], /侧问答案/);
    assert.match(ctx.texts()[1], /npm run build/);
  } finally {
    ctx.cleanup();
  }
});

test("状态类命令：/任务 编号稳定，/换 校验员工，/清空 是开关", async () => {
  const ctx = makeRouter();
  try {
    ctx.configStore.upsertBinding("telegram", { chatId: "tg:1", workerId: "claude-1" });
    const first = seedTask(ctx.store, { status: "completed", title: "第一个任务" });
    ctx.configStore.addDelivery({ taskId: first.id, channelId: "telegram", chatId: "tg:1" });

    await ctx.router.handle({ channelId: "telegram", chatId: "tg:1", text: "/任务" });
    assert.match(ctx.texts().at(-1), /1\. 第一个任务/);
    assert.deepEqual(ctx.configStore.getLastList("tg:1"), [first.id]);

    await ctx.router.handle({ channelId: "telegram", chatId: "tg:1", text: "/看 1" });
    assert.match(ctx.texts().at(-1), /第一个任务/);

    await ctx.router.handle({ channelId: "telegram", chatId: "tg:1", text: "/换 不存在的员工" });
    assert.match(ctx.texts().at(-1), /没有叫/);

    await ctx.router.handle({ channelId: "telegram", chatId: "tg:1", text: "/换 Claude 一号" });
    assert.match(ctx.texts().at(-1), /以后这个会话派给/);
    assert.equal(ctx.configStore.findBinding("tg:1").entry.workerId, "claude-1");

    await ctx.router.handle({ channelId: "telegram", chatId: "tg:1", text: "/清空" });
    assert.equal(ctx.configStore.findBinding("tg:1").entry.newSession, true);
    await ctx.router.handle({ channelId: "telegram", chatId: "tg:1", text: "/清空" });
    assert.equal(ctx.configStore.findBinding("tg:1").entry.newSession, false);

    await ctx.router.handle({ channelId: "telegram", chatId: "tg:1", text: "/状态" });
    assert.match(ctx.texts().at(-1), /在跑/);
  } finally {
    ctx.cleanup();
  }
});

test("退避是 1s 起、指数增长、封顶 60s", () => {
  assert.equal(backoffMs(1), 1000);
  assert.equal(backoffMs(2), 2000);
  assert.equal(backoffMs(3), 4000);
  assert.equal(backoffMs(20), 60_000);
  assert.equal(backoffMs(99), 60_000);
});

async function startChannelHub(context) {
  await new Promise((resolvePromise, reject) => {
    context.server.once("error", reject);
    context.server.listen(0, "127.0.0.1", resolvePromise);
  });
  return `http://127.0.0.1:${context.server.address().port}`;
}

test("通道接口：4 个通道、secret 恒掩码、掩码回传不覆盖、配对码与白名单落盘", async () => {
  const directory = tempDir("agent-hub-channel-http-");
  const config = {
    port: 0,
    dataDir: join(directory, "data"),
    workers: {
      "claude-1": {
        name: "Claude 一号",
        kind: "claude-cli",
        command: process.execPath,
        argsPrefix: ["-e", ""],
        cwd: process.cwd(),
        permissionMode: "acceptEdits",
      },
    },
  };
  const context = await createHubServer({ config, logger: { warn() {}, error() {}, log() {} } });
  const base = await startChannelHub(context);
  const call = (path, { method = "GET", body } = {}) => fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (response) => ({ status: response.status, body: await response.json() }));

  try {
    const list = await call("/api/channels");
    assert.equal(list.status, 200);
    assert.equal(list.body.channels.length, 4);
    assert.deepEqual(list.body.channels.map((item) => item.id), CHANNEL_IDS);
    const telegram = list.body.channels.find((item) => item.id === "telegram");
    assert.equal(telegram.config.token, "");
    assert.ok(Array.isArray(telegram.fields));
    assert.ok(telegram.fields.some((field) => field.key === "token"));
    // 面板按 status 取状态，同时保留平铺字段（告警日志用）
    assert.equal(typeof telegram.status.state, "string");
    assert.equal(telegram.status.state, telegram.state);
    assert.ok(Array.isArray(telegram.chats));
    assert.equal(typeof telegram.pairCode, "object");
    const wecom = list.body.channels.find((item) => item.id === "wecom");
    assert.equal(wecom.implemented, false);
    assert.equal(wecom.readiness, "needs-public");
    const wechat = list.body.channels.find((item) => item.id === "wechat");
    assert.equal(wechat.readiness, "unsupported");

    // 改 token：响应恒掩码
    const saved = await call("/api/channels/telegram", { method: "PUT", body: { token: TOKEN } });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.channel.config.token, "****Ijkl");
    assert.equal(saved.body.channel.config.token.includes("ABCdef"), false);

    // 回传掩码 → 原值不能丢
    await call("/api/channels/telegram", { method: "PUT", body: { token: "****Ijkl", apiBase: "https://api.telegram.org" } });
    const onDisk = new ChannelConfigStore(join(config.dataDir, "channels.json")).load();
    assert.equal(onDisk.get("telegram").token, TOKEN);

    // 显式清空
    await call("/api/channels/telegram", { method: "PUT", body: { token: "", clearToken: true } });
    assert.equal(new ChannelConfigStore(join(config.dataDir, "channels.json")).load().get("telegram").token, "");

    // 配对码
    const pair = await call("/api/channels/wecom/pair", { method: "POST", body: {} });
    assert.equal(pair.status, 200);
    assert.match(pair.body.code, /^\d{6}$/);
    assert.ok(pair.body.ttlMs >= 60_000);
    assert.equal(pair.body.pairCode.code, pair.body.code, "嵌套与平铺两种形状都要有");

    // 白名单：绑定 → 落盘 → 解绑
    const bound = await call("/api/channels/telegram/allowlist", {
      method: "POST",
      body: { chatId: "tg:837465123", chatType: "p2p", chatTitle: "阿德", workerId: "claude-1" },
    });
    assert.equal(bound.status, 200);
    assert.equal(bound.body.allowlist.length, 1);
    const reopened = new ChannelConfigStore(join(config.dataDir, "channels.json")).load();
    assert.equal(reopened.findBinding("tg:837465123").entry.chatTitle, "阿德");

    const removed = await call(`/api/channels/telegram/allowlist/${encodeURIComponent("tg:837465123")}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.allowlist.length, 0);

    const missing = await call(`/api/channels/telegram/allowlist/${encodeURIComponent("tg:none")}`, { method: "DELETE" });
    assert.equal(missing.status, 404);

    // 占位通道：不能启用、测试连接给出原因
    const tested = await call("/api/channels/wecom/test", { method: "POST", body: {} });
    assert.equal(tested.status, 200);
    assert.equal(tested.body.ok, false);
    assert.match(tested.body.message, /公网回调/);
    assert.match(tested.body.error, /公网回调/, "失败时 error 与 message 同值，面板直接用 error");
    assert.equal(typeof tested.body.status.state, "string");

    const chats = await call("/api/channels/wecom/chats");
    assert.equal(chats.status, 200);
    assert.deepEqual(chats.body.chats, []);

    const unknown = await call("/api/channels/nope");
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error, /没有这个通道/);

    // 坏配置要报错，且不产生半截写入
    const badAllow = await call("/api/channels/telegram/allowlist", { method: "POST", body: { chatTitle: "没有 chatId" } });
    assert.equal(badAllow.status, 400);
  } finally {
    await context.channelManager.stopAll();
    await context.hub.stopAll();
    await new Promise((resolvePromise) => context.server.close(resolvePromise));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("通道路径插话打到真 Hub：async 写 stdin、steers 落盘、回执带结果", async () => {
  const directory = tempDir("agent-hub-router-real-");
  const dataDir = join(directory, "data");
  const store = new TaskStore(dataDir).init();
  const configStore = new ChannelConfigStore(join(dataDir, "channels.json")).load();
  const streamStub = fileURLToPath(new URL("./fake-claude-stream.mjs", import.meta.url));
  const hub = new AgentHub({
    store,
    steerWatchdogMs: 0,
    workers: {
      "claude-1": {
        name: "Claude 一号",
        kind: "claude-cli",
        command: process.execPath,
        argsPrefix: [streamStub],
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        permissionMode: "acceptEdits",
        streamInput: true,
        steerIdleMs: 400,
      },
    },
  });
  const sent = [];
  const router = new MessageRouter({
    configStore,
    hub,
    store,
    logger: { warn() {}, error() {}, log() {} },
    mergeWindowMs: 0,
    send: async (channelId, chatId, text) => { sent.push(text); },
    resolveChannel: () => ({ label: "Telegram" }),
  });

  const waitUntil = async (predicate, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = predicate();
      if (value) return value;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    throw new Error("等待条件超时");
  };

  try {
    configStore.upsertBinding("telegram", { chatId: "tg:1", workerId: "claude-1" });
    const task = hub.dispatch({ prompt: "第一个任务：通道路径插话" });
    await waitUntil(() => hub.steerables.has(task.id));
    configStore.addDelivery({ taskId: task.id, channelId: "telegram", chatId: "tg:1" });

    // 无前缀 + 唯一 running → 插话（走真 hub，会真的写 stdin）
    await router.handle({ channelId: "telegram", chatId: "tg:1", text: "顺手把图也换掉" });
    assert.ok(sent.some((item) => item.includes("已插话")), "必须回执，不能静默");

    const running = store.getTask(task.id);
    assert.equal(running.steers.length, 1);
    assert.equal(running.steers[0].text, "顺手把图也换掉");
    assert.equal(running.steers[0].source, "telegram");
    assert.equal(running.steers[0].actor.chatId, "tg:1");

    const done = await hub.waitTask(task.id, 15);
    assert.equal(done.status, "completed");
    assert.match(done.result, /TURN 2/);
    assert.equal(done.attempts, 1);
  } finally {
    await hub.stopAll();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("subscribe 只在 status/stage 变化时回调", () => {
  const directory = tempDir("agent-hub-subscribe-");
  try {
    const store = new TaskStore(join(directory, "data")).init();
    const events = [];
    const off = store.subscribe((event) => events.push(event));
    const task = store.createTask({
      workerId: "claude-1",
      kind: "claude-cli",
      title: "订阅测试",
      prompt: "订阅测试",
      cwd: process.cwd(),
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].status, "queued");
    assert.equal(events[0].role, "main");

    store.addProgress(task.id, "只是一条进度", "progress");
    assert.equal(events.length, 1, "进度更新不该重复推事件");

    store.updateTask(task.id, { status: "running" });
    assert.equal(events.length, 2);
    assert.equal(events[1].status, "running");

    off();
    store.updateTask(task.id, { status: "completed" });
    assert.equal(events.length, 2, "取消订阅后不再回调");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// ── TG 里选员工（0.8.0）──────────────────────────────────────────────────

const FOUR_WORKERS = [
  { id: "claude-main", name: "Claude 主员工", note: "总经理", cwd: "C:\\work\\main", enabled: true, available: true },
  { id: "codex-main", name: "Codex 员工", note: "审核", cwd: "C:\\work\\main", enabled: true, available: true },
  { id: "claude-2", name: "抖音下载开发", note: "抖音下载插件开发", cwd: "E:\\workPM\\抖音下载开发", enabled: true, available: true },
  { id: "claude-1", name: "便签重构员", note: "", cwd: "C:\\work\\scratchpad", enabled: true, available: true },
];

test("选员工：只有 @ 才认作点名，裸数字仍是正文；/员工 是新命令", () => {
  const byIndex = parseIntent("/派 @3 整理 README", { tasks: [] });
  assert.equal(byIndex.kind, "dispatch");
  assert.equal(byIndex.workerSelector, "3");
  assert.equal(byIndex.text, "整理 README");

  const byName = parseIntent("/派 @抖音 下载封面", { tasks: [] });
  assert.equal(byName.workerSelector, "抖音");
  assert.equal(byName.text, "下载封面");

  const plain = parseIntent("/派 2 个文件里的错字", { tasks: [] });
  assert.equal(plain.workerSelector, undefined, "裸数字绝不能被吞掉");
  assert.equal(plain.text, "2 个文件里的错字");

  const onlySelector = parseIntent("/派 @2", { tasks: [] });
  assert.equal(onlySelector.workerSelector, "2");
  assert.equal(onlySelector.text, "");

  assert.equal(parseIntent("/员工", {}).kind, "workers");
  assert.equal(parseIntent("/员工列表", {}).kind, "workers");
  assert.equal(parseIntent("/workers", {}).kind, "workers");
});

test("选员工：/员工 列编号、职责、目录，★ 标当前默认", async () => {
  const ctx = makeRouter({ hubOptions: { workers: FOUR_WORKERS } });
  try {
    ctx.configStore.upsertBinding("telegram", { chatId: "tg:1", workerId: "claude-main" });
    await ctx.router.handle({ channelId: "telegram", chatId: "tg:1", text: "/员工" });
    const reply = ctx.texts().at(-1);
    assert.match(reply, /现在有 4 个员工/);
    assert.match(reply, /★ 1\. Claude 主员工/);
    assert.match(reply, /3\. 抖音下载开发/);
    assert.match(reply, /总经理/);
    assert.match(reply, /E:\\workPM/);
    assert.match(reply, /\/派 @3/);
    assert.match(reply, /\/换 3/);
  } finally {
    ctx.cleanup();
  }
});

test("选员工：/派 @3 临时点名，不改默认、不沿用会话目录", async () => {
  const ctx = makeRouter({ hubOptions: { workers: FOUR_WORKERS } });
  try {
    ctx.configStore.upsertBinding("telegram", {
      chatId: "tg:1", workerId: "claude-main", cwd: "C:\\work\\main",
    });
    await ctx.router.handle({ channelId: "telegram", chatId: "tg:1", text: "/派 @3 整理素材" });
    assert.equal(ctx.hub.calls.dispatch.length, 1);
    assert.equal(ctx.hub.calls.dispatch[0].workerId, "claude-2");
    assert.equal(ctx.hub.calls.dispatch[0].cwd, undefined, "临时点名不能带上默认员工的目录");
    assert.equal(ctx.configStore.findBinding("tg:1").entry.workerId, "claude-main", "默认不能被改掉");
    const reply = ctx.texts().at(-1);
    assert.match(reply, /抖音下载开发/);
    assert.match(reply, /临时指定/);
    assert.match(reply, /默认还是/);
  } finally {
    ctx.cleanup();
  }
});

test("选员工：@名字 / @职责 模糊匹配；点错编号和空任务都不产生任务", async () => {
  const ctx = makeRouter({ hubOptions: { workers: FOUR_WORKERS } });
  try {
    ctx.configStore.upsertBinding("telegram", { chatId: "tg:1", workerId: "claude-main" });

    await ctx.router.handle({ channelId: "telegram", chatId: "tg:1", text: "/派 @便签 重构列表" });
    assert.equal(ctx.hub.calls.dispatch[0].workerId, "claude-1");
    assert.equal(ctx.hub.calls.dispatch[0].cwd, undefined);

    await ctx.router.handle({ channelId: "telegram", chatId: "tg:1", text: "/派 @审核 检查一遍" });
    assert.equal(ctx.hub.calls.dispatch[1].workerId, "codex-main", "职责备注也要能点名");
    const goodCount = ctx.hub.calls.dispatch.length;

    await ctx.router.handle({ channelId: "telegram", chatId: "tg:1", text: "/派 @99 干活" });
    assert.equal(ctx.hub.calls.dispatch.length, goodCount, "编号不存在不能派给默认员工");
    assert.match(ctx.texts().at(-1), /没找到/);
    assert.match(ctx.texts().at(-1), /\/员工/);

    await ctx.router.handle({ channelId: "telegram", chatId: "tg:1", text: "/派 @2" });
    assert.equal(ctx.hub.calls.dispatch.length, goodCount, "只点名没内容不能派活");
    assert.match(ctx.texts().at(-1), /还没写要干什么/);
  } finally {
    ctx.cleanup();
  }
});

test("选员工：/换 3 改默认，工作目录跟着员工走，不串项目", async () => {
  const ctx = makeRouter({ hubOptions: { workers: FOUR_WORKERS } });
  try {
    ctx.configStore.upsertBinding("telegram", {
      chatId: "tg:1", workerId: "claude-main", cwd: "C:\\work\\main",
    });
    await ctx.router.handle({ channelId: "telegram", chatId: "tg:1", text: "/换 3" });
    const entry = ctx.configStore.findBinding("tg:1").entry;
    assert.equal(entry.workerId, "claude-2");
    assert.equal(entry.cwd, "E:\\workPM\\抖音下载开发", "不能沿用上一个员工的目录");
    assert.match(ctx.texts().at(-1), /以后这个会话派给/);
    assert.match(ctx.texts().at(-1), /工作目录已跟着改/);

    // 换完之后不带 @ 派活，就该用 3 号自己的目录。
    await ctx.router.handle({ channelId: "telegram", chatId: "tg:1", text: "/派 继续整理" });
    assert.equal(ctx.hub.calls.dispatch[0].workerId, "claude-2");
    assert.equal(ctx.hub.calls.dispatch[0].cwd, "E:\\workPM\\抖音下载开发");
    assert.doesNotMatch(ctx.texts().at(-1), /临时指定/, "不带 @ 就不该说是临时指定");
  } finally {
    ctx.cleanup();
  }
});
