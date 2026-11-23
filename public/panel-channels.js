/**
 * 通道设置面板（Telegram / 飞书 / 企业微信 / 微信）。
 *
 * 设计要点：
 *   1. **表单由后端 describeConfig() 驱动**——以后加通道，前端一行不用改；
 *   2. **secret 恒掩码**：只显示后端给的 `1234****abcd`，输入框里的掩码值不回传；
 *   3. 未实现的通道灰态不可启用，但**点得动**，点了要说清为什么；
 *   4. 后端接口还没上线时（404）显示「还没就绪 + 需要填什么」，不白屏、不弹错。
 */

import { $, button, el, formatTime, showModal, softApi, state, toast } from "./panel-common.js";

/**
 * 后端还没上线时的兜底清单。
 * 目的只有一个：让用户知道「每个通道要填什么、为什么现在用不了」。
 */
const FALLBACK_CHANNELS = [
  {
    id: "telegram",
    label: "Telegram",
    implemented: true,
    readiness: "ready",
    note: "在手机上跟自己的 Bot 说话就能派活、插话、侧问；不用公网地址。",
    fields: [
      {
        key: "token",
        label: "Bot Token",
        type: "password",
        secret: true,
        required: true,
        hint: "在 Telegram 里找 @BotFather 发 /newbot，把返回的那串 token 粘进来。",
      },
      {
        key: "apiBase",
        label: "接口地址（可留空）",
        type: "text",
        secret: false,
        hint: "连不上官方地址时填反代地址，留空就用官方地址。",
      },
    ],
  },
  {
    id: "feishu",
    label: "飞书",
    implemented: true,
    readiness: "ready",
    note: "飞书自建应用 + 长连接收消息，不用公网回调地址。",
    fields: [
      { key: "appId", label: "App ID", type: "text", secret: false, required: true, hint: "飞书开放平台 → 应用 → 凭证与基础信息。" },
      { key: "appSecret", label: "App Secret", type: "password", secret: true, required: true, hint: "同上，保存后只显示掩码。" },
      {
        key: "domain",
        label: "域名",
        type: "select",
        secret: false,
        options: [
          { value: "open.feishu.cn", label: "飞书（open.feishu.cn）" },
          { value: "open.larksuite.com", label: "Lark（open.larksuite.com）" },
        ],
        hint: "用 Lark 国际版就换成 larksuite。",
      },
    ],
  },
  {
    id: "qq",
    label: "QQ",
    implemented: true,
    readiness: "ready",
    note: "QQ 开放平台官方机器人（WebSocket 长连接，无需公网 IP），支持 /员工、/派、/换 等全部指令。",
    fields: [
      { key: "appId", label: "AppID", type: "text", secret: false, required: true, hint: "QQ 开放平台 → BotAppID" },
      { key: "clientSecret", label: "ClientSecret（机器人密钥）", type: "password", secret: true, required: true, hint: "只存本地 data/channels.json" },
      { key: "sandbox", label: "使用沙箱环境", type: "switch", secret: false },
      { key: "notifyEnabled", label: "任务完成或卡住时主动推送通知", type: "switch", secret: false },
    ],
  },
  {
    id: "wecom",
    label: "企业微信",
    implemented: true,
    readiness: "ready",
    note: "支持企业微信官方群机器人 Webhook（免公网主动推送）及本地合规插件桥接（双向遥控）。",
    fields: [],
  },
  {
    id: "wechat",
    label: "微信",
    implemented: true,
    readiness: "ready",
    note: "采用本地合规扫码/桌面桥接模式（参考 AionUi），不使用易封号逆向协议。",
    fields: [],
  },
];

const READINESS_TEXT = {
  ready: "可用",
  "needs-public": "需要公网回调，暂不可用",
  unsupported: "平台不支持，暂不可用",
};

const STATE_TEXT = {
  stopped: "已停止",
  starting: "启动中",
  running: "运行中",
  error: "出错",
};

/** 每个通道的编辑草稿：切 tab 不丢用户刚填的内容。 */
const drafts = new Map();
let countdownTimer = 0;

/** 后端给的掩码长这样：1234****abcd。用户没改就别回传。 */
function isMasked(value) {
  return typeof value === "string" && /[*•]{4,}/.test(value);
}

