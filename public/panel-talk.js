/**
 * 右栏对话区：插话（steer）/ 侧问（side）气泡流。
 *
 * 三条硬规则（来自设计文档 §4.3 / §8）：
 *   1. 插话永不静默失败——按钮置灰也要能点出理由，点了必须有中文反馈；
 *   2. 接口返回 warning（比如预算快超了）只在输入框上方显示黄条，不弹窗、不阻断；
 *   3. 侧问是完整任务，回答事后能查——所以这里只负责「提问 + 显示答案」，不另存状态。
 */

import {
  $,
  SOURCE_TEXT,
  actions,
  adapterOf,
  el,
  isActive,
  isSide,
  shortTime,
  softApi,
  state,
  toast,
  workerById,
} from "./panel-common.js";

/** 右栏对话区是否该出现：任务在跑 / 选中侧问 / 有过插话记录。 */
export function shouldShowTalk(task) {
  if (!task) return false;
  if (task.status === "running") return true;
  if (isSide(task)) return true;
  return Array.isArray(task.steers) && task.steers.length > 0;
}

/** 侧问任务不能插话的真实理由（跟「没打开允许插话」是两件事，别混着说）。 */
const SIDE_STEER_REASON = "侧问只回答一次，不能插话；直接发消息就是继续追问。";

/**
 * 插话能力判定。
 *
 * 后端 0.7.0 在员工对象上给了四个字段，最省事的是直接用 `steerable`：
 *   supportsSteer（这类 CLI 本身支不支持）/ streamInput（这个员工开没开流式输入）
 *   steerable（两者与 = 能不能插）/ steerHint（为什么不能，中文）
 * 老版本没有这些字段时，退化成 adapter.supportsSteer + worker.streamInput 自己算。
 * 任何一条不满足都要给出能照着做的理由，而不是把按钮变灰了事。
 */
export function steerCapability(task) {
  const worker = workerById(task?.workerId);
  const adapter = adapterOf(worker?.kind || task?.kind);
  const kindLabel = adapter?.label || worker?.kindLabel || "这类员工";
  const adapterSupports = adapter?.supportsSteer === true || worker?.supportsSteer === true;
  const adapterRejects = adapter?.supportsSteer === false || worker?.supportsSteer === false;

  const ok = typeof worker?.steerable === "boolean"
    ? worker.steerable
    : adapterSupports && worker?.streamInput === true;
  if (ok) return { ok: true, reason: "" };

  // 有没有拿到能力信息，决定文案该说「不支持」还是「这个版本还没读到」，别冤枉员工。
  const known = typeof worker?.steerable === "boolean" || adapter?.supportsSteer !== undefined || worker?.supportsSteer !== undefined;

  // 后端给的理由最准（它知道是「CLI 不支持」还是「这个员工没开」），其次才是前端兜底文案。
  const reason =
    worker?.steerHint ||
    adapter?.steerHint ||
    (adapterRejects
      ? `${kindLabel}不支持插话，可以用侧问`
      : known
        ? `${worker?.name || kindLabel}还没打开「允许插话」。到员工设置里勾上「允许插话」，就能边跑边改；现在可以用侧问。`
        : "还没读到插话能力（需要 Hub 0.7.0 的 supportsSteer / streamInput），先用侧问。");
  return { ok: false, reason };
}

/** 状态不允许插话时，告诉用户下一步该做什么。 */
function steerRejectText(task) {
  const hint = "可以用侧问";
  switch (task?.status) {
    case "queued":
      return "任务还在排队，等它开始跑再插话；想撤就点停止。";
    case "retrying":
      return "正在等自动重试，现在插话会被丢掉；等它跑起来，或者停掉重派。";
    case "cancelling":
      return "任务正在停止，插话没意义。";
    case "waiting":
    case "failed":
    case "interrupted":
      return `任务已经停下了，插话没人接。用「重新派发」再来一次，或者${hint}。`;
    case "completed":
    case "cancelled":
      return `任务已经结束，插话没用。看结果就好，或者${hint}。`;
    default:
      return `当前状态不能插话，${hint}。`;
  }
}

function setNote(message, type = "") {
  state.talk.note = message || "";
  state.talk.noteType = message ? type : "";
  const node = $("talk-note");
  if (!node) return;
  node.hidden = !message;
  node.textContent = message || "";
  node.className = `talk-note ${type}`.trim();
}

