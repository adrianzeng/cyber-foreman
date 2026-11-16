import test from "node:test";
import assert from "node:assert/strict";
import {
  DEDUPE_TTL_MS,
  MessageDedupe,
  extractText,
  isMentionMe,
  stripMentionPlaceholders,
  toInbound,
} from "../src/channels/feishu-normalize.mjs";
import { FeishuChannel } from "../src/channels/feishu.mjs";

const APP_SECRET = "s3cr3t-abcdef123456";

function payload(overrides = {}) {
  return {
    sender: {
      sender_id: { open_id: "ou_user_1", user_id: "on_user_1" },
      sender_type: "user",
      ...(overrides.sender || {}),
    },
    message: {
      message_id: "om_1001",
      chat_id: "oc_chat_1",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "整理 README" }),
      create_time: "1700000000000",
      ...(overrides.message || {}),
    },
  };
}

test("飞书归一化：私聊文本 → InboundMessage", () => {
  const inbound = toInbound(payload());
  assert.equal(inbound.channelId, "feishu");
  assert.equal(inbound.chatId, "fs:oc_chat_1");
  assert.equal(inbound.chatType, "p2p");
  assert.equal(inbound.text, "整理 README");
  assert.equal(inbound.senderId, "on_user_1");
  assert.equal(inbound.messageId, "fs:om_1001");
  assert.equal(inbound.mentionsMe, true, "私聊天然是在跟我说话");
  assert.equal(inbound.receivedAt, new Date(1_700_000_000_000).toISOString());
});

test("飞书归一化：群里没 @我 就不进 Router，@了就去掉占位符", () => {
  const silent = toInbound(payload({ message: { chat_type: "group", content: JSON.stringify({ text: "大家好" }) } }));
  assert.equal(silent, null);

  const mentioned = toInbound(payload({
    message: {
      chat_type: "group",
      content: JSON.stringify({ text: "@_user_1 /派 整理 README" }),
      mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "DSH 机器人" }],
    },
  }));
  assert.equal(mentioned.chatType, "group");
  assert.equal(mentioned.mentionsMe, true);
  assert.equal(mentioned.text, "/派 整理 README", "占位符必须去掉，否则命令解析会失败");

  // 能拿到 bot open_id 时精确比对：@ 的是别人就不该响应
  const other = payload({
    message: {
      chat_type: "group",
      content: JSON.stringify({ text: "@_user_1 你好" }),
      mentions: [{ key: "@_user_1", id: { open_id: "ou_someone_else" } }],
    },
  });
  assert.equal(isMentionMe(other, { botOpenId: "ou_bot" }), false);
  assert.equal(toInbound(other, { botOpenId: "ou_bot" }), null);
});

test("飞书归一化：机器人自己发的、缺字段的、非文本的都要处理对", () => {
  assert.equal(toInbound(payload({ sender: { sender_type: "app" } })), null, "别自问自答");
  assert.equal(toInbound({ message: {} }), null);
  assert.equal(toInbound(null), null);

  const image = toInbound(payload({ message: { message_type: "image", content: JSON.stringify({ image_key: "img_1" }) } }));
  assert.equal(image.text, "", "非文本消息 text 为空，由通道决定怎么提示");
  assert.equal(extractText({ message_type: "text", content: "{ bad json" }), "");
  assert.equal(extractText({ message_type: "text", content: JSON.stringify({ text: "hi" }) }), "hi");
});

test("飞书归一化：富文本（post）也能取到文字", () => {
  const post = JSON.stringify({
    title: "周报",
    content: [
      [{ tag: "text", text: "第一段" }, { tag: "text", text: "（续）" }],
      [{ tag: "text", text: "第二段" }],
    ],
  });
  assert.equal(extractText({ message_type: "post", content: post }), "第一段（续）\n第二段");
  const inbound = toInbound(payload({ message: { message_type: "post", content: post } }));
  assert.match(inbound.text, /第一段/);
});