function activeChannel() {
  const list = state.channels.list || [];
  return list.find((item) => item.id === state.channels.activeId) || list[0] || null;
}

function fallbackOf(id) {
  return FALLBACK_CHANNELS.find((item) => item.id === id) || null;
}

/** 把后端返回整理成前端稳定结构；字段缺失就走兜底。 */
function normalizeChannel(raw) {
  const id = String(raw?.id || "").trim();
  const fallback = fallbackOf(id);
  const fields = Array.isArray(raw?.fields)
    ? raw.fields
    : Array.isArray(raw?.describeConfig)
      ? raw.describeConfig
      : (fallback?.fields || []);
  const config = raw?.config && typeof raw.config === "object" ? raw.config : {};
  const readiness = String(raw?.readiness || (raw?.implemented === false ? "unsupported" : "ready"));
  // 状态字段后端是平铺的（state/lastError/...），也兼容嵌套成 status 的写法。
  const status = raw?.status && typeof raw.status === "object" ? raw.status : {
    state: raw?.state || "stopped",
    lastError: raw?.lastError || null,
    lastOkAt: raw?.lastOkAt || null,
    lastErrorAt: raw?.lastErrorAt || null,
    reconnects: Number(raw?.reconnects) || 0,
    me: raw?.me || null,
  };
  return {
    id,
    label: raw?.label || fallback?.label || id,
    implemented: raw?.implemented !== false && readiness === "ready",
    readiness,
    note: raw?.note || fallback?.note || "",
    fields,
    config,
    enabled: config.enabled === true || raw?.enabled === true,
    status,
    allowlist: Array.isArray(raw?.allowlist) ? raw.allowlist : [],
    pairCode: raw?.pairCode && typeof raw.pairCode === "object" ? raw.pairCode : null,
    chats: Array.isArray(raw?.chats) ? raw.chats : [],
  };
}

/** 后端没给某个通道时，用兜底清单补一条「未就绪」占位。 */
function placeholderChannel(id) {
  const fallback = fallbackOf(id);
  return {
    id,
    label: fallback?.label || id,
    implemented: false,
    readiness: "unsupported",
    note: "后端还没返回这个通道的信息。",
    fields: fallback?.fields || [],
    config: {},
    enabled: false,
    status: { state: "stopped" },
    allowlist: [],
    pairCode: null,
    chats: [],
  };
}

function setNotice(message, type = "") {
  state.channels.notice = message || "";
  const node = $("ch-status");
  if (!node) return;
  node.textContent = message || "";
  node.className = `chan-status-line ${type}`.trim();
}

async function loadChannels({ quiet = false } = {}) {
  const result = await softApi("/api/channels");
  state.channels.notImplemented = result.notImplemented;

  if (!result.ok) {
    state.channels.error = result.error?.message || "读取通道配置失败";
    state.channels.list = FALLBACK_CHANNELS.map((item) => ({
      ...normalizeChannel(item),
      implemented: item.implemented && item.readiness === "ready",
    }));
    if (!quiet) {
      setNotice(
        result.notImplemented
          ? "通道接口还没就绪（需要 Hub 0.7.0）：下面是每个通道该填什么，现在保存不会生效。"
          : `读取通道配置失败：${state.channels.error}`,
        result.notImplemented ? "warn" : "error",
      );
    }
    renderBadge();
    return state.channels.list;
  }

  const payload = result.data || {};
  const rawList = Array.isArray(payload) ? payload : Array.isArray(payload.channels) ? payload.channels : [];
  const list = rawList.map((item) => normalizeChannel(item));
  for (const fallback of FALLBACK_CHANNELS) {
    if (!list.some((item) => item.id === fallback.id)) list.push(placeholderChannel(fallback.id));
  }
  const order = FALLBACK_CHANNELS.map((item) => item.id);
  list.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  state.channels.list = list;
  state.channels.error = "";
  if (!list.some((item) => item.id === state.channels.activeId)) {
    state.channels.activeId = list[0]?.id || "";
  }
  if (!quiet) {
    setNotice(
      payload.warning || "改完点「保存并应用」，通道会立刻按新配置重启。",
      payload.warning ? "warn" : "",
    );
  }
  renderBadge();
  return list;
}

function optionValue(option) {
  return typeof option === "string" ? option : option?.value ?? "";
}

