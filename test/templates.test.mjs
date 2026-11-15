import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TemplateStore } from "../src/templates-store.mjs";

function makeStore() {
  const directory = mkdtempSync(join(tmpdir(), "hub-tpl-"));
  const file = join(directory, "templates.json");
  return {
    file,
    directory,
    store: new TemplateStore(file).load(),
    reopen: () => new TemplateStore(file).load(),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test("新建模板、列出、持久化后还能读回", () => {
  const ctx = makeStore();
  try {
    const created = ctx.store.create({
      name: "小红书文案",
      prompt: "写 3 条小红书文案，每条不超过 200 字",
      workerId: "claude-main",
      cwd: "E:\\项目A",
    });
    assert.ok(created.id.startsWith("tpl_"));
    assert.equal(created.name, "小红书文案");
    assert.equal(created.workerId, "claude-main");

    assert.equal(ctx.store.list().length, 1);
    const reopened = ctx.reopen();
    assert.equal(reopened.list().length, 1);
    assert.equal(reopened.list()[0].prompt, "写 3 条小红书文案，每条不超过 200 字");
  } finally {
    ctx.cleanup();
  }
});

test("员工和目录是可选的：不填就不写这两个字段", () => {
  const ctx = makeStore();
  try {
    const created = ctx.store.create({ name: "临时活", prompt: "随便写点" });
    assert.equal(created.workerId, undefined);
    assert.equal(created.cwd, undefined);
  } finally {
    ctx.cleanup();
  }
});

test("名字或内容为空要报错，且错误信息是人话", () => {
  const ctx = makeStore();
  try {
    assert.throws(() => ctx.store.create({ name: "", prompt: "内容" }), /名字和内容都不能为空/);
    assert.throws(() => ctx.store.create({ name: "有名字", prompt: "   " }), /名字和内容都不能为空/);
  } finally {
    ctx.cleanup();
  }
});

test("重名要拦住，改名成别人的名字也要拦住", () => {
  const ctx = makeStore();
  try {
    ctx.store.create({ name: "审代码", prompt: "看一下这段代码" });
    assert.throws(() => ctx.store.create({ name: "审代码", prompt: "另一个" }), /已经有一个叫「审代码」/);

    const second = ctx.store.create({ name: "写文案", prompt: "写点东西" });
    assert.throws(() => ctx.store.update(second.id, { name: "审代码" }), /已经有一个叫「审代码」/);
    // 改成自己的名字不算重名
    const same = ctx.store.update(second.id, { name: "写文案", prompt: "改过的内容" });
    assert.equal(same.prompt, "改过的内容");
  } finally {
    ctx.cleanup();
  }
});

test("更新保留 id，删除后列表变短", () => {
  const ctx = makeStore();
  try {
    const created = ctx.store.create({ name: "整理资料", prompt: "整理成表格" });
    const updated = ctx.store.update(created.id, { name: "整理资料 v2" });
    assert.equal(updated.id, created.id);
    assert.equal(updated.name, "整理资料 v2");

    assert.equal(ctx.store.remove(created.id), true);
    assert.equal(ctx.store.list().length, 0);
    assert.throws(() => ctx.store.remove(created.id), /没有模板/);
  } finally {
    ctx.cleanup();
  }
});

test("路径里多余的重复分隔符会被合并，UNC 路径保持原样", () => {
  const ctx = makeStore();
  try {
    const messy = ctx.store.create({
      name: "双斜杠",
      prompt: "测试路径",
      cwd: "E://workPM//抖音下载开发",
    });
    assert.equal(messy.cwd, "E:/workPM/抖音下载开发");

    const unc = ctx.store.create({
      name: "网络盘",
      prompt: "测试 UNC",
      cwd: "\\\\server\\share\\项目",
    });
    assert.equal(unc.cwd, "\\\\server\\share\\项目");
  } finally {
    ctx.cleanup();
  }
});
