/**
 * 面板公共层：全局状态 + HTTP 调用 + DOM / 格式化工具 + 通知与模态。
 *
 * 分层约定（避免循环依赖）：
 *   panel-common.js      ← 谁都可以依赖，自己不依赖任何 panel-*
 *   panel-talk.js        → common
 *   panel-channels.js    → common
 *   panel-workbench.js   → common + panel-talk + panel-channels
 *   app.js               → 全部，负责启动、轮询、筛选与编排
 *
 * 后端接口可能还没上线（另一个工程师并行开发），所以：
 *   - 所有「可选」接口一律走 softApi()，404/500 只降级，不抛到界面上；
 *   - 页面骨架永远先渲染，数据后到，绝不留白屏。
 */

export const $ = (id) => document.getElementById(id);

/* ---------------- 全局状态 ---------------- */

export const state = {
  /** 最近一次 /api/overview 的原始返回。 */
  overview: null,
  workers: [],
  adapters: [],
  tasks: [],
  templates: [],
  /** 阶段筛选："" 表示全部。 */
  stage: "",
  /** 是否把侧问任务一起列出来（默认过滤掉，任务流才干净）。 */
  showSide: false,
  selectedId: null,
  detail: null,
  refreshing: false,
  cwdInitialized: false,
  editingWorkerId: null,
  /** 员工下拉的复用签名，没变化就不重建 DOM。 */
  selectSignature: "",
  projectsSignature: "",
  flowSignature: "",
  /** 目录选择器状态。 */
  dir: null,
  drives: null,
  onPickDir: null,
  /** 员工表单：当前类型的启动参数。用户看不见它，但必须跟着类型走。 */
  pendingArgsPrefix: [],
  /** 用户是否手动改过启动命令；没改过就允许按类型自动覆盖。 */
  commandTouched: false,
  /** 顶部状态字是否展开说明。 */
  statusExpanded: false,
  /** 左栏是否折叠。 */
  sideCollapsed: false,
  /** 对话区临时状态：发送中、提示、黄条。 */
  talk: { busy: false, note: "", noteType: "", warning: "", draft: "" },
  /** 通道面板状态。 */
  channels: { list: null, error: "", notImplemented: false, activeId: "", busy: false, notice: "" },
  /** 应用是否完成首次渲染（供 index.html 的看门狗判断）。 */
  booted: false,
};

/**
 * 面板之间互相调用的动作表。
 * app.js 启动时把真实实现挂上来，面板只调这里，避免 import 循环。
 */
export const actions = {
  refresh: async () => {},
  hardRefresh: async () => {},
  selectTask: async () => {},
  reloadDetail: async () => {},
  clearSelection: () => {},
  setStage: async () => {},
};

/* ---------------- 文案 ---------------- */

export const STATUS_TEXT = {
  queued: "排队",
  running: "执行中",
  retrying: "重试中",
  cancelling: "停止中",
  waiting: "等你",
  completed: "完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "中断",
};

export const STAGE_TEXT = {
  "": "全部",
  running: "在跑",
  waiting: "等你",
  queued: "队列里",
  done: "已结束",
};

/** 四个阶段的一句话解释：写在 index.html 里，展开后才显示，默认只占一行。 */
export const STAGE_ORDER = ["running", "waiting", "queued", "done"];

/** 插话来源的中文标注，给对话气泡用。 */
export const SOURCE_TEXT = {
  panel: "面板",
  telegram: "Telegram",
  feishu: "飞书",
  wecom: "企业微信",
  wechat: "微信",
};

/* ---------------- HTTP ---------------- */

/** 带状态码与业务 code 的请求错误，界面据此给中文提示。 */
export class ApiError extends Error {
  constructor(message, { status = 0, code = "", fallback = "", body = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.fallback = fallback;
    this.body = body;
  }
}

function networkMessage(error) {
  const text = error instanceof Error ? error.message : String(error);
  if (/fetch|network|load failed|failed to fetch/i.test(text)) {
    return "连不上 Hub，请确认 npm start 还在跑";
  }
  return text;
}

/**
 * 唯一的请求入口。
 * 失败一律转成 ApiError：message 是可以直接显示给用户的中文一句话。
 */
export async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    throw new ApiError(networkMessage(error), { status: 0 });
  }

  const raw = await response.text();
  let data = {};
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { error: raw.slice(0, 300) };
    }
  }

  if (!response.ok) {
    throw new ApiError(data.error || `请求失败（HTTP ${response.status}）`, {
      status: response.status,
      code: data.code || "",
      fallback: data.fallback || "",
      body: data,
    });
  }
  return data;
}

/**
 * 不抛异常的请求：可选接口（通道、插话）用它。
 * notImplemented 为真表示后端还没这个路由——界面该显示「还没就绪」，而不是报错。
 */