function optionLabel(option) {
  return typeof option === "string" ? option : (option?.label || option?.value || "");
}

function draftFor(channel) {
  if (!drafts.has(channel.id)) {
    const values = {};
    for (const field of channel.fields || []) {
      const raw = channel.config?.[field.key];
      if (field.type === "switch") {
        values[field.key] = field.key === "notifyEnabled" ? raw !== false : raw === true;
      } else if (field.type === "select") {
        const options = field.options || [];
        const known = options.some((option) => optionValue(option) === raw);
        values[field.key] = known ? raw : optionValue(options[0]);
      } else {
        values[field.key] = raw === undefined || raw === null ? "" : String(raw);
      }
    }
    drafts.set(channel.id, { enabled: channel.enabled, values });
  }
  return drafts.get(channel.id);
}

/* ---------------- 渲染 ---------------- */

function renderBadge() {
  const badge = $("channel-badge");
  if (!badge) return;
  const list = state.channels.list || [];
  if (!list.length) {
    badge.textContent = "—";
    return;
  }
  const enabled = list.filter((item) => item.enabled && item.implemented).length;
  badge.textContent = enabled ? `${enabled} 个已启用` : "未启用";
  badge.title = state.channels.notImplemented ? "通道接口还没就绪" : "";
}

function renderTabs() {
  const box = $("ch-tabs");
  if (!box) return;
  box.replaceChildren();
  for (const channel of state.channels.list || []) {
    const usable = channel.implemented;
    const tab = button(
      `chan-tab${channel.id === state.channels.activeId ? " active" : ""}${usable ? "" : " is-off"}`,
      "",
      () => {
        state.channels.activeId = channel.id;
        setNotice("");
        renderChannels();
      },
    );
    tab.append(el("span", "chan-tab-name", channel.label));
    const stateText = channel.enabled
      ? "已启用"
      : channel.implemented
        ? "未启用"
        : channel.readiness === "ready"
          ? "模块没加载"
          : READINESS_TEXT[channel.readiness] || "不可用";
    tab.append(el("span", `chan-tab-state${channel.enabled ? " on" : ""}`, stateText));
    box.append(tab);
  }
}

function renderStatusBlock(channel, draft) {
  const section = el("section", "chan-block");
  section.append(el("h3", "", "连接"));

  const status = channel.status || {};
  const row = el("div", "chan-row");
  const label = el("label", `switch${channel.implemented ? "" : " is-off"}`);
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  // 通道坏着的时候不要把「启用」打成勾——会让人以为它正在跑。
  checkbox.checked = channel.implemented && Boolean(draft.enabled);
  checkbox.setAttribute("aria-disabled", channel.implemented ? "false" : "true");
  checkbox.id = "ch-enabled";
  checkbox.name = `ch-${channel.id}-enabled`;
  checkbox.addEventListener("change", () => {
    if (!channel.implemented) {
      checkbox.checked = false;
      setNotice(`${channel.label}现在不能启用：${status.lastError || channel.note || READINESS_TEXT[channel.readiness]}`, "warn");
      return;
    }
    draft.enabled = checkbox.checked;
    renderChannels();
  });
  label.append(checkbox, el("span", "", "启用这个通道"));
  row.append(label);

  const stateText = STATE_TEXT[status.state] || status.state || "已停止";
  row.append(el("span", `chan-state ${status.state || "stopped"}`, stateText));
  if (status.me) {
    const meText = typeof status.me === "string" ? status.me : (status.me.name || status.me.username || status.me.id || "");
    if (meText) row.append(el("span", "chan-meta", meText));
  }
  section.append(row);

  if (!channel.implemented) {
    const reason = status.lastError || channel.note || READINESS_TEXT[channel.readiness] || "暂不可用";
    section.append(el("p", "chan-warn", `现在不能用：${reason}`));
  } else if (channel.note) {
    section.append(el("p", "chan-note", channel.note));
  }
  if (status.lastError && channel.implemented) {
    section.append(el("p", "chan-warn", `上次出错：${status.lastError}`));
  }
  const bits = [];
  if (status.lastOkAt) bits.push(`上次正常：${formatTime(status.lastOkAt)}`);
  if (status.lastErrorAt) bits.push(`上次出错：${formatTime(status.lastErrorAt)}`);
  if (status.reconnects) bits.push(`重连 ${status.reconnects} 次`);
  if (bits.length) section.append(el("p", "chan-note", bits.join(" · ")));

  return section;
}

