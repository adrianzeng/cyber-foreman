import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHubServer } from "../src/server.mjs";

/**
 * Host / Origin 校验的回归闸门。
 *
 * 这条守的是最危险的场景：绑在 0.0.0.0 或默认配置被改坏后，
 * 局域网里任何人都能打开面板、派活、让 CLI 在他机器上执行命令。
 * 默认配置（127.0.0.1 + 不配 allowedHosts）必须只认回环。
 */

function rawGet(port, path, headers) {
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolvePromise({ status: response.statusCode, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

test("默认配置：非回环 Host / 跨站 Origin 一律 403", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-hub-host-guard-"));
  const config = { port: 0, dataDir: join(directory, "data"), workers: {} };
  const context = await createHubServer({ config, logger: { warn() {}, error() {}, log() {} } });
  try {
    await new Promise((resolvePromise, reject) => {
      context.server.once("error", reject);
      context.server.listen(0, "127.0.0.1", resolvePromise);
    });
    const port = context.server.address().port;

    const loopbackIp = await rawGet(port, "/api/health", { Host: `127.0.0.1:${port}` });
    assert.equal(loopbackIp.status, 200, "本机 IP 必须放行");

    const localhost = await rawGet(port, "/api/health", { Host: `localhost:${port}` });
    assert.equal(localhost.status, 200, "localhost 必须放行");

    const lan = await rawGet(port, "/api/health", { Host: `192.168.1.9:${port}` });
    assert.equal(lan.status, 403, "局域网 Host 必须被挡住");
    assert.match(lan.body, /只接受本机访问/);

    const publicHost = await rawGet(port, "/api/health", { Host: `hub.example.com:${port}` });
    assert.equal(publicHost.status, 403, "公网域名 Host 必须被挡住");

    const lanOrigin = await rawGet(port, "/api/tasks", {
      Host: `127.0.0.1:${port}`,
      Origin: "http://192.168.1.9:4647",
    });
    assert.equal(lanOrigin.status, 403, "跨站 Origin 必须被挡住");
    assert.match(lanOrigin.body, /来源/);

    // 通道接口同样受这层保护，不能成为绕过口
    const lanChannels = await rawGet(port, "/api/channels", { Host: `10.0.0.5:${port}` });
    assert.equal(lanChannels.status, 403);
  } finally {
    await context.channelManager.stopAll();
    await context.hub.stopAll();
    await new Promise((resolvePromise) => context.server.close(resolvePromise));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("默认配置的健康检查带的是本机地址语义，没有 allowAnyHost 警告", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-hub-host-guard2-"));
  const config = { port: 0, dataDir: join(directory, "data"), workers: {} };
  const context = await createHubServer({ config, logger: { warn() {}, error() {}, log() {} } });
  try {
    await new Promise((resolvePromise, reject) => {
      context.server.once("error", reject);
      context.server.listen(0, "127.0.0.1", resolvePromise);
    });
    const port = context.server.address().port;
    const health = await rawGet(port, "/api/health", { Host: `127.0.0.1:${port}` });
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body).warning, undefined, "默认配置不该出现「局域网可访问」警告");
  } finally {
    await context.channelManager.stopAll();
    await context.hub.stopAll();
    await new Promise((resolvePromise) => context.server.close(resolvePromise));
    rmSync(directory, { recursive: true, force: true });
  }
});
