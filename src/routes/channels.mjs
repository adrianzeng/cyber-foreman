import { mergeMasked, scrub } from "../channels/secrets.mjs";

/**
 * 通道 HTTP 接口。
 *
 * 只有 8 个路由，所以不引任何 web 框架 —— server.mjs 的 if 链里加一行
 * `await maybeHandleChannels(ctx)` 就够，命中就 return true，没命中继续往下走。
 *
 * 所有出站错误都过 scrub()：Token 绝不能出现在响应或日志里。
 */

const CHANNEL_BASE = "/api/channels";
const SINGLE = /^\/api\/channels\/([A-Za-z0-9_-]+)$/;
const ACTION = /^\/api\/channels\/([A-Za-z0-9_-]+)\/(pair|test|chats)$/;
const ALLOWLIST = /^\/api\/channels\/([A-Za-z0-9_-]+)\/allowlist(?:\/(.+))?$/;

function fail(response, json, status, message, extra = {}) {
  json(response, status, { error: message, ...extra });
}

function channelOf(manager, id) {
  const channel = manager.getChannel(id);
  const view = manager.describe(id);
  return { channel, view };
}

/**
 * @param {{request:import("node:http").IncomingMessage, response:import("node:http").ServerResponse,
 *   method:string, pathname:string, url:URL,
 *   manager:import("../channels/index.mjs").ChannelManager,
 *   configStore:import("../channels/store.mjs").ChannelConfigStore,
 *   readBody:Function, json:Function}} ctx
 * @returns {Promise<boolean>} 是否已经处理了这个请求
 */
export async function maybeHandleChannels(ctx) {
  const pathname = String(ctx.pathname || "");
  if (!pathname.startsWith(CHANNEL_BASE)) return false;

  const { request, response, method, manager, configStore, readBody, json } = ctx;
  if (!manager || !configStore) {
    fail(response, json, 500, "通道模块没有装配好");
    return true;
  }

  // 列表
  if (method === "GET" && pathname === CHANNEL_BASE) {
    json(response, 200, { channels: await manager.viewWithChats() });
    return true;
  }

  const single = SINGLE.exec(pathname);
  if (single) {
    const id = single[1];
    if (!manager.describe(id)) {
      fail(response, json, 400, `没有这个通道：${id}`);
      return true;
    }
    if (method === "GET") {
      json(response, 200, { channel: await manager.describeWithChats(id) });
      return true;
    }
    if (method === "PUT") {
      const body = await readBody(request);
      const current = configStore.get(id);
      const { channel } = channelOf(manager, id);
      // 掩码原样回传 = 没改，必须还原成原值；否则一次保存就把 Token 清了。
      const merged = mergeMasked(body, current);
      const normalized = typeof channel?.normalize === "function" ? channel.normalize(merged, current) : merged;
      try {
        configStore.patch(id, normalized);
      } catch (error) {
        fail(response, json, 400, scrub(messageOf(error), current));
        return true;
      }
      // 改完立刻生效：停掉旧连接再按新配置起（没启用就只是停）。
      await manager.restart(id);
      json(response, 200, { channel: manager.describe(id) });
      return true;
    }
    fail(response, json, 405, `${method} 不支持这个接口`);
    return true;
  }

  const action = ACTION.exec(pathname);
  if (action) {
    const id = action[1];
    const verb = action[2];
    if (!manager.describe(id)) {
      fail(response, json, 400, `没有这个通道：${id}`);
      return true;
    }
    if (verb === "pair" && method === "POST") {
      const pair = configStore.createPairCode(id);
      // 两种形状都给：{pairCode:{code,expiresAt}} 是新面板用的，平铺那层是兼容。
      json(response, 200, {
        pairCode: { code: pair.code, expiresAt: pair.expiresAt },
        code: pair.code,
        expiresAt: pair.expiresAt,
        ttlMs: pair.ttlMs,
      });
      return true;
    }
    if (verb === "test" && method === "POST") {
      const { channel } = channelOf(manager, id);
      const config = configStore.get(id);
      let result;
      try {
        result = typeof channel?.test === "function" ? await channel.test(config) : { ok: false, message: "这个通道不支持测试连接" };
      } catch (error) {
        result = { ok: false, message: messageOf(error) };
      }
      const message = scrub(result?.message || "", config) || null;
      json(response, 200, {
        ok: result?.ok === true,
        message,
        error: result?.ok === true ? null : message,
        warning: result?.warning ? scrub(result.warning, config) : null,
        me: result?.me || null,
        status: manager.describe(id)?.status || null,
      });
      return true;
    }
    if (verb === "chats" && method === "GET") {
      const { channel } = channelOf(manager, id);
      let chats = [];
      try {
        chats = typeof channel?.listChats === "function" ? await channel.listChats() : [];
      } catch (error) {
        chats = [];
        ctx.manager.logError?.(null, error);
      }
      json(response, 200, { chats: Array.isArray(chats) ? chats : [] });
      return true;
    }
    fail(response, json, 405, `${method} 不支持这个接口`);
    return true;
  }

  const allowlist = ALLOWLIST.exec(pathname);
  if (allowlist) {
    const id = allowlist[1];
    const chatId = allowlist[2] ? decodeURIComponent(allowlist[2]) : null;
    if (!manager.describe(id)) {
      fail(response, json, 400, `没有这个通道：${id}`);
      return true;
    }

    if (method === "POST" && !chatId) {
      const body = await readBody(request);
      const current = configStore.get(id);
      const workerId = String(body.workerId || "").trim();
      if (workerId) {
        const workers = typeof manager.hub?.listWorkers === "function" ? manager.hub.listWorkers() : [];
        if (workers.length && !workers.some((worker) => worker.id === workerId)) {
          fail(response, json, 400, `没有这个员工：${workerId}`);
          return true;
        }
      }
      try {
        const entry = configStore.upsertBinding(id, { ...body, boundBy: body.boundBy || "manual" });
        json(response, 200, { entry, allowlist: configStore.get(id).allowlist, channel: manager.describe(id) });
      } catch (error) {
        fail(response, json, 400, scrub(messageOf(error), current));
      }
      return true;
    }

    if (method === "DELETE" && chatId) {
      const removed = configStore.removeBinding(id, chatId);
      if (!removed) {
        fail(response, json, 404, `这个会话没有绑定：${chatId}`);
        return true;
      }
      json(response, 200, { removed: chatId, allowlist: configStore.get(id).allowlist });
      return true;
    }

    fail(response, json, 405, `${method} 不支持这个接口`);
    return true;
  }

  fail(response, json, 404, "没有这个接口");
  return true;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
