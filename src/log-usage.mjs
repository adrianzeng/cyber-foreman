import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { fromClaude } from "./usage.mjs";

/**
 * 从任务日志里把用量补回来。
 *
 * 为什么需要：0.5 之前的任务只存了 CLI 原始的 usage 对象，没有轮数（num_turns）。
 * 而轮数恰恰是判断“这个任务是不是跑太大了”最直观的指标。
 * 日志里本来就有完整事件，读一次尾部就能捞出来，不用让用户重新跑。
 *
 * 只读尾部若干 MB：result 事件在最后，没必要把 10 多 MB 全吞进内存。
 */
const TAIL_BYTES = 2 * 1024 * 1024;

export function readTail(file, limit = TAIL_BYTES) {
  const { size } = statSync(file);
  if (!size) return "";
  const start = Math.max(0, size - limit);
  const length = size - start;
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buffer, 0, length, start);
  } finally {
    closeSync(fd);
  }
  return buffer.toString("utf8");
}

/** 从一段文本里抠出 result 事件并转成用量。 */
function parseResultSegment(segment) {
  const start = segment.indexOf("{");
  if (start < 0) return null;
  const candidate = segment.slice(start);

  const attempt = (text) => {
    try {
      const event = JSON.parse(text);
      return event?.type === "result" ? fromClaude(event) : null;
    } catch {
      return null;
    }
  };

  const direct = attempt(candidate);
  if (direct) return direct;

  // 段尾可能跟着下一行的时间戳或半行，退到最后一个 } 再试一次。
  const end = candidate.lastIndexOf("}");
  if (end > 0) return attempt(candidate.slice(0, end + 1));
  return null;
}

/**
 * 从某个任务的日志里取出用量。拿不到就返回 null，调用方保持原样。
 */
export function usageFromLog(logsDir, taskId) {
  if (!logsDir || !taskId) return null;
  let text;
  try {
    text = readTail(join(logsDir, `${taskId}.log`), TAIL_BYTES);
  } catch {
    return null;
  }
  if (!text) return null;

  // 早期日志把整段会话写在一行里，所以不能只按换行切。
  // 统一按 `] stdout ` / `] stderr ` 这些行首标记切段，再从后往前找 result。
  const segments = text.split(/\](?: stdout| stderr) /);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (!segments[index].includes('"type":"result"')) continue;
    const usage = parseResultSegment(segments[index]);
    if (usage) return usage;
  }
  return null;
}
