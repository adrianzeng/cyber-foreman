import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_PROBES, detectCliCommand, detectInstalledClis, resolveCommand } from "../src/fsutil.mjs";
import { WorkerStore } from "../src/workers-store.mjs";
import { createHubServer } from "../src/server.mjs";

test("CLI_PROBES 包含 claude / codex / agy，支持 PATH 与已知目录自动探测", () => {
  assert.ok(CLI_PROBES["claude-cli"]);
  assert.ok(CLI_PROBES["codex-cli"]);
  assert.ok(CLI_PROBES["agy-cli"]);

  const fakeDir = mkdtempSync(join(tmpdir(), "agent-hub-probe-"));
  try {
    const agyExe = join(fakeDir, "agy.exe");
    writeFileSync(agyExe, "", "utf8");

    // 1. 命中 PATH
    const viaPath = detectCliCommand("agy-cli", {
      platform: "win32",
      env: { PATH: fakeDir },
      homeDir: fakeDir,
    });
    assert.equal(viaPath.found, true);
    assert.equal(viaPath.source, "path");
    assert.equal(viaPath.command, agyExe);

    // 2. 不在 PATH 时，命中 Windows 常见安装路径 %LOCALAPPDATA%\agy\bin\agy.exe
    const knownPath = join("C:\\FakeLocalAppData", "agy", "bin", "agy.exe");
    const viaFallback = detectCliCommand("agy-cli", {
      platform: "win32",
      env: { PATH: "", LOCALAPPDATA: "C:\\FakeLocalAppData" },
      homeDir: "C:\\FakeHome",
      exists: (target) => target === knownPath,
    });
    assert.equal(viaFallback.found, true);
    assert.equal(viaFallback.source, "known-path");
    assert.equal(viaFallback.command, knownPath);

    // 3. 本机未安装时清晰返回 found: false
    const missing = detectCliCommand("agy-cli", {
      platform: "win32",
      env: { PATH: "", LOCALAPPDATA: "C:\\NoSuchDir" },
      homeDir: "C:\\NoSuchHome",
      exists: () => false,
    });
    assert.equal(missing.found, false);
    assert.equal(missing.command, null);

    // 4. resolveCommand 与 detectInstalledClis
    assert.equal(resolveCommand("agy", { platform: "win32", env: { PATH: fakeDir } }), agyExe);
    const all = detectInstalledClis({
      platform: "win32",
      env: { PATH: fakeDir, LOCALAPPDATA: "C:\\NoSuchDir", APPDATA: "C:\\NoSuchDir" },
      homeDir: "C:\\NoSuchHome",
    });
    assert.equal(all["agy-cli"].found, true);
    assert.equal(all["claude-cli"].found, false);
  } finally {
    rmSync(fakeDir, { recursive: true, force: true });
  }
});

test("WorkerStore：检测到 agy 时默认启用，/api/adapters 返回 agy 探测元数据", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-hub-agy-seed-"));
  try {
    const agySeed = {
      "agy-main": {
        name: "Antigravity 员工",
        kind: "agy-cli",
        command: process.execPath,
        cwd: dir,
        permissionMode: "accept-edits",
      },
    };
    const store = new WorkerStore({ file: join(dir, "workers.json"), seed: agySeed }).load();
    assert.equal(store.get("agy-main").disabled, false, "检测到可执行文件时 agy 默认启用");

    // 若种子命令不存在且本机也未安装，normalizeAll 应优雅保持 disabled: true
    const missingSeed = {
      "agy-missing": {
        name: "不存在的 Antigravity",
        kind: "agy-cli",
        command: join(dir, "no-such-agy.exe"),
        cwd: dir,
        permissionMode: "accept-edits",
      },
    };
    const store2 = new WorkerStore({ file: join(dir, "workers2.json"), seed: missingSeed }).load();
    assert.equal(store2.get("agy-missing").disabled, true);

    // /api/adapters 返回 agy-cli 的 defaultCommand 与 detected 对象
    const ctx = await createHubServer({
      config: { port: 0, dataDir: join(dir, "data"), workers: agySeed },
      channels: false,
    });
    try {
      await new Promise((resolve, reject) => {
        ctx.server.once("error", reject);
        ctx.server.listen(0, "127.0.0.1", resolve);
      });
      const base = `http://127.0.0.1:${ctx.server.address().port}`;
      const res = await fetch(`${base}/api/adapters`).then((r) => r.json());
      const agy = res.adapters.find((item) => item.kind === "agy-cli");
      assert.ok(agy);
      assert.equal(agy.defaultCommand, "agy");
      assert.equal(typeof agy.detected.found, "boolean");
    } finally {
      await ctx.hub.stopAll();
      await new Promise((resolve) => ctx.server.close(resolve));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