function renderFormBlock(channel, draft) {
  const section = el("section", "chan-block");
  section.append(el("h3", "", "连接配置"));

  for (const field of channel.fields) {
    const isSwitch = field.type === "switch";
    if (isSwitch) {
      const label = el("label", "switch");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.id = `ch-${channel.id}-${field.key}`;
      box.name = box.id;
      box.checked = Boolean(draft.values[field.key]);
      box.addEventListener("change", () => {
        draft.values[field.key] = box.checked;
      });
      label.append(box, el("span", "", field.label));
      section.append(label);
      if (field.hint) section.append(el("p", "chan-note", field.hint));
      continue;
    }

    const wrap = el("label", "field chan-field");
    wrap.append(el("span", "", field.label + (field.required ? "（必填）" : "")));

    let input;
    if (field.type === "select") {
      input = document.createElement("select");
      for (const option of field.options || []) {
        const node = document.createElement("option");
        node.value = optionValue(option);
        node.textContent = optionLabel(option);
        input.append(node);
      }
      input.value = draft.values[field.key] || "";
    } else {
      input = document.createElement("input");
      input.type = field.type === "number" ? "number" : "text";
      input.spellcheck = false;
      input.value = draft.values[field.key] || "";
      if (field.secret) {
        // 掩码就在值里，不改成密码框：用户要能看见「已设置」而不是一片黑点。
        input.placeholder = "未设置";
        input.autocomplete = "off";
      }
    }
    input.id = `ch-${channel.id}-${field.key}`;
    input.name = input.id;
    input.addEventListener("input", () => {
      draft.values[field.key] = input.value;
    });
    input.addEventListener("change", () => {
      draft.values[field.key] = input.value;
    });

    const row = el("div", "chan-field-row");
    row.append(input);

    if (field.secret) {
      const clear = button("link danger", "清空", async () => {
        await clearSecret(channel, field);
      });
      row.append(clear);
    }

    wrap.append(row);
    if (field.hint) wrap.append(el("small", "", field.hint));
    if (field.secret && isMasked(draft.values[field.key])) {
      wrap.append(el("small", "chan-mask-hint", "已保存的密钥只显示掩码；不动它就不会被覆盖。"));
    }
    section.append(wrap);
  }

  return section;
}

function renderPairBlock(channel, draft) {
  const section = el("section", "chan-block");
  section.append(el("h3", "", "配对"));

  if (!channel.implemented) {
    section.append(el("p", "chan-note", "通道还不能用，配对也先放着。"));
    return section;
  }

  const row = el("div", "chan-row");
  const generate = button("ghost small", channel.pairCode ? "重新生成配对码" : "生成配对码", () => {
    generatePairCode(channel);
  });
  generate.id = "ch-pair";
  row.append(generate);

  if (channel.pairCode?.code) {
    const code = el("strong", "chan-code", channel.pairCode.code);
    code.id = "ch-pair-code";
    row.append(code);
    const countdown = el("span", "chan-countdown", "");
    countdown.id = "ch-pair-countdown";
    row.append(countdown);
    const copy = button("link", "复制", async () => {
      await copyPairCode(channel.pairCode.code);
    });
    row.append(copy);
  } else {
    row.append(el("span", "chan-meta", "还没生成"));
  }
  section.append(row);

  if (channel.pairCode?.code) {
    section.append(
      el("p", "chan-note", `手机上给 Bot 发「/绑定 ${channel.pairCode.code}」，10 分钟内有效，用后即焚。`),
    );
  } else {
    section.append(el("p", "chan-note", "先生成配对码，再用手机发给 Bot 完成绑定。"));
  }
  if (!draft.enabled) {
    section.append(el("p", "chan-warn", "通道还没启用：配对码生成后手机也发不进来，先启用再配对。"));
  }
  return section;
}