export async function softApi(path, options = {}) {
  try {
    return { ok: true, data: await api(path, options), error: null, notImplemented: false };
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 0;
    return {
      ok: false,
      data: null,
      error,
      notImplemented: status === 404 || status === 405 || status === 501,
    };
  }
}

/* ---------------- DOM ---------------- */

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

export function button(className, label, onClick) {
  const node = el("button", className, label);
  node.type = "button";
  if (onClick) node.addEventListener("click", onClick);
  return node;
}

export function showModal(id, show) {
  const node = $(id);
  if (!node) return;
  node.classList.toggle("hidden", !show);
}

/* ---------------- 格式化 ---------------- */

const TIME_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return TIME_FORMAT.format(date);
}

export function shortTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

export function duration(task) {
  if (!task || !task.startedAt) return "—";
  const end = task.finishedAt ? new Date(task.finishedAt).getTime() : Date.now();
  const start = new Date(task.startedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "—";
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remain = seconds % 60;
  if (minutes < 60) return `${minutes} 分 ${remain} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

export function baseName(path) {
  const parts = String(path || "").split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || String(path || "");
}

/**
 * 超长路径中间省略：C:\Users\…\dsh-agent-hub。
 * 保留「盘符 + 第一层」和「最后一层」，中间打点；全文放 title 里。
 */
export function middleEllipsis(path, max = 34) {
  const value = String(path ?? "").trim();
  if (!value) return "";
  if (value.length <= max) return value;
  const separator = value.includes("\\") ? "\\" : "/";
  const parts = value.split(/[\\/]+/).filter(Boolean);
  if (parts.length >= 4) {
    const root = parts[0];
    const prefix = root.endsWith(":") ? `${root}${separator}${parts[1]}` : root;
    const tail = parts[parts.length - 1];
    return `${prefix}${separator}…${separator}${tail}`;
  }
  const head = Math.max(4, Math.ceil(max * 0.38));
  const tail = Math.max(4, max - head - 1);
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** token 数量按「万」压缩，避免一屏数字。 */
export function formatTokens(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** 用量一句话：轮数 + 输出 + 输入 + 缓存命中。 */
export function usageText(usage) {
  if (!usage) return null;
  const parts = [];
  if (usage.turns) parts.push(`${usage.turns} 轮`);
  if (usage.outputTokens) {
    const thinking = usage.thinkingTokens ? `（含思考 ${formatTokens(usage.thinkingTokens)}）` : "";
    parts.push(`输出 ${formatTokens(usage.outputTokens)}${thinking}`);
  }
  if (usage.inputTokens) parts.push(`输入 ${formatTokens(usage.inputTokens)}`);
  if (usage.cacheReadTokens) parts.push(`缓存命中 ${formatTokens(usage.cacheReadTokens)}`);
  return parts.length ? parts.join(" · ") : null;
}

/* ---------------- 任务判定 ---------------- */

export function isActive(task) {
  return Boolean(task) && ["queued", "running", "retrying", "cancelling"].includes(task.status);
}

export function isSide(task) {
  return task?.role === "side";
}

/** 后端有 stage 字段就用它，没有就按状态推——旧任务也能分类。 */
export function stageOf(task) {
  if (!task) return "done";
  if (task.acknowledgedAt) return "done";
  if (task.stage) return task.stage;
  if (task.status === "queued") return "queued";
  if (["running", "retrying", "cancelling"].includes(task.status)) return "running";
  if (["waiting", "failed", "interrupted"].includes(task.status)) return "waiting";
  return "done";
}

export function workerById(id) {
  return state.workers.find((worker) => worker.id === id) || null;
}

export function workerName(id) {
  return workerById(id)?.name || id || "—";
}

export function adapterOf(kind) {
  return (state.adapters || []).find((item) => item.kind === kind) || null;
}

/* ---------------- 反馈 ---------------- */

export function setConnection(mode, label) {
  const element = $("connection");
  if (!element) return;
  element.classList.remove("online", "offline");
  if (mode) element.classList.add(mode);
  const text = $("connection-text");
  if (text) text.textContent = label;
}

export function setFormNote(message, type = "") {
  const element = $("form-note");
  if (!element) return;
  element.textContent = message;
  element.className = `form-note ${type}`.trim();
}

let toastTimer = 0;

/** 轻提示：只说一句话，不打断操作，3 秒自己消失。 */
export function toast(message, type = "") {
  let node = $("toast");
  if (!node) {
    node = el("div", "toast");
    node.id = "toast";
    document.body.appendChild(node);
  }
  node.textContent = message;
  node.className = `toast ${type}`.trim();
  node.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    node.classList.remove("show");
  }, 3200);
}

export async function copyText(value) {
  const text = String(value ?? "");
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 非安全上下文时 navigator.clipboard 不可用，退化成老办法。
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "true");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }
}
