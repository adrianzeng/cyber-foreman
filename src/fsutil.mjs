import { existsSync, readdirSync, statSync, accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";

/** 命令是否可用：绝对路径查文件，裸名字查 PATH。 */
export function commandExists(command) {
  if (!command) return false;
  if (isAbsolute(command)) return existsSync(command);
  const extensions = process.platform === "win32"
    ? ["", ".exe", ".cmd", ".bat", ".ps1"]
    : [""];
  for (const directory of String(process.env.PATH || "").split(delimiter)) {
    for (const extension of extensions) {
      if (existsSync(resolve(directory, `${command}${extension}`))) return true;
    }
  }
  return false;
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