function renderAllowBlock(channel) {
  const section = el("section", "chan-block");
  section.append(el("h3", "", `已绑定会话（${channel.allowlist.length}）`));

  if (!channel.allowlist.length) {
    section.append(el("p", "chan-note", "还没有绑定的会话。绑定后这个会话才能派活，没绑定的消息一律拒绝。"));
  } else {
    const table = el("div", "chan-table");
    const head = el("div", "chan-table-row head");
    head.append(
      el("span", "", "会话"),
      el("span", "", "员工"),
      el("span", "", "绑定时间"),
      el("span", "", ""),
    );
    table.append(head);
    for (const entry of channel.allowlist) {
      const row = el("div", "chan-table-row");
      const cell = el("span", "chan-chat");
      if (entry.chatTitle) cell.append(el("strong", "", entry.chatTitle));
      cell.append(el("code", "chan-chat-id", entry.chatId));
      if (entry.enabled === false) cell.append(el("span", "tag", "已禁用"));
      const worker = el("span", "", entry.workerId || "跟随默认");
      const boundAt = el("span", "", entry.boundAt ? formatTime(entry.boundAt) : "—");
      const unbind = button("link danger", "解绑", () => unbindChat(channel, entry));
      row.append(cell, worker, boundAt, unbind);
      table.append(row);
    }
    section.append(table);
  }

  // 最近会话：手机上发过消息就能一键绑定，不用手抄 chatId。
  const chats = channel.chats || [];
  const recent = el("div", "chan-recent");
  recent.append(el("span", "chan-recent-label", "最近会话"));
  if (!chats.length) {
    recent.append(el("span", "chan-meta", "还没有。让手机给 Bot 发一句话，再点上面「刷新最近会话」。"));
  }
  for (const chat of chats.slice(0, 6)) {
    const bound = channel.allowlist.some((entry) => entry.chatId === chat.chatId);
    const chip = button(`chan-chip${bound ? " is-off" : ""}`, chat.chatTitle || chat.chatId, () => {
      if (bound) {
        setNotice("这个会话已经绑过了。", "warn");
        return;
      }
      bindChat(channel, chat);
    });
    chip.title = chat.chatId;
    recent.append(chip);
  }
  section.append(recent);

  const manual = el("div", "chan-row");
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "手动绑定：填会话 ID，例如 tg:837465123";
  input.id = "ch-manual-chat";
  input.name = "ch-manual-chat";
  input.className = "chan-manual";
  manual.append(input);
  manual.append(
    button("ghost small", "绑定", () => {
      const chatId = input.value.trim();
      if (!chatId) {
        setNotice("先填会话 ID。", "warn");
        return;
      }
      bindChat(channel, { chatId });
    }),
  );
  section.append(manual);

  return section;
}

function renderBody() {
  const body = $("ch-body");
  if (!body) return;
  body.replaceChildren();
  const channel = activeChannel();
  if (!channel) {
    body.append(el("p", "empty", "没有可配置的通道。"));
    return;
  }
  const draft = draftFor(channel);
  body.append(renderStatusBlock(channel, draft));
  if (channel.fields.length) {
    body.append(renderFormBlock(channel, draft));
  }
  if (channel.implemented || channel.fields.length) {
    body.append(renderPairBlock(channel, draft));
  }
  if (channel.implemented || channel.fields.length) {
    body.append(renderAllowBlock(channel));
  }
  startCountdown(channel);
}

export function renderChannels() {
  if (!$("channels-modal") || $("channels-modal").classList.contains("hidden")) return;
  renderTabs();
  renderBody();
  const save = $("ch-save");
  if (save) {
    const channel = activeChannel();
    save.classList.toggle("is-off", Boolean(channel) && !channel.implemented);
    save.title = channel && !channel.implemented ? "这个通道暂不可用，保存不会生效" : "";
  }
}

/* ---------------- 配对码倒计时 ---------------- */

function startCountdown(channel) {
  window.clearInterval(countdownTimer);
  const tick = () => {
    const node = $("ch-pair-countdown");
    if (!node) return;
    const expires = channel.pairCode?.expiresAt;
    if (!expires) {
      node.textContent = "";
      return;
    }
    const left = Date.parse(expires) - Date.now();
    if (!Number.isFinite(left)) {
      node.textContent = "";
      return;
    }
    if (left <= 0) {
      node.textContent = "已过期，重新生成";
      node.classList.add("stale");
      return;
    }
    const minutes = Math.floor(left / 60000);
    const seconds = Math.floor((left % 60000) / 1000);
    node.textContent = `${minutes}:${String(seconds).padStart(2, "0")} 后失效`;
    node.classList.remove("stale");
  };
  tick();
  if (channel.pairCode?.expiresAt) countdownTimer = window.setInterval(tick, 1000);
}

