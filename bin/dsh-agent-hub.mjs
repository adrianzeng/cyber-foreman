#!/usr/bin/env node
/**
 * npx / npm bin 入口。
 *
 * 这里只做三件事：解析参数 → 装配配置 → 启动服务。
 * 所有"东西放哪"的判断都在 cli-options.mjs / config.mjs 里，方便单测。
 */
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { helpText, parse, pickPort } from "../src/cli-options.mjs";
import { loadConfig } from "../src/config.mjs";
import { startServer } from "../src/server.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));

function openInBrowser(url) {
  const command = process.platform === "win32"
    ? "explorer.exe"
    : process.platform === "darwin" ? "open" : "xdg-open";
  try {
    const child = spawn(command, [url], { detached: true, stdio: "ignore" });
    child.on("error", () => { /* 打不开浏览器不影响服务 */ });
    child.unref();
  } catch {
    // 同上。
  }
}

async function main() {
  const cli = parse(process.argv.slice(2), process.env, {}, { cwd: process.cwd() });
  if (!cli.ok) {
    console.error(cli.error);
    process.exitCode = 2;
    return;
  }
  if (cli.help) {
    console.log(helpText(PACKAGE.version));
    return;
  }
  if (cli.version) {
    console.log(PACKAGE.version);
    return;
  }

  let config;
  try {
    config = loadConfig({ cli, env: process.env, cwd: process.cwd(), channelsEnabled: cli.channels });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
    return;
  }

  let port;
  try {
    port = await pickPort(config.port, { host: config.host });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
    return;
  }
  if (port !== config.port) console.log(`端口 ${config.port} 被占用，改用 ${port}`);

  const started = await startServer(config, { port, host: config.host });
  if (cli.open) openInBrowser(`http://127.0.0.1:${started.port}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
