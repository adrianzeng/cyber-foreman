import { DEFAULT_MAX_SEGMENTS, DEFAULT_SEGMENT_LIMIT, splitText } from "./base.mjs";

/**
 * 所有面向用户的 IM 文案集中在这里 —— 纯函数，好测、好改，不会散落在 Router 里。
 *
 * 写文案的三条规矩（设计 §8）：
 *   1. 中文，一句话说清"为什么 + 下一步做什么"。
 *   2. 不说"去点面板链接"：手机打不开 127.0.0.1，只说"去面板看"。
 *   3. 任何拒绝都不能静默，必须给出可执行的下一步。
 */

const STATUS_LABELS = {
  queued: "排队",
  running: "在跑",
  retrying: "等自动重试",
  cancelling: "正在停",
  waiting: "等你",
  completed: "完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "被中断",
};

export function statusLabel(status) {
  return STATUS_LABELS[status] || String(status || "未知");
}

export function shortId(taskId) {
  const text = String(taskId || "");
  return text.length <= 6 ? text : text.slice(-6);
}

export function clip(text, limit = 200) {
  const body = String(text ?? "").trim();
  if (!body) return "";
  if (body.length <= limit) return body;
  return `${body.slice(0, limit)}…`;
}

function withTruncationNotice(parts, truncated) {
  if (!truncated || !parts.length) return parts;
  parts[parts.length - 1] = `${parts[parts.length - 1]}\n\n（内容太长，只推了前 ${parts.length} 段。完整内容去面板看。）`;
  return parts;
}

/** 分段，超长时最后一段补提示。 */
export function split(text, limit = DEFAULT_SEGMENT_LIMIT, maxParts = DEFAULT_MAX_SEGMENTS) {
  const { parts, truncated } = splitText(text, limit, maxParts);
  return withTruncationNotice(parts, truncated);
}

/** 派活回执：必须让人一眼看到"派给谁、什么事、怎么查"。 */
export function receipt(task, workerName, options = {}) {
  const who = workerName || task?.workerId || "默认员工";
  const base = `收到，已派给「${who}」｜${clip(task?.title || "任务", 60)}（${shortId(task?.id)}）。跑完我推给你，中途想加要求直接说话就行。`;
  // 临时点名时一定要说清"只这一次"，否则用户会以为默认员工被换了。
  if (!options?.picked) return base;
  return `${base}\n这次是临时指定，会话默认还是「${options.defaultName || "默认员工"}」；下次不带 @ 就派给它。`;
}

/** 插话回执；warning 是预算提醒，必须原样带上。 */
export function steered(task, warning) {
  const title = clip(task?.title || "任务", 40);
  const tail = warning ? `\n提醒：${warning}` : "";
  return `已插话给「${title}」，员工会按新要求继续。${tail}`;
}

/** 侧问已发出（尚未有答案）。 */
export function sideStarted(workerName, note) {
  const who = workerName ? `「${workerName}」` : "员工";
  const extra = note ? `\n${note}` : "";
  return `侧问已经发出去，${who}答好推给你（不影响正在跑的任务）。${extra}`;
}

/** 插话不支持 → 已自动改用侧问。这句必须把"降级"说清楚，否则用户以为插进去了。 */
export function sideFallback(workerName, note) {
  const who = workerName ? `「${workerName}」` : "这个员工";
  const extra = note ? `\n${note}` : "";
  return `${who}不支持插话，已改为侧问，答好推给你。\n想让它换方向请 /停 后重新 /派。${extra}`;
}

/** 插话被拒的通用句式：原因 + 下一步。 */
export function steerRejected(reason, next) {
  return next ? `${reason}\n${next}` : reason;
}

/** 完成推送（≤3 段）。 */
export function completed(task, options = {}) {
  const title = clip(task?.title || "任务", 40);
  const body = String(task?.result || "").trim();
  const text = body ? `「${title}」跑完了：\n${body}` : `「${title}」跑完了，但没有输出。`;
  return split(text, options.limit || DEFAULT_SEGMENT_LIMIT, options.maxParts || DEFAULT_MAX_SEGMENTS);
}

/** 失败推送（≤3 段，错误本身截断）。 */
export function failed(task, options = {}) {
  const title = clip(task?.title || "任务", 40);
  const reason = clip(task?.error || "原因不明", 600);
  return split(`「${title}」失败了：${reason}\n用 /看 看详情，或 /重派 再来一次。`, options.limit || DEFAULT_SEGMENT_LIMIT, options.maxParts || DEFAULT_MAX_SEGMENTS);
}

/** 第一次进「等你」。 */
export function waiting(task) {
  const title = clip(task?.title || "任务", 40);
  const reason = clip(task?.error || "原因不明", 600);
  return split(`「${title}」卡住了：${reason}\n用 /看 看详情，或 /重派 再来一次。`).join("\n\n");
}

export function cancelled(task) {
  return `「${clip(task?.title || "任务", 40)}」已停止。`;
}

export function interrupted(task) {
  return `「${clip(task?.title || "任务", 40)}」被中断了（Hub 重启过）。用 /重派 再来一次。`;
}

