import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHubServer } from "../src/server.mjs";
import { WorkerStore } from "../src/workers-store.mjs";

const FAKE_CLAUDE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
const ROOT = fileURLToPath(new URL("..", import.meta.url));

async function startHub(existingDirectory = null) {
  const directory = existingDirectory || mkdtempSync(join(tmpdir(), "agent-hub-workers-"));
  const workspace = join(directory, "项目A");
  mkdirSync(workspace, { recursive: true });

  const config = {
    port: 0,
    dataDir: join(directory, "data"),
    workers: {
      "claude-main": {
        name: "Fake Claude",
        kind: "claude-cli",
        command: process.execPath,
        argsPrefix: [FAKE_CLAUDE],
        cwd: ROOT,
        permissionMode: "acceptEdits",
      },
    },
  };

  const ctx = await createHubServer({ config });
  await new Promise((resolve, reject) => {
    ctx.server.once("error", reject);
    ctx.server.listen(0, "127.0.0.1", resolve);
  });
  const base = `http://127.0.0.1:${ctx.server.address().port}`;

  const request = async (path, { method = "GET", body } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, data };
  };

  return {
    ...ctx,
    directory,
    workspace,
    request,
    close: async () => {
      await ctx.hub.stopAll();
      await new Promise((resolve) => ctx.server.close(resolve));
    },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test("新建员工：立刻生效、写进数据目录、能直接派活", async () => {
  const ctx = await startHub();
  try {
    const created = await ctx.request("/api/workers", {
      method: "POST",
      body: { name: "文案员工", kind: "claude-cli", cwd: ctx.workspace, permissionMode: "plan" },
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.worker.name, "文案员工");
    assert.equal(created.data.worker.cwd, ctx.workspace);
    assert.equal(created.data.worker.permissionMode, "plan");
    assert.equal(created.data.worker.retryMaxAttempts, 3);
    assert.equal(created.data.worker.available, true);

    const list = await ctx.request("/api/workers");
    assert.equal(list.data.workers.length, 2);

    const saved = JSON.parse(readFileSync(join(ctx.config.dataDir, "workers.json"), "utf8"));
    assert.equal(Object.keys(saved.workers).length, 2, "员工应该写进 data/workers.json");

    // 热加载：不重启进程就能派活。
    const task = await ctx.request("/api/tasks", {
      method: "POST",
      body: { workerId: created.data.worker.id, prompt: "第一个任务：新员工跑一下" },
    });
    assert.equal(task.status, 202);
    const done = await ctx.request(`/api/tasks/${task.data.task.id}/wait`, {
      method: "POST",
      body: { timeoutSeconds: 8 },
    });
    assert.equal(done.data.task.status, "completed");
    assert.equal(done.data.task.cwd, ctx.workspace, "任务应该在新员工的项目目录里跑");
  } finally {
    await ctx.close();
    ctx.cleanup();
  }
});

test("新建员工：校验错误要说人话", async () => {
  const ctx = await startHub();
  try {
    const cases = [
      [{ name: "", kind: "claude-cli", cwd: ctx.workspace }, /名字不能为空/],
      [{ name: "相对路径", kind: "claude-cli", cwd: "项目A" }, /绝对路径/],
      [{ name: "不存在", kind: "claude-cli", cwd: join(ctx.workspace, "没有这个目录") }, /这个目录不存在/],
      [{ name: "怪类型", kind: "no-such-cli", cwd: ctx.workspace }, /不支持的员工类型/],
      [{ name: "空目录", kind: "claude-cli", cwd: "" }, /项目目录不能为空/],
    ];
    for (const [body, pattern] of cases) {
      const response = await ctx.request("/api/workers", { method: "POST", body });
      assert.equal(response.status, 400, `应该被拒绝：${JSON.stringify(body)}`);
      assert.match(response.data.error, pattern);
    }

    const ok = { name: "重名员工", kind: "claude-cli", cwd: ctx.workspace };
    assert.equal((await ctx.request("/api/workers", { method: "POST", body: ok })).status, 201);
    const duplicate = await ctx.request("/api/workers", { method: "POST", body: ok });
    assert.equal(duplicate.status, 400);
    assert.match(duplicate.data.error, /已经有一个叫/);

    // 同名但不同项目目录是允许的。
    const other = join(ctx.directory, "项目B");
    mkdirSync(other);
    const sameName = await ctx.request("/api/workers", {
      method: "POST",
      body: { ...ok, cwd: other },
    });
    assert.equal(sameName.status, 201);
  } finally {
    await ctx.close();
    ctx.cleanup();
  }
});

test("停用、启用、删除员工，以及删除守卫", async () => {
  const ctx = await startHub();
  try {
    const created = await ctx.request("/api/workers", {
      method: "POST",
      body: { name: "临时员工", kind: "claude-cli", cwd: ctx.workspace },
    });
    const id = created.data.worker.id;

    const disabled = await ctx.request(`/api/workers/${id}`, { method: "PUT", body: { disabled: true } });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.data.worker.enabled, false);

    const blocked = await ctx.request("/api/tasks", {
      method: "POST",
      body: { workerId: id, prompt: "停用的员工不该接活" },
    });
    assert.equal(blocked.status, 400);
    assert.match(blocked.data.error, /已停用/);

    const enabled = await ctx.request(`/api/workers/${id}`, { method: "PUT", body: { disabled: false } });
    assert.equal(enabled.data.worker.enabled, true);

    const removed = await ctx.request(`/api/workers/${id}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    const list = await ctx.request("/api/workers");
    assert.equal(list.data.workers.length, 1);

    const missing = await ctx.request(`/api/workers/${id}`, { method: "DELETE" });
    assert.equal(missing.status, 400);
  } finally {
    await ctx.close();
    ctx.cleanup();
  }
});

test("目录接口：列盘、列目录、新建文件夹、状态检查", async () => {
  const ctx = await startHub();
  try {
    const drives = await ctx.request("/api/fs/drives");
    assert.equal(drives.status, 200);
    assert.ok(drives.data.drives.length >= 1);

    const listed = await ctx.request(`/api/fs/list?path=${encodeURIComponent(ctx.directory)}`);
    assert.equal(listed.status, 200);
    assert.ok(listed.data.dirs.some((dir) => dir.name === "项目A"));
    assert.ok(listed.data.parent);

    const made = await ctx.request("/api/fs/mkdir", {
      method: "POST",
      body: { parent: ctx.directory, name: "项目B" },
    });
    assert.equal(made.status, 200);
    assert.ok(existsSync(made.data.path));

    const stat = await ctx.request(`/api/fs/stat?path=${encodeURIComponent(made.data.path)}`);
    assert.equal(stat.data.exists, true);
    assert.equal(stat.data.isDirectory, true);

    const badName = await ctx.request("/api/fs/mkdir", {
      method: "POST",
      body: { parent: ctx.directory, name: "a/b" },
    });
    assert.equal(badName.status, 400);
    assert.match(badName.data.error, /不能包含/);

    const missing = await ctx.request(`/api/fs/list?path=${encodeURIComponent(join(ctx.directory, "没有"))}`);
    assert.equal(missing.status, 400);
  } finally {
    await ctx.close();
    ctx.cleanup();
  }
});

test("配置分层：第二次启动读 data/workers.json，不被种子覆盖", async () => {
  const first = await startHub();
  let directory = "";
  try {
    directory = first.directory;
    const created = await first.request("/api/workers", {
      method: "POST",
      body: { name: "留下的人", kind: "claude-cli", cwd: first.workspace },
    });
    assert.equal(created.status, 201);
    await first.close();

    const second = await startHub(directory);
    try {
      const list = await second.request("/api/workers");
      assert.equal(list.data.workers.length, 2, "应读回面板加的员工，而不是回到种子");
      assert.ok(list.data.workers.some((worker) => worker.name === "留下的人"));
    } finally {
      await second.close();
    }
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

test("换员工类型时启动命令必须跟着换，不能留下上一种类型的裸 node", () => {
  const directory = mkdtempSync(join(tmpdir(), "hub-kind-"));
  const file = join(directory, "workers.json");
  const CLAUDE_BIN = process.platform === "win32" ? "C://Windows//System32//cmd.exe" : "/bin/sh";

  const base = {
    cwd: directory,
    addDirs: [],
    model: "",
    effort: "",
    disabled: false,
    note: "",
  };

  const store = new WorkerStore({ file, seed: {} });
  store.workers = {
    "claude-main": { ...base, id: "claude-main", name: "Claude", kind: "claude-cli", command: CLAUDE_BIN, argsPrefix: [], permissionMode: "acceptEdits" },
    "codex-main": { ...base, id: "codex-main", name: "Codex", kind: "codex-cli", command: process.execPath, argsPrefix: ["codex.js"], permissionMode: "workspace-write", autoApprove: true },
  };

  try {
    // 误配：Claude 员工却用了 codex 那套裸 node，应自动修成同类员工能用的命令。
    const stray = store.create({
      name: "误配员工",
      kind: "claude-cli",
      cwd: directory,
      permissionMode: "acceptEdits",
      command: process.execPath,
      argsPrefix: [],
    });
    assert.equal(stray.command, CLAUDE_BIN);
    assert.deepEqual(stray.argsPrefix, []);

    // 正常新建 Codex 员工：带 --json 入口脚本。
    const codex = store.create({ name: "Codex 二号", kind: "codex-cli", cwd: directory, permissionMode: "workspace-write" });
    assert.equal(codex.command, process.execPath);
    assert.deepEqual(codex.argsPrefix, ["codex.js"]);

    // 直接把它改成 Claude：命令必须换掉，否者面板显示可用、一派活就失败。
    const converted = store.update(codex.id, { kind: "claude-cli" });
    assert.equal(converted.command, CLAUDE_BIN);
    assert.deepEqual(converted.argsPrefix, []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