test("去重：30 分钟内同 message_id 只算一次，过期后重新放行", () => {
  let now = 1_700_000_000_000;
  const dedupe = new MessageDedupe({ now: () => now });
  assert.equal(dedupe.seen("om_1"), false);
  assert.equal(dedupe.seen("om_1"), true, "重连补发要拦住");
  assert.equal(dedupe.seen("om_2"), false);

  now += DEDUPE_TTL_MS + 1;
  assert.equal(dedupe.seen("om_1"), false, "超过 30 分钟应重新放行");
  assert.equal(dedupe.size >= 1, true);

  dedupe.clear();
  assert.equal(dedupe.size, 0);
  assert.equal(dedupe.seen(""), false, "空 id 不算见过");
});

test("占位符清理：多余空格也顺手压掉", () => {
  assert.equal(stripMentionPlaceholders("@_user_1  @_user_2   /派  整理", []), "/派 整理");
  assert.equal(stripMentionPlaceholders("hi", [{ key: "@_user_9" }]), "hi");
});

/** 一个够用的假 SDK：只实现我们真正调用的那几个方法。 */
function makeFakeSdk(options = {}) {
  const calls = { logs: [], sent: [], dispatchers: [], shutdowns: 0 };
  class FakeDispatcher {
    constructor(params) {
      this.params = params;
      this.handlers = {};
      calls.dispatchers.push(this);
    }

    register(map) {
      Object.assign(this.handlers, map);
    }
  }
  class FakeWsClient {
    constructor(params) {
      this.params = params;
    }

    async start() {
      // 模拟 SDK 自己打日志（真实 SDK 会把 appId/appSecret 打进去）
      this.params.logger.error("handshake failed", { app_secret: options.secret || APP_SECRET });
      if (options.startError) throw options.startError;
    }

    close() {
      calls.shutdowns += 1;
    }
  }
  class FakeClient {
    constructor(params) {
      this.params = params;
      this.im = {
        message: {
          create: async (request) => {
            calls.sent.push(request);
            if (options.sendError) throw options.sendError;
            return { code: 0 };
          },
        },
      };
    }
  }
  return {
    calls,
    sdk: {
      WSClient: FakeWsClient,
      EventDispatcher: FakeDispatcher,
      Client: FakeClient,
      LoggerLevel: { debug: 0, info: 1, warn: 2, error: 3 },
    },
  };
}

test("飞书通道：SDK 没装时只降级自己，并给出「需要先 npm install」", async () => {
  const channel = new FeishuChannel({
    sdkLoader: async () => {
      throw new Error("Cannot find module '@larksuiteoapi/node-sdk'");
    },
  });
  // 探测是异步的，等它落定
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

  assert.equal(channel.status().ready, false);
  assert.match(channel.note, /需要先 npm install/);
  await assert.rejects(
    () => channel.start({ getConfig: () => ({ appId: "cli_x", appSecret: "y" }) }),
    /npm install/,
  );
  const tested = await channel.test({ appId: "cli_x", appSecret: "y" });
  assert.equal(tested.ok, false);
});

test("飞书通道：连上后事件能进来、重复 message_id 只进门一次、日志已脱敏", async () => {
  const fake = makeFakeSdk();
  const logs = [];
  const inbound = [];
  const channel = new FeishuChannel({ sdkLoader: async () => fake.sdk });
  const logger = { log: (line) => logs.push(line), warn: (line) => logs.push(line), error: () => {} };
  const config = { appId: "cli_test123", appSecret: APP_SECRET, domain: "open.feishu.cn" };

  const started = channel.start({
    getConfig: () => config,
    config,
    logger,
    onMessage: (msg) => inbound.push(msg),
    onConnected: () => {},
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));

  assert.equal(channel.status().me.id, "cli_test123");
  const dispatcher = fake.calls.dispatchers[0];
  const handler = dispatcher.handlers["im.message.receive_v1"];
  assert.equal(typeof handler, "function");

  handler(payload());
  handler(payload());
  assert.equal(inbound.length, 1, "同一条消息只能处理一次");
  assert.equal(inbound[0].text, "整理 README");

  // SDK 自己的日志里出现了 appSecret，必须被掩码
  assert.ok(logs.some((line) => line.includes("feishu/sdk")));
  assert.equal(logs.some((line) => line.includes(APP_SECRET)), false, "日志里不能出现 appSecret");

  await channel.stop();
  await started;
  assert.equal(fake.calls.shutdowns, 1, "stop 必须关掉 WS 连接");
});