/** 侧问答案。 */
export function sideAnswer(task, question) {
  const answer = String(task?.result || "").trim() || "（没有内容）";
  const head = question ? `侧问「${clip(question, 40)}」的答案：` : "侧问答案：";
  return split(`${head}\n${answer}\n（不影响正在跑的任务）`);
}

export function sideFailed(task) {
  const reason = clip(task?.error || "原因不明", 600);
  return `侧问没答出来：${reason}`;
}

export function statusLine(counts) {
  if (!counts) return "暂时读不到队列状态。";
  const stages = counts.stages || {};
  return [
    "现在的状态：",
    `在跑 ${stages.running || 0} · 等你 ${stages.waiting || 0} · 队列 ${stages.queued || 0} · 已结束 ${stages.done || 0}`,
    `（库里累计任务 ${counts.total || 0} 个）`,
  ].join("\n");
}

/** 任务列表：编号是"接下来 /看 n"的钥匙，必须和 lastList 顺序一致。 */
export function taskList(tasks, options = {}) {
  const workerName = typeof options.workerName === "function" ? options.workerName : () => "";
  if (!Array.isArray(tasks) || !tasks.length) {
    return "这个会话还没派过活。发 /派 你的任务内容 就能派一个。";
  }
  const lines = tasks.map((task, index) => {
    const side = (task.role || "main") === "side" ? "｜侧问" : "";
    const who = workerName(task.workerId);
    return `${index + 1}. ${clip(task.title, 40)}｜${who}｜${statusLabel(task.status)}${side}`;
  });
  return ["最近任务（用编号操作，例如 /看 2）：", ...lines].join("\n");
}

/** 单任务详情。 */
export function taskDetail(task, options = {}) {
  const workerName = typeof options.workerName === "function" ? options.workerName : () => "";
  const lines = [
    `「${clip(task?.title || "任务", 60)}」${task?.role === "side" ? "（侧问）" : ""}`,
    `状态：${statusLabel(task?.status)}｜员工：${workerName(task?.workerId)}`,
  ];
  if (task?.sideQuestion) lines.push(`问题：${clip(task.sideQuestion, 200)}`);
  if (task?.result) lines.push(`结果：\n${String(task.result).slice(0, 3500)}`);
  if (task?.error) lines.push(`问题：${clip(task.error, 600)}`);
  const progress = Array.isArray(task?.progress) ? task.progress : [];
  if (progress.length) {
    const latest = progress[progress.length - 1];
    if (latest?.message) lines.push(`最新进度：${clip(latest.message, 200)}`);
  }
  if (Array.isArray(task?.steers) && task.steers.length) {
    lines.push(`插话 ${task.steers.length} 条，最近一条：${clip(task.steers[task.steers.length - 1].text, 120)}`);
  }
  return lines.join("\n");
}

export function unbound(label) {
  return [
    "这个会话还没绑定，我不能替你派活。",
    `1. 打开面板 → 通道 → ${label || "这个通道"} → 生成配对码`,
    "2. 在这里发 /绑定 123456",
    "（面板的「最近会话」里也能一键绑定）",
  ].join("\n");
}

export function bindCodeHint(label) {
  return [
    "配对码是 6 位数字，写法：/绑定 123456",
    `配对码在面板 → 通道 → ${label || "这个通道"} → 生成配对码里拿，10 分钟内有效。`,
  ].join("\n");
}

export function bindExpired() {
  return "配对码不对或已经过期（10 分钟内有效）。去面板重新生成一个再发。";
}

export function bindSuccess(workerName, entry) {
  const who = workerName || entry?.workerId || "默认员工";
  return `绑定成功。以后这个会话派活交给「${who}」。\n发 /派 你的任务内容 就能开工，/帮 看全部命令。`;
}

export function ambiguous(candidates, options = {}) {
  const workerName = typeof options.workerName === "function" ? options.workerName : () => "";
  const lines = (candidates || []).map(
    (item) => `${item.index}. ${clip(item.title, 40)}｜${workerName(item.workerId)}`,
  );
  return [
    `现在有 ${lines.length} 个任务在跑，我不替你猜是哪一个。`,
    ...lines,
    `用 /插 编号 你的内容 指定（例如 /插 ${lines.length > 1 ? "2" : "1"} 顺手把图也换掉）。`,
  ].join("\n");
}

export function help() {
  return [
    "能做的事：",
    "/派 任务内容      派一个新任务（给当前默认员工）",
    "/派 @2 任务内容   临时派给 2 号，不改默认",
    "/员工             列员工编号、职责、工作目录",
    "/插 2 内容        给正在跑的第 2 个任务插话",
    "/问 内容          侧问：只读地回答问题，不动正在跑的任务",
    "/任务             列最近任务（带编号）",
    "/看 2             看第 2 个任务的详情",
    "/停 2             停止第 2 个任务",
    "/重派 2           重新派发第 2 个任务",
    "/处理 2           把第 2 个任务标记为已处理",
    "/状态             看队列、等待、已结束的数量",
    "/换 2            这个会话改派给 2 号（也能打名字）",
    "/清空             下次派活用全新会话（再发一次撤销）",
    "/绑定 123456      用面板生成的配对码绑定这个会话",
    "/帮               看这段说明",
    "",
    "任务在跑的时候，直接说一句话就会当成插话；想另开新任务要写 /派。",
    "临时点名用 @编号，工作目录跟着那个员工走，不会串到别的项目。",
  ].join("\n");
}