async function copyPairCode(code) {
  try {
    await navigator.clipboard.writeText(`/绑定 ${code}`);
    toast("配对命令已复制，直接发到手机上", "ok");
  } catch {
    setNotice(`浏览器不让自动复制，手动发这句：/绑定 ${code}`, "warn");
  }
}

/* ---------------- 动作 ---------------- */

async function saveChannel() {
  const channel = activeChannel();
  if (!channel) return;
  if (!channel.implemented) {
    setNotice(
      `${channel.label}现在不能启用：${channel.status?.lastError || channel.note || READINESS_TEXT[channel.readiness]}`,
      "warn",
    );
    return;
  }
  const draft = draftFor(channel);
  const payload = { enabled: Boolean(draft.enabled) };

  for (const field of channel.fields) {
    const value = draft.values[field.key];
    if (field.secret) {
      // 掩码 = 没改；空 = 保留原值。两种情况都不回传，避免把真密钥覆盖成星号。
      if (isMasked(value) || value === "") continue;
    }
    if (field.type === "switch") {
      payload[field.key] = Boolean(value);
    } else if (field.type === "number") {
      const number = Number(value);
      payload[field.key] = Number.isFinite(number) ? number : 0;
    } else {
      payload[field.key] = String(value ?? "").trim();
    }
  }

  setNotice("保存中…");
  const result = await softApi(`/api/channels/${encodeURIComponent(channel.id)}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
  if (!result.ok) {
    setNotice(
      result.notImplemented
        ? "通道接口还没就绪（需要 Hub 0.7.0），这次改动没保存。"
        : `保存失败：${result.error?.message || "未知错误"}`,
      result.notImplemented ? "warn" : "error",
    );
    return;
  }
  drafts.delete(channel.id);
  await loadChannels({ quiet: true });
  state.channels.notice = "";
  setNotice("已保存并应用。", "ok");
  toast(`${channel.label} 配置已保存`, "ok");
  renderChannels();
}

async function clearSecret(channel, field) {
  const ok = window.confirm(`清空「${channel.label}」的 ${field.label}？\n清空后这个通道会立刻停止收发消息。`);
  if (!ok) return;
  const result = await softApi(`/api/channels/${encodeURIComponent(channel.id)}`, {
    method: "PUT",
    body: JSON.stringify({ clearToken: true, [field.key]: "" }),
  });
  if (!result.ok) {
    setNotice(
      result.notImplemented ? "通道接口还没就绪（需要 Hub 0.7.0）。" : `清空失败：${result.error?.message || ""}`,
      "warn",
    );
    return;
  }
  drafts.delete(channel.id);
  await loadChannels({ quiet: true });
  setNotice("已清空，通道已停用。", "ok");
  renderChannels();
}

async function generatePairCode(channel) {
  const result = await softApi(`/api/channels/${encodeURIComponent(channel.id)}/pair`, {
    method: "POST",
    body: "{}",
  });
  if (!result.ok) {
    setNotice(
      result.notImplemented
        ? "通道接口还没就绪（需要 Hub 0.7.0），配对码生成不了。"
        : `生成失败：${result.error?.message || ""}`,
      result.notImplemented ? "warn" : "error",
    );
    return;
  }
  const data = result.data || {};
  const pairCode = data.pairCode || data;
  channel.pairCode = pairCode?.code ? pairCode : null;
  setNotice(
    pairCode?.code ? `配对码 ${pairCode.code} 已生成，10 分钟内有效。` : data.note || "已生成配对码。",
    "ok",
  );
  renderChannels();
}

async function bindChat(channel, chat) {
  const result = await softApi(`/api/channels/${encodeURIComponent(channel.id)}/allowlist`, {
    method: "POST",
    body: JSON.stringify({ chatId: chat.chatId, chatType: chat.chatType, chatTitle: chat.chatTitle }),
  });
  if (!result.ok) {
    setNotice(
      result.notImplemented ? "通道接口还没就绪（需要 Hub 0.7.0）。" : `绑定失败：${result.error?.message || ""}`,
      result.notImplemented ? "warn" : "error",
    );
    return;
  }
  if (Array.isArray(result.data?.allowlist)) {
    channel.allowlist = result.data.allowlist;
  } else {
    channel.allowlist = [...channel.allowlist, { chatId: chat.chatId, chatTitle: chat.chatTitle, chatType: chat.chatType, boundAt: new Date().toISOString(), boundBy: "manual", enabled: true }];
  }
  setNotice("已绑定，这个会话现在可以派活了。", "ok");
  renderChannels();
}

async function unbindChat(channel, entry) {
  const name = entry.chatTitle || entry.chatId;
  const ok = window.confirm(`解绑「${name}」？\n解绑后这个会话再发消息会被拒绝，需要重新配对。`);
  if (!ok) return;
  const result = await softApi(
    `/api/channels/${encodeURIComponent(channel.id)}/allowlist/${encodeURIComponent(entry.chatId)}`,
    { method: "DELETE" },
  );
  if (!result.ok) {
    setNotice(
      result.notImplemented ? "通道接口还没就绪（需要 Hub 0.7.0）。" : `解绑失败：${result.error?.message || ""}`,
      result.notImplemented ? "warn" : "error",
    );
    return;
  }
  if (Array.isArray(result.data?.allowlist)) {
    channel.allowlist = result.data.allowlist;
  } else {
    channel.allowlist = channel.allowlist.filter((item) => item.chatId !== entry.chatId);
  }
  setNotice(`已解绑「${name}」，它再发消息会被拒绝。`, "ok");
  renderChannels();
}

async function testChannel() {
  const channel = activeChannel();
  if (!channel) return;
  if (!channel.implemented) {
    setNotice(`${channel.label}暂不可用：${channel.note || ""}`, "warn");
    return;
  }
  setNotice("正在测试连接…");
  const result = await softApi(`/api/channels/${encodeURIComponent(channel.id)}/test`, {
    method: "POST",
    body: "{}",
  });
  if (!result.ok) {
    setNotice(
      result.notImplemented
        ? "通道接口还没就绪（需要 Hub 0.7.0），测不了。"
        : `测试失败：${result.error?.message || ""}`,
      result.notImplemented ? "warn" : "error",
    );
    return;
  }
  const data = result.data || {};
  if (data.ok) {
    const extra = data.warning ? `（${data.warning}）` : "";
    setNotice(data.message || data.note || `连上了：${data.me || channel.label} 正常。${extra}`, "ok");
  } else {
    setNotice(`没连上：${data.error || data.message || "原因不明"}`, "error");
  }
}

async function refreshChats() {
  const channel = activeChannel();
  if (!channel) return;
  const result = await softApi(`/api/channels/${encodeURIComponent(channel.id)}/chats`);
  if (!result.ok) {
    setNotice(
      result.notImplemented ? "通道接口还没就绪（需要 Hub 0.7.0）。" : `读取会话失败：${result.error?.message || ""}`,
      "warn",
    );
    return;
  }
  channel.chats = Array.isArray(result.data?.chats) ? result.data.chats : [];
  renderChannels();
}

/* ---------------- 入口 ---------------- */

export async function openChannelsModal() {
  showModal("channels-modal", true);
  setNotice("正在读取通道配置…");
  await loadChannels();
  if (!state.channels.activeId) state.channels.activeId = state.channels.list?.[0]?.id || "";
  renderChannels();
}

export function initChannels() {
  // 顶部工具栏和左栏底部都能进设置，行为一致。
  for (const id of ["open-channels", "side-channels"]) {
    const node = $(id);
    if (node) node.addEventListener("click", () => openChannelsModal());
  }
  for (const id of ["ch-cancel", "ch-close"]) {
    const node = $(id);
    if (node) node.addEventListener("click", () => showModal("channels-modal", false));
  }
  const save = $("ch-save");
  if (save) save.addEventListener("click", () => saveChannel());
  const test = $("ch-test");
  if (test) test.addEventListener("click", () => testChannel());
  const refresh = $("ch-refresh-chats");
  if (refresh) refresh.addEventListener("click", () => refreshChats());
  // 打开页面就先读一次，工具栏上要知道「有几个通道在用」。
  void loadChannels({ quiet: true });
}