test("飞书通道：发送走 SDK，chatId 前缀被去掉，超长分段", async () => {
  const fake = makeFakeSdk();
  const channel = new FeishuChannel({ sdkLoader: async () => fake.sdk, throttleMs: 0 });
  const config = { appId: "cli_test123", appSecret: APP_SECRET, domain: "open.feishu.cn" };

  const short = await channel.send("fs:oc_chat_1", "你好", { config });
  assert.equal(short.segments, 1);
  assert.equal(fake.calls.sent[0].data.receive_id, "oc_chat_1");
  assert.equal(fake.calls.sent[0].params.receive_id_type, "chat_id");
  assert.deepEqual(JSON.parse(fake.calls.sent[0].data.content), { text: "你好" });

  fake.calls.sent.length = 0;
  const long = Array.from({ length: 900 }, (_, index) => `第 ${index} 行：很长的一段文本。`).join("\n");
  const result = await channel.send("fs:oc_chat_1", long, { config });
  assert.equal(result.segments, 3);
  assert.match(fake.calls.sent[fake.calls.sent.length - 1].data.content, /完整内容去面板看/);
});

test("飞书通道：测试连接用 tenant token，错误翻译成中文且不含 appSecret", async () => {
  const okChannel = new FeishuChannel({
    sdkLoader: async () => makeFakeSdk().sdk,
    fetchImpl: async () => ({
      status: 200,
      json: async () => ({ code: 0, tenant_access_token: "t-123", expire: 7200 }),
    }),
  });
  const ok = await okChannel.test({ appId: "cli_a", appSecret: APP_SECRET });
  assert.equal(ok.ok, true);
  assert.match(ok.message, /tenant token/);
  assert.equal(ok.me.id, "cli_a");

  const badSecret = new FeishuChannel({
    sdkLoader: async () => makeFakeSdk().sdk,
    fetchImpl: async () => ({ status: 200, json: async () => ({ code: 10003, msg: "invalid app_secret" }) }),
  });
  const bad = await badSecret.test({ appId: "cli_a", appSecret: APP_SECRET });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /App Secret 不对/);
  assert.equal(bad.message.includes(APP_SECRET), false);

  const offline = new FeishuChannel({
    sdkLoader: async () => makeFakeSdk().sdk,
    fetchImpl: async () => {
      throw new Error("getaddrinfo ENOTFOUND open.feishu.cn");
    },
  });
  const down = await offline.test({ appId: "cli_a", appSecret: APP_SECRET });
  assert.equal(down.ok, false);
  assert.match(down.message, /连不上飞书/);
});

test("飞书通道：配置校验（域名白名单、App ID 形状）", () => {
  const channel = new FeishuChannel({ sdkLoader: async () => makeFakeSdk().sdk });
  assert.throws(
    () => channel.normalize({ appId: "cli_abc123", domain: "example.com" }, {}),
    /开放平台域名/,
  );
  assert.throws(
    () => channel.normalize({ appId: "not-an-app-id" }, {}),
    /cli_ 开头/,
  );
  const ok = channel.normalize({ appId: "cli_abc123", domain: "open.larksuite.com" }, {});
  assert.equal(ok.domain, "open.larksuite.com");
  assert.equal(ok.enabled, false);
});