/** 员工清单：编号是给手机用的，★ 是「这个会话现在派给谁」。 */
export function workersList(workers, options = {}) {
  const list = Array.isArray(workers) ? workers : [];
  if (!list.length) return "还没有员工。先去面板里加一个，再回来用 /派 派活。";
  const effective = options.currentId
    || options.defaultId
    || list.find((worker) => worker.enabled !== false)?.id
    || null;
  const lines = list.map((worker, index) => {
    const mark = worker.id === effective ? "★" : " ";
    const note = worker.note ? `｜${clip(worker.note, 24)}` : "";
    const dir = worker.cwd ? `｜${clip(worker.cwd, 52)}` : "｜（没设目录）";
    const state = worker.enabled === false
      ? "｜已停用"
      : worker.available === false ? "｜命令找不到" : "";
    return `${mark} ${index + 1}. ${clip(worker.name, 24)}${note}${dir}${state}`;
  });
  return [
    `现在有 ${list.length} 个员工（★ = 这个会话现在派给谁）：`,
    ...lines,
    "",
    "临时派一件给别的员工：/派 @3 任务内容",
    "改这个会话的默认：/换 3（也可以打名字）",
    "临时点名时，工作目录用那个员工自己的，不会串到别的项目。",
  ].join("\n");
}

/** 点名点错了：必须给编号和下一步，不能静默。 */
export function workerNotFound(selector, workers) {
  const names = (workers || []).map((worker, index) => `${index + 1}.${worker.name}`).join("、");
  return `没找到「${selector}」对应的员工。发 /员工 看编号和名字。现有：${names || "（还没有员工，去面板加一个）"}`;
}

export function workerUnavailable(worker) {
  return `「${worker?.name || "这个员工"}」现在不可用（停用，或者命令找不到）。先去面板修好，或发 /员工 换一个。`;
}

export function dispatchWorkerNoText(selector) {
  return `选了「${selector}」，但还没写要干什么。格式：/派 @${selector} 任务内容`;
}

export function switchHint(workerName, workers) {
  const count = Array.isArray(workers) ? workers.length : 0;
  return `现在派给「${workerName}」。要换发 /换 编号 或 /换 员工名；共 ${count} 个员工，发 /员工 看清单。`;
}

export function switched(found) {
  // 换人必须连工作目录一起换：不然新员工会在上一个员工的项目目录里干活。
  const dir = found?.cwd ? `\n工作目录已跟着改成它自己的：${clip(found.cwd, 60)}` : "";
  return `以后这个会话派给「${found.name}」。${dir}`;
}

export function switchNotFound(name, workers) {
  const names = (workers || []).map((worker, index) => `${index + 1}.${worker.name}`).join("、");
  return `没有叫「${name}」的员工。发 /员工 看编号。现有：${names || "（还没有员工，去面板加一个）"}`;
}

export function switchDisabled(found) {
  return `「${found.name}」已停用，先在面板里启用它。`;
}

export function cleared(next) {
  return next
    ? "下次派活用全新会话（员工不再带之前的记忆）。再发一次 /清空 可以撤销。"
    : "下次派活会继续用之前的会话。";
}

export function taskMissing(index) {
  return `没有编号 ${index} 的任务，先发 /任务 看看`;
}

export function noTaskInChat() {
  return "这个会话还没有任务。";
}

export function stopped(task) {
  return `已发停止请求：「${clip(task?.title || "任务", 40)}」。停稳后我推一条。`;
}

export function retried(task) {
  return `已重新排队：「${clip(task?.title || "任务", 40)}」，跑完推给你。`;
}

export function acknowledged(task) {
  return `已标记处理完：「${clip(task?.title || "任务", 40)}」不再占「等你」。`;
}

export function dispatchEmpty() {
  return "要派什么活？写成 /派 你的任务内容";
}

export function dispatchTooLong() {
  return "任务内容太长了（超过 20 万字符），先在面板里派吧。";
}

export function dispatchFailed(reason) {
  return `没派出去：${reason}`;
}

export function steerEmpty(title, indexHint) {
  return `要跟「${clip(title, 30)}」说什么？写成 /插 ${indexHint} 你的内容`;
}

export function steerTooLong(limit) {
  return `插话内容太长了（最多 ${limit} 字），拆短一点说。`;
}

export function noRunningTask() {
  return "现在没有正在跑的任务，插不进去。\n想派活发 /派 内容；想问问题发 /问 问题。";
}

export function askWhat() {
  return "要问什么？例如 /问 这个仓库的构建命令是什么";
}

export function questionTooLong(limit) {
  return `问题太长了（最多 ${limit} 字），说短一点。`;
}
