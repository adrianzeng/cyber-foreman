import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import {
  DEFAULT_PORT,
  defaultDataDir,
  helpText,
  parse,
  pickPort,
  resolveDataDir,
} from "../src/cli-options.mjs";
import { isLoopbackHost, loadConfig } from "../src/config.mjs";

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function listenOnce(port = 0) {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolvePromise(server));
  });
}

test("端口优先级：命令行 > 环境变量 > 配置文件 > 默认", () => {
  assert.equal(parse(["--port", "5001"], { AGENT_HUB_PORT: "5002" }, { port: 5003 }).port, 5001);
  assert.equal(parse([], { AGENT_HUB_PORT: "5002" }, { port: 5003 }).port, 5002);
  assert.equal(parse([], {}, { port: 5003 }).port, 5003);
  assert.equal(parse([], {}, {}).port, DEFAULT_PORT);
  assert.equal(parse(["--port", "0"], {}, {}).port, 0);
});

test("端口写错时给出中文提示，不抛异常", () => {
  const bad = parse(["--port", "70000"], {}, {});
  assert.equal(bad.ok, false);
  assert.match(bad.error, /端口/);
  const garbage = parse(["--port", "abc"], {}, {});
  assert.equal(garbage.ok, false);
  const unknown = parse(["--nope"], {}, {});
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /参数不对/);
});

test("地址优先级与 --no-channels / --open 开关", () => {
  assert.equal(parse(["--host", "0.0.0.0"], { AGENT_HUB_HOST: "10.0.0.1" }, {}).host, "0.0.0.0");
  assert.equal(parse([], { AGENT_HUB_HOST: "10.0.0.1" }, { host: "192.168.0.2" }).host, "10.0.0.1");
  assert.equal(parse([], {}, { host: "192.168.0.2" }).host, "192.168.0.2");
  assert.equal(parse([], {}, {}).host, "127.0.0.1");
  assert.equal(parse(["--no-channels"], {}, {}).channels, false);
  assert.equal(parse([], {}, {}).channels, true);
  assert.equal(parse(["--open"], {}, {}).open, true);
});

test("数据目录优先级：命令行 > 环境变量 > 配置文件 > 探测 ./data > 平台默认", () => {
  const directory = tempDir("agent-hub-datadir-");
  const cwd = join(directory, "work");
  mkdirSync(cwd, { recursive: true });
  try {
    assert.equal(
      resolveDataDir({ cli: "a", env: "b", configDataDir: "c", cwd }),
      resolve(cwd, "a"),
    );
    assert.equal(resolveDataDir({ env: "b", configDataDir: "c", cwd }), resolve(cwd, "b"));
    assert.equal(resolveDataDir({ configDataDir: "./data", cwd }), resolve(cwd, "data"));

    // 探测：cwd/data 里有 tasks 目录就沿用
    mkdirSync(join(cwd, "data", "tasks"), { recursive: true });
    assert.equal(resolveDataDir({ cwd, platform: "linux", envVars: {} }), join(cwd, "data"));

    // 探测不到才走平台默认
    const empty = join(directory, "empty");
    mkdirSync(empty, { recursive: true });
    const linuxDefault = resolveDataDir({
      cwd: empty,
      platform: "linux",
      homeDir: "/home/tester",
      envVars: {},
    });
    assert.equal(linuxDefault, join("/home/tester", ".local", "share", "dsh-agent-hub", "data"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("平台默认数据目录三种系统都对", () => {
  assert.equal(
    defaultDataDir({ platform: "win32", homeDir: "C:\\Users\\t", envVars: { LOCALAPPDATA: "C:\\Users\\t\\AppData\\Local" } }),
    join("C:\\Users\\t\\AppData\\Local", "dsh-agent-hub", "data"),
  );
  assert.equal(
    defaultDataDir({ platform: "darwin", homeDir: "/Users/t", envVars: {} }),
    join("/Users/t", "Library", "Application Support", "dsh-agent-hub", "data"),
  );
  assert.equal(
    defaultDataDir({ platform: "linux", homeDir: "/home/t", envVars: { XDG_DATA_HOME: "/xdg" } }),
    join("/xdg", "dsh-agent-hub", "data"),
  );
});

test("端口被占用时自动往后 +1", async () => {
  const server = await listenOnce(0);
  const taken = server.address().port;
  try {
    const picked = await pickPort(taken);
    assert.equal(picked, taken + 1);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});

test("--port 0 直接交给系统分配，不做探测", async () => {
  assert.equal(await pickPort(0), 0);
});

test("loadConfig 装配配置文件、员工与 allowlist，非回环地址给警告", () => {
  const directory = tempDir("agent-hub-config-");
  const configFile = join(directory, "hub.json");
  writeFileSync(configFile, JSON.stringify({
    port: 4800,
    dataDir: "./mydata",
    allowedHosts: ["127.0.0.1", "192.168.1.9"],
    workers: { "claude-1": { name: "Claude", kind: "claude-cli", command: "claude", cwd: directory } },
  }), "utf8");
  try {
    const config = loadConfig({ configFile, env: {}, cwd: directory });
    assert.equal(config.port, 4800);
    assert.equal(config.dataDir, join(directory, "mydata"));
    assert.deepEqual(config.allowedHosts, ["127.0.0.1", "192.168.1.9"]);
    assert.equal(config.allowAnyHost, false);
    assert.ok(config.workers["claude-1"]);
    assert.equal(config.warning, null);
    assert.equal(config.channelsEnabled, true);

    // 显式配了 allowedHosts 就严格按它来，即使绑到 0.0.0.0 也不放开
    const strict = loadConfig({ configFile, env: {}, cwd: directory, host: "0.0.0.0" });
    assert.equal(strict.allowAnyHost, false);
    assert.equal(strict.warning, null);

    // 没配 allowedHosts 又绑非回环地址 → 放开并警告（否则用户访问会被自己的 403 挡住）
    const openFile = join(directory, "open.json");
    writeFileSync(openFile, JSON.stringify({ port: 4801 }), "utf8");
    const open = loadConfig({ configFile: openFile, env: {}, cwd: directory, host: "0.0.0.0" });
    assert.equal(open.allowAnyHost, true);
    assert.match(open.warning, /局域网/);

    const noChannels = loadConfig({ configFile, env: {}, cwd: directory, channelsEnabled: false });
    assert.equal(noChannels.channelsEnabled, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("显式指定的配置文件不存在时要报错，默认文件不存在则安静降级", () => {
  const directory = tempDir("agent-hub-config-missing-");
  try {
    assert.throws(
      () => loadConfig({ configFile: join(directory, "nope.json"), env: {}, cwd: directory }),
      /文件不存在/,
    );
    mkdirSync(join(directory, "data", "tasks"), { recursive: true });
    const config = loadConfig({ env: {}, cwd: directory, platform: "linux", homeDir: directory });
    assert.equal(config.dataDir, join(directory, "data"));
    assert.deepEqual(config.workers, {});
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("回环判定与帮助文案", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("LOCALHOST"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("[::1]"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.equal(isLoopbackHost("192.168.1.9"), false);
  assert.equal(isLoopbackHost(""), false);

  const help = helpText("0.7.0");
  assert.match(help, /0\.7\.0/);
  assert.match(help, /--data-dir/);
  assert.match(help, /--no-channels/);
  assert.match(help, /环境变量/);
});