/** 把一条任务整理成气泡列表（我的插话 / 员工的回答）。 */
function bubblesOf(task) {
  const bubbles = [];

  for (const steer of Array.isArray(task.steers) ? task.steers : []) {
    const fromChannel = steer.source && steer.source !== "panel" ? SOURCE_TEXT[steer.source] || steer.source : "";
    const actor = steer.actor?.senderName || "";
    const from = [fromChannel && `来自 ${fromChannel}`, actor].filter(Boolean).join("·");
    bubbles.push({
      kind: "me",
      label: from ? `我 →（${from}）` : "我 →",
      time: steer.at,
      text: steer.text || "",
      failed: steer.delivered === false,
      error: steer.error || "",
    });
  }

  if (isSide(task)) {
    const question = task.sideQuestion || task.prompt || "";
    if (question) {
      bubbles.push({ kind: "me", label: "我 →", time: task.createdAt, text: question, failed: false, error: "" });
    }
    let answer = "";
    let failed = false;
    let error = "";
    if (task.result) {
      answer = task.result;
    } else if (task.error) {
      answer = "这条侧问没答上来。";
      failed = true;
      error = task.error;
    } else if (isActive(task)) {
      answer = "正在只读回答，答完会出现在这里。";
    } else {
      answer = "还没有回答。";
    }
    bubbles.push({
      kind: "worker",
      label: "员工 ←",
      time: task.finishedAt || task.startedAt || task.createdAt,
      text: answer,
      failed,
      error,
    });
  }

  return bubbles.sort((a, b) => {
    const left = Date.parse(a.time || "") || 0;
    const right = Date.parse(b.time || "") || 0;
    return left - right;
  });
}

function renderBubble(bubble) {
  const wrap = el("div", `bubble ${bubble.kind === "me" ? "me" : "worker"}${bubble.failed ? " failed" : ""}`);
  const label = el("span", "bubble-label", bubble.label);
  if (bubble.time) {
    const time = el("time", "bubble-time", shortTime(bubble.time));
    label.append(time);
  }
  const text = el("p", "bubble-text", bubble.text || "（空）");
  wrap.append(label, text);
  if (bubble.error) wrap.append(el("p", "bubble-error", bubble.error));
  return wrap;
}

/** 按钮的灰态用 class + aria，不用 disabled：灰了也要能点出理由。 */
function paintButton(id, { ok, label, reason }) {
  const node = $(id);
  if (!node) return;
  node.textContent = label;
  node.classList.toggle("is-off", !ok);
  node.setAttribute("aria-disabled", ok ? "false" : "true");
  node.title = ok ? "" : reason;
}

export function renderTalk() {
  const box = $("talk");
  if (!box) return;
  const task = state.detail;
  if (!shouldShowTalk(task)) {
    box.hidden = true;
    return;
  }
  box.hidden = false;

  // 黄条：接口返回的 warning（预算、写入失败之类），只说不停。
  const warn = $("talk-warn");
  if (warn) {
    warn.hidden = !state.talk.warning;
    warn.textContent = state.talk.warning || "";
  }

  // 气泡流
  const log = $("talk-log");
  if (log) {
    const bubbles = bubblesOf(task);
    log.replaceChildren();
    if (!bubbles.length) {
      log.append(el("p", "talk-empty", "还没有对话。任务在跑时直接说话就是插话；想问一句不打断它，用「侧问」。"));
    }
    for (const bubble of bubbles) log.append(renderBubble(bubble));
    log.scrollTop = log.scrollHeight;
  }

  // 两个按钮各自独立判定，不是互斥单选。
  const capability = steerCapability(task);
  const running = task.status === "running";
  paintButton("talk-steer", {
    // 侧问本身就是一次性问答，按钮直接置灰并给出专属理由，不要让人点了才被拦下来。
    ok: capability.ok && running && !isSide(task),
    label: state.talk.busy ? "插话中…" : "插话",
    reason: isSide(task)
      ? SIDE_STEER_REASON
      : capability.ok
        ? steerRejectText(task)
        : capability.reason,
  });
  const sideBusy = Boolean(task.workerId && state.talk.busy);
  paintButton("talk-side", {
    ok: !sideBusy,
    label: state.talk.busy ? "发送中…" : "侧问",
    reason: "上一条还在发，等一下",
  });
  const input = $("talk-input");
  if (input) input.disabled = state.talk.busy;

  const mode = $("talk-mode");
  if (mode) {
    mode.textContent = isSide(task)
      ? "侧问任务：Enter = 继续追问（新开一条只读侧问）"
      : running
        ? "Enter = 插话（不打断，边跑边改）"
        : "Enter = 侧问（任务已停，问一句不重开）";
  }

  // 发送成功/失败的一句话反馈放在输入框上方。
  const note = $("talk-note");
  if (note) {
    note.hidden = !state.talk.note;
    note.textContent = state.talk.note;
    note.className = `talk-note ${state.talk.noteType}`.trim();
  }
}

