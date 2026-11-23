import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadConfig } from "../src/config.mjs";
import { createHubServer } from "../src/server.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_BIN = fileURLToPath(new URL("../bin/cyber-foreman.mjs", import.meta.url));
const LEGACY_CLI_BIN = fileURLToPath(new URL("../bin/dsh-agent-hub.mjs", import.meta.url));
const MCP_BIN = fileURLToPath(new URL("../bin/cyber-foreman-mcp.mjs", import.meta.url));
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

test("v1.0.0 命令行入口：cyber-foreman 与兼容别名 dsh-agent-hub 均正常输出版本与帮助", () => {
  assert.equal(PKG.name, "cyber-foreman");
  assert.equal(PKG.version, "1.0.0");
  assert.notEqual(PKG.private, true);

  const help = execFileSync(process.execPath, [CLI_BIN, "--help"], { encoding: "utf8" });
  assert.match(help, /CyberForeman（赛博包工头） v1\.0\.0/);
  assert.match(help, /npx cyber-foreman/);
  assert.match(help, /npx cyber-foreman-mcp/);

  const ver = execFileSync(process.execPath, [CLI_BIN, "--version"], { encoding: "utf8" }).trim();
  assert.equal(ver, "1.0.0");

  const legacyVer = execFileSync(process.execPath, [LEGACY_CLI_BIN, "--version"], { encoding: "utf8" }).trim();
  assert.equal(legacyVer, "1.0.0");
});

test("v1.0.0 MCP 入口 bin/cyber-foreman-mcp.mjs 支持 CYBER_FOREMAN_URL 并完整响应 STDIO 请求", async () => {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/workers") {
      const payload = JSON.stringify({
        workers: [
          {
            id: "claude-main",
            name: "Claude 主员工",
            kind: "claude-cli",
            kindLabel: "Claude",
            enabled: true,
            available: true,
            cwd: ROOT,
            activeTaskId: null,
            queued: 0,
            steerable: true,
          },
        ],
      });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(payload);
      return;
    }
    res.writeHead(404).end("{}");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, CYBER_FOREMAN_URL: baseUrl };
  delete env.DSH_HUB_URL;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_BIN],
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "cyber-foreman-v1-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 5);
    const res = await client.callTool({ name: "list_workers", arguments: {} });
    assert.notEqual(res.isError, true);
    const data = JSON.parse(res.content[0].text);
    assert.equal(data.hubUrl, baseUrl);
    assert.equal(data.total, 1);
    assert.equal(data.workers[0].id, "claude-main");
  } finally {
    await client.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
});

test("v1.0.0 全新空目录零配置启动：不依赖 config/workers.json，零报错并完整提供 5 适配器与 5 通道", async () => {
  const freshDir = mkdtempSync(join(tmpdir(), "cyber-foreman-fresh-"));
  const dataDir = join(freshDir, "data");
  const config = loadConfig({
    env: {},
    cwd: freshDir,
    dataDir,
    channelsEnabled: false,
  });

  const ctx = await createHubServer({ config, channels: false });
  await new Promise((resolve, reject) => {
    ctx.server.once("error", reject);
    ctx.server.listen(0, "127.0.0.1", resolve);
  });
  const base = `http://127.0.0.1:${ctx.server.address().port}`;

  try {
    const html = await fetch(`${base}/`).then((r) => r.text());
    assert.match(html, /CyberForeman · 赛博包工头/);

    const health = await fetch(`${base}/api/health`).then((r) => r.json());
    assert.equal(health.version, "1.0.0");

    const adapters = await fetch(`${base}/api/adapters`).then((r) => r.json());
    const kinds = adapters.adapters.map((a) => a.kind);
    for (const expected of ["claude-cli", "codex-cli", "agy-cli", "kimi-cli", "doubao-cli"]) {
      assert.ok(kinds.includes(expected), `应包含适配器 ${expected}`);
    }

    const channels = await fetch(`${base}/api/channels`).then((r) => r.json());
    assert.deepEqual(
      channels.channels.map((c) => c.id),
      ["telegram", "feishu", "qq", "wecom", "wechat"],
    );
  } finally {
    await ctx.hub.stopAll();
    await new Promise((resolve) => ctx.server.close(resolve));
    rmSync(freshDir, { recursive: true, force: true });
  }
});
