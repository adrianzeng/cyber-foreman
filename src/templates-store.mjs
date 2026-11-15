import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * 任务模板：把常干的活存成一句话，下次点一下就填好。
 *
 * 一条硬规矩：**点击模板只填内容，不直接派发。**
 * 模板是起点不是终点——每次的素材、范围都会变，直接派出去容易跑偏。
 */

const MAX_TEMPLATES = 100;

function fail(message) {
  throw new Error(message);
}

function cleanText(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** 合并重复的路径分隔符；UNC 路径（\\server\share）原样保留。 */
function normalizePath(value) {
  const text = cleanText(value, 400);
  if (!text) return "";
  if (/^\\\\/.test(text)) return text;
  return text.replace(/([\\/])\1+/g, "$1");
}

function templateId() {
  return `tpl_${Date.now().toString(36)}_${randomBytes(2).toString("hex")}`;
}

export class TemplateStore {
  constructor(file) {
    this.file = file;
    this.templates = [];
  }

  load() {
    const data = readJson(this.file, null);
    if (data && Array.isArray(data.templates)) {
      this.templates = data.templates
        .map((item) => this.#normalize(item, { keepId: true }))
        .filter(Boolean);
    }
    return this;
  }

  #normalize(input, { keepId = false } = {}) {
    if (!input || typeof input !== "object") return null;
    const name = cleanText(input.name, 30);
    const prompt = cleanText(input.prompt, 20_000);
    if (!name || !prompt) return null;
    const template = {
      id: keepId && input.id ? String(input.id) : templateId(),
      name,
      prompt,
    };
    // 员工和目录是可选的：不填就跟着派活区当前选择走。
    const workerId = cleanText(input.workerId, 60);
    if (workerId) template.workerId = workerId;
    const cwd = normalizePath(input.cwd);
    if (cwd) template.cwd = cwd;
    return template;
  }

  persist() {
    mkdirSync(dirname(this.file), { recursive: true });
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      templates: this.templates,
    };
    if (existsSync(this.file)) {
      try {
        copyFileSync(this.file, `${this.file}.bak`);
      } catch {
        // 备份失败不影响写入。
      }
    }
    const temporary = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    renameSync(temporary, this.file);
  }

  list() {
    return structuredClone(this.templates);
  }

  get(id) {
    const found = this.templates.find((item) => item.id === id);
    return found ? structuredClone(found) : null;
  }

  create(input) {
    if (this.templates.length >= MAX_TEMPLATES) fail(`模板数量上限是 ${MAX_TEMPLATES} 个`);
    const template = this.#normalize(input);
    if (!template) fail("模板名字和内容都不能为空");
    if (this.templates.some((item) => item.name === template.name)) {
      fail(`已经有一个叫「${template.name}」的模板了，换个名字`);
    }
    this.templates.push(template);
    this.persist();
    return structuredClone(template);
  }

  update(id, patch) {
    const index = this.templates.findIndex((item) => item.id === id);
    if (index < 0) fail(`没有模板 ${id}`);
    const merged = { ...this.templates[index], ...patch, id };
    const template = this.#normalize(merged, { keepId: true });
    if (!template) fail("模板名字和内容都不能为空");
    if (this.templates.some((item, at) => at !== index && item.name === template.name)) {
      fail(`已经有一个叫「${template.name}」的模板了，换个名字`);
    }
    this.templates[index] = template;
    this.persist();
    return structuredClone(template);
  }

  remove(id) {
    const index = this.templates.findIndex((item) => item.id === id);
    if (index < 0) fail(`没有模板 ${id}`);
    this.templates.splice(index, 1);
    this.persist();
    return true;
  }
}
