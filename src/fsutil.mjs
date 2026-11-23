import { existsSync, readdirSync, statSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";

/**
 * 本机 CLI 自动探测表（为 v0.9.0 扩展 kimi-cli / doubao-cli 预留统一入口）。
 * 只做只读文件存在性检测，不执行外部命令、不接触账号凭证。
 */
export const CLI_PROBES = Object.freeze({
  "claude-cli": {
    kind: "claude-cli",
    commands: ["claude"],
    fallbackPaths: ({ home, platform }) => (
      platform === "win32"
        ? [join(home, ".local", "bin", "claude.exe")]
        : [join(home, ".local", "bin", "claude")]
    ),
  },
  "codex-cli": {
    kind: "codex-cli",
    commands: ["codex"],
    nodeScripts: ({ env, home, platform }) => {
      if (platform !== "win32") return [];
      const appData = env.APPDATA || join(home, "AppData", "Roaming");
      return [join(appData, "npm", "node_modules", "@openai", "codex", "bin", "codex.js")];
    },
    fallbackPaths: () => [],
  },
  "agy-cli": {
    kind: "agy-cli",
    commands: ["agy"],
    fallbackPaths: ({ env, home, platform }) => {
      if (platform === "win32") {
        const localAppData = env.LOCALAPPDATA || join(home, "AppData", "Local");
        return [
          join(localAppData, "agy", "bin", "agy.exe"),
          join(home, ".local", "bin", "agy.exe"),
        ];
      }
      return [join(home, ".local", "bin", "agy")];
    },
  },
  "kimi-cli": {
    kind: "kimi-cli",
    commands: ["kimi", "kimi-cli"],
    fallbackPaths: ({ env, home, platform }) => {
      if (platform === "win32") {
        const localAppData = env.LOCALAPPDATA || join(home, "AppData", "Local");
        const appData = env.APPDATA || join(home, "AppData", "Roaming");
        return [
          join(home, ".local", "bin", "kimi.exe"),
          join(home, ".uv", "tools", "kimi-cli", "Scripts", "kimi.exe"),
          join(localAppData, "Programs", "kimi", "kimi.exe"),
          join(appData, "Python", "Scripts", "kimi.exe"),
        ];
      }
      return [join(home, ".local", "bin", "kimi"), "/usr/local/bin/kimi"];
    },
  },
  "doubao-cli": {
    kind: "doubao-cli",
    commands: ["doubao", "doubao-cli"],
    fallbackPaths: ({ env, home, platform }) => {
      if (platform === "win32") {
        const localAppData = env.LOCALAPPDATA || join(home, "AppData", "Local");
        return [
          join(localAppData, "doubao", "bin", "doubao.exe"),
          join(home, ".local", "bin", "doubao.exe"),
        ];
      }
      return [join(home, ".local", "bin", "doubao"), "/usr/local/bin/doubao"];
    },
  },
});

/** 查找可执行文件：绝对路径直接验证，裸命令按 PATH 枚举；找不到返回 null。 */
export function resolveCommand(command, options = {}) {
  if (!command) return null;
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const exists = options.exists || existsSync;
  const raw = String(command).trim();
  if (!raw) return null;

  if (isAbsolute(raw)) return exists(raw) ? raw : null;

  const extensions = platform === "win32"
    ? ["", ".exe", ".cmd", ".bat", ".ps1"]
    : [""];
  const sep = platform === process.platform ? delimiter : (platform === "win32" ? ";" : ":");
  const pathValue = String(env.PATH ?? env.Path ?? "");

  for (const directory of pathValue.split(sep)) {
    const dir = directory.trim();
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = resolve(dir, `${raw}${extension}`);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/** 命令是否可用：绝对路径查文件，裸名字查 PATH。 */
export function commandExists(command, options = {}) {
  return Boolean(resolveCommand(command, options));
}

/**
 * 按员工类型自动探测本机 CLI 可执行文件。
 * 优先级：Windows 下 Codex 优先 node + codex.js → PATH 查找 → 常见安装目录兜底。
 */
export function detectCliCommand(kind, options = {}) {
  const probe = CLI_PROBES[kind];
  if (!probe) {
    return { kind: String(kind || ""), found: false, command: null, argsPrefix: [], source: null };
  }

  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const home = options.homeDir || homedir();
  const exists = options.exists || existsSync;
  const execPath = options.execPath || process.execPath;

  if (typeof probe.nodeScripts === "function") {
    for (const script of probe.nodeScripts({ env, home, platform })) {
      if (script && exists(script)) {
        return { kind, found: true, command: execPath, argsPrefix: [script], source: "node-script" };
      }
    }
  }

  for (const name of probe.commands || []) {
    const resolved = resolveCommand(name, { env, platform, exists });
    if (resolved) {
      return { kind, found: true, command: resolved, argsPrefix: [], source: "path" };
    }
  }

  if (typeof probe.fallbackPaths === "function") {
    for (const candidate of probe.fallbackPaths({ env, home, platform })) {
      if (candidate && exists(candidate)) {
        return { kind, found: true, command: candidate, argsPrefix: [], source: "known-path" };
      }
    }
  }

  return { kind, found: false, command: null, argsPrefix: [], source: null };
}

/** 扫描本机全部已注册 CLI 的可用情况，供面板预填和后续一键初始化使用。 */
export function detectInstalledClis(options = {}) {
  const detected = {};
  for (const kind of Object.keys(CLI_PROBES)) {
    detected[kind] = detectCliCommand(kind, options);
  }
  return detected;
}

export function isDirectory(target) {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** 目录能不能写：不能只信 exists，真去试一下。 */
export function isWritableDirectory(target) {
  if (!isDirectory(target)) return false;
  try {
    accessSync(target, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function listDrives() {
  if (process.platform !== "win32") return [{ path: "/", label: "/" }];
  const drives = [];
  for (let code = 65; code <= 90; code += 1) {
    const path = `${String.fromCharCode(code)}:\\`;
    if (existsSync(path)) drives.push({ path, label: `${String.fromCharCode(code)}:` });
  }
  return drives;
}

/** 列子目录：只要文件夹，跳过 $ 开头的系统项和隐藏项，避免一屏垃圾。 */
export function listDirectories(target) {
  const entries = readdirSync(target, { withFileTypes: true });
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("$") || entry.name.startsWith(".")) continue;
    dirs.push({ name: entry.name, path: resolve(target, entry.name) });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  return dirs.slice(0, 500);
}

export function parentDirectory(target) {
  const resolved = resolve(target);
  const parent = resolve(resolved, "..");
  return parent === resolved ? null : parent;
}
