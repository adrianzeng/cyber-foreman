/**
 * 意图解析：纯函数，不碰网络、不碰存储，方便单测穷举所有分支。
 *
 * 关键规则（需求 C 带来的行为变更）：
 *   - 有 **一个** running 任务时，无前缀文本 = 插话
 *   - 有 **多个** running 任务时不猜，回「有 2 个任务在跑，用 /插 2 内容 指定」
 *   - 没有任何 running 任务时，无前缀文本 = 派活（沿用老行为）
 */

const COMMAND_ALIASES = new Map([
  ["派", "dispatch"],
  ["pai", "dispatch"],
  ["p", "dispatch"],
  ["task", "dispatch"],
  ["插", "steer"],
  ["插话", "steer"],
  ["steer", "steer"],
  ["问", "side"],
  ["侧问", "side"],
  ["side", "side"],
  ["ask", "side"],
  ["任务", "list"],
  ["列表", "list"],
  ["list", "list"],
  ["ls", "list"],
  ["看", "detail"],
  ["详情", "detail"],
  ["show", "detail"],
  ["停", "stop"],
  ["停止", "stop"],
  ["stop", "stop"],
  ["重派", "retry"],
  ["重试", "retry"],
  ["retry", "retry"],
  ["处理", "ack"],
  ["已处理", "ack"],
  ["ack", "ack"],
  ["状态", "status"],
  ["status", "status"],
  ["换", "switch"],
  ["切换", "switch"],
  ["switch", "switch"],
  ["清空", "clear"],
  ["新会话", "clear"],
  ["clear", "clear"],
  ["绑定", "bind"],
  ["bind", "bind"],
  ["帮", "help"],
  ["帮助", "help"],
  ["help", "help"],
  ["?", "help"],
]);

/** 命令里要带内容的那些，缺内容时给一句人话。 */
export const NEEDS_TEXT = new Set(["dispatch", "steer", "side"]);

/** 任务 id 太长，聊天里只显示末 6 位。 */
export function shortId(taskId) {
  const text = String(taskId || "");
  if (text.length <= 6) return text;
  return text.slice(-6);
}

function parseTarget(rest, ctx) {
  const trimmed = String(rest || "").trim();
  if (!trimmed) return { targetIndex: null, targetTaskId: null, text: "" };

  const first = trimmed.split(/\s+/)[0];
  const remainder = trimmed.slice(first.length).trim();
  const tasks = Array.isArray(ctx.tasks) ? ctx.tasks : [];

  if (/^\d{1,3}$/.test(first)) {
    const index = Number(first);
    const task = tasks[index - 1];
    if (task) return { targetIndex: index, targetTaskId: task.id, text: remainder };
    return { targetIndex: index, targetTaskId: null, text: remainder, invalidIndex: true };
  }

  const full = tasks.find((task) => task.id === first);
  if (full) return { targetIndex: null, targetTaskId: full.id, text: remainder };

  const bare = first.replace(/^task_/, "").toLowerCase();
  const byShort = tasks.find((task) => shortId(task.id).toLowerCase() === bare);
  if (byShort) return { targetIndex: null, targetTaskId: byShort.id, text: remainder };

  return { targetIndex: null, targetTaskId: null, text: trimmed };
}

function argsFor(kind, rest, ctx) {
  switch (kind) {
    case "dispatch":
      // 任务内容里可能以数字开头（「2 个文件…」），所以绝不在这里吃编号。
      return { text: String(rest || "").trim() };
    case "steer": {
      const target = parseTarget(rest, ctx);
      return {
        targetIndex: target.targetIndex,
        targetTaskId: target.targetTaskId,
        invalidIndex: target.invalidIndex === true,
        text: target.text,
      };
    }
    case "side": {
      const target = parseTarget(rest, ctx);
      // 问题本身可能以数字开头（「2 个 CPU 够吗」），编号解不出来就整句当问题。
      if (target.invalidIndex) return { targetIndex: null, targetTaskId: null, text: String(rest || "").trim() };
      return {
        targetIndex: target.targetIndex,
        targetTaskId: target.targetTaskId,
        text: target.text,
      };
    }
    case "detail":
    case "stop":
    case "retry":
    case "ack": {
      const target = parseTarget(rest, ctx);
      return {
        targetIndex: target.targetIndex,
        targetTaskId: target.targetTaskId,
        invalidIndex: target.invalidIndex === true,
        text: "",
      };
    }
    case "switch":
      return { workerName: String(rest || "").trim() };
    case "bind":
      return { text: String(rest || "").trim() };
    default:
      return {};
  }
}

/**
 * @param {string} text 用户原文
 * @param {{running?: Array<{id:string,title?:string,workerId?:string}>,
 *          tasks?: Array<{id:string,title?:string,workerId?:string,status?:string,role?:string}>}} ctx
 * @returns {object} Intent
 */
export function parseIntent(text, ctx = {}) {
  const raw = String(text ?? "");
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "empty", raw, text: "" };

  // 中文输入法下容易打出全角斜杠，先归一化。
  const normalized = trimmed.replace(/^／/, "/");

  if (normalized.startsWith("/")) {
    const match = /^\/\s*([^\s/@]+)\s*([\s\S]*)$/.exec(normalized);
    if (!match) {
      return {
        kind: "unknown",
        raw,
        text: normalized,
        hint: "命令后面要跟内容，例如 /派 整理 README",
      };
    }
    const command = match[1];
    const rest = match[2].trim();
    const kind = COMMAND_ALIASES.get(command.toLowerCase()) || COMMAND_ALIASES.get(command) || null;
    if (!kind) {
      return {
        kind: "unknown",
        raw,
        command,
        text: rest,
        hint: `不认识 /${command}，发 /帮 看能用的命令`,
      };
    }
    return { kind, raw, command, text: rest, ...argsFor(kind, rest, ctx) };
  }

  const running = Array.isArray(ctx.running) ? ctx.running : [];
  if (running.length === 1) {
    return {
      kind: "steer",
      raw,
      text: trimmed,
      auto: true,
      targetTaskId: running[0].id,
      targetTitle: running[0].title || "",
    };
  }
  if (running.length > 1) {
    return {
      kind: "ambiguous",
      raw,
      text: trimmed,
      candidates: running.map((task, index) => ({
        index: index + 1,
        id: task.id,
        title: task.title || "未命名任务",
        workerId: task.workerId || null,
      })),
    };
  }
  return { kind: "dispatch", raw, text: trimmed, auto: true };
}
