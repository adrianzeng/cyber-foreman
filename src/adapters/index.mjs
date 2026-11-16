import claude from "./claude.mjs";
import agy from "./agy.mjs";
import codex from "./codex.mjs";

/**
 * 员工类型注册表。
 * 新增一种 CLI：写一个适配器文件，在这里加一行，再到 config/workers.json 加一段配置。
 * Hub、HTTP 接口和面板都不用改。
 */
const ADAPTERS = new Map(
  [claude, agy, codex].map((adapter) => [adapter.kind, adapter]),
);

export const DEFAULT_KIND = "claude-cli";

export function getAdapter(kind) {
  return ADAPTERS.get(kind || DEFAULT_KIND) || null;
}

export function listAdapters() {
  return [...ADAPTERS.values()].map((adapter) => ({
    kind: adapter.kind,
    label: adapter.label,
    binLabel: adapter.binLabel,
    transport: adapter.transport,
    supportsResume: Boolean(adapter.supportsResume),
    supportsExtraDirs: Boolean(adapter.supportsExtraDirs),
    supportsBudget: Boolean(adapter.supportsBudget),
    /** 面板据此决定「插话」按钮是否置灰，以及 tooltip 写什么理由。 */
    supportsSteer: adapter.supportsSteer === true,
    steerHint: adapter.supportsSteer === true
      ? (adapter.steerHint || "这个类型支持插话：在员工设置里打开「允许插话」后可用。")
      : (adapter.steerHint || "这个类型不支持插话；可以改用侧问，或停掉任务重新派。"),
    budgetHint: adapter.budgetHint || "",
    commandHint: adapter.commandHint || "",
    defaultPermissionMode: adapter.defaultPermissionMode || "",
    permissionModes: Array.isArray(adapter.permissionModes) ? adapter.permissionModes : [],
  }));
}

/** 这类 CLI 本身能不能中途插话（与员工有没有打开开关无关）。 */
export function adapterSupportsSteer(kind) {
  return getAdapter(kind)?.supportsSteer === true;
}

export function adapterSteerHint(kind) {
  const adapter = getAdapter(kind);
  if (!adapter) return "不认识这个员工类型，插话不可用。";
  if (adapter.supportsSteer === true) {
    return adapter.steerHint || "这个类型支持插话：在员工设置里打开「允许插话」后可用。";
  }
  return adapter.steerHint || "这个类型不支持插话；可以改用侧问，或停掉任务重新派。";
}

export function adapterKinds() {
  return [...ADAPTERS.keys()];
}