/**
 * 发送一句话。
 * @param {"auto"|"steer"|"side"} mode auto=由后端按状态决定（Enter 用）；
 *        steer=用户明确点了「插话」；side=用户明确点了「侧问」。
 */
export async function sendTalk(mode = "auto") {
  const task = state.detail;
  const input = $("talk-input");
  if (!task || !input) return;
  const text = input.value.trim();

  if (state.talk.busy) return;
  if (!text) {
    setNote("先写一句要说的内容。", "warn");
    input.focus();
    return;
  }

  // 明确点「插话」但条件不满足：必须当场说清原因，不能静默。
  if (mode === "steer") {
    if (isSide(task)) {
      setNote(SIDE_STEER_REASON, "warn");
      return;
    }
    const capability = steerCapability(task);
    if (!capability.ok) {
      setNote(capability.reason, "warn");
      return;
    }
    if (task.status !== "running") {
      setNote(steerRejectText(task), "warn");
      return;
    }
  }

  state.talk.busy = true;
  state.talk.warning = "";
  setNote(mode === "side" ? "正在开侧问任务…" : "正在发送…");
  renderTalk();

  const result = await softApi(`/api/tasks/${encodeURIComponent(task.id)}/say`, {
    method: "POST",
    body: JSON.stringify({ text, mode }),
  });

  state.talk.busy = false;

  if (!result.ok) {
    const error = result.error;
    if (result.notImplemented) {
      setNote("后端还没有「对话」接口（需要 Hub 0.7.0），这句话没送出去。任务本身不受影响。", "error");
    } else {
      // 文案只出后端一处：message 与 error 同值，原文上屏，不再自己拼「可以改用侧问」。
      setNote(error?.message || "发送失败", "error");
    }
    renderTalk();
    return;
  }

  const data = result.data || {};
  input.value = "";
  state.talk.draft = "";

  if (data.warning) state.talk.warning = data.warning;

  if (data.delivered === "side") {
    // 侧问是个新任务，默认被「含侧问」过滤掉；这里帮用户把开关打开，否则他会以为没发出去。
    const opened = !state.showSide;
    state.showSide = true;
    const idText = data.sideTaskId ? `（任务号 ${data.sideTaskId}）` : "";
    setNote(
      `${data.note || "已开一个只读侧问。"}${idText}${opened ? "已帮你打开「含侧问」开关，回答就在任务流里。" : ""}`,
      "ok",
    );
    toast("已发起侧问", "ok");
  } else {
    setNote(data.note || "已插话，员工会在这一轮看到。", "ok");
  }

  // 立即上屏：后端回了新 task 就用它，没回就本地乐观插入一条气泡。
  if (data.task && typeof data.task === "object") {
    state.detail = data.task;
  } else {
    if (!Array.isArray(state.detail.steers)) state.detail.steers = [];
    if (data.delivered === "steer") {
      state.detail.steers.push({
        at: new Date().toISOString(),
        text,
        source: "panel",
        delivered: true,
      });
    }
  }
  renderTalk();
  await actions.refresh();
}

export function initTalk() {
  const input = $("talk-input");
  if (input) {
    input.addEventListener("input", () => {
      state.talk.draft = input.value;
      if (state.talk.note && state.talk.noteType !== "ok") setNote("");
    });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      // 一律交给后端 auto 判断：侧问任务上继续追问会由 Hub 自动降级成新的只读侧问。
      // 前端不特判，手机 IM 和面板才能走同一套规则。
      sendTalk("auto");
    });
  }
  const steer = $("talk-steer");
  if (steer) steer.addEventListener("click", () => sendTalk("steer"));
  const side = $("talk-side");
  if (side) side.addEventListener("click", () => sendTalk("side"));
}
