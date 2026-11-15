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
    budgetHint: adapter.budgetHint || "",
    commandHint: adapter.commandHint || "",
    defaultPermissionMode: adapter.defaultPermissionMode || "",
    permissionModes: Array.isArray(adapter.permissionModes) ? adapter.permissionModes : [],
  }));
}

export function adapterKinds() {
  return [...ADAPTERS.keys()];
}
