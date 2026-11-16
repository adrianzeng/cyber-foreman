/**
 * 工作台：左栏（项目与员工）+ 中栏（派活 + 任务流）+ 右栏（任务详情）。
 *
 * 改造原则：
 *   - 现有功能一个不丢（员工增删改启停、模板、用量、四阶段筛选、停止/重派/已处理/复制/打开目录）；
 *   - 视觉从「大卡片」压成「行」，一屏至少 12 条任务；
 *   - 详情里结果常显、进度默认折叠，长路径中间省略；
 *   - 派活表单、员工表单、目录选择器逻辑保持原样，只换位置和排版。
 */

import {
  $,
  STAGE_ORDER,
  STAGE_TEXT,
  STATUS_TEXT,
  actions,
  adapterOf,
  api,
  baseName,
  button,
  copyText,
  duration,
  el,
  formatTime,
  formatTokens,
  isSide,
  middleEllipsis,
  setFormNote,
  shortTime,
  showModal,
  softApi,
  stageOf,
  state,
  toast,
  usageText,
  workerById,
  workerName,
} from "./panel-common.js";
import { renderTalk } from "./panel-talk.js";

/* ---------------- 员工相关的展示判定 ---------------- */

function workerBadge(worker) {
  if (!worker.enabled) return { text: "停用", cls: "bad" };
  if (!worker.available) return { text: "命令不可用", cls: "bad" };
  if (worker.activeTaskId) return { text: "执行中", cls: "busy" };
  if (worker.queued > 0) return { text: `排队 ${worker.queued}`, cls: "busy" };
  return { text: "待命", cls: "ok" };
}

/** 悬停时一口气看到这个员工的全部信息（原来的员工卡内容都在这里）。 */
function workerTitle(worker) {
  const lines = [
    `${worker.name}（${worker.kindLabel || worker.kind}）`,
    `目录：${worker.cwd || "—"}`,
    `权限：${worker.permissionMode} · 排队 ${worker.queued} · 重试 ${worker.retryMaxAttempts} 次`,
  ];
  if (worker.effectiveModel) {
    lines.push(`模型：${worker.effectiveModel}（${worker.modelSource === "worker" ? "员工指定" : "路由配置"}）`);
  } else {
    lines.push("模型：未读到（路由没配，或 CLI 配置读不到）");
  }
  if (worker.maxBudgetUsd) lines.push(`单任务上限 $${worker.maxBudgetUsd}`);
  if (worker.extraDirs?.length) lines.push(`附加目录：${worker.extraDirs.join("；")}`);
  if (worker.note) lines.push(`备注：${worker.note}`);
  const today = worker.today;
  if (today && Number(today.tasks) > 0) {
    lines.push(`今天 ${today.tasks} 个任务，完成 ${today.completed}，输出 ${formatTokens(today.outputTokens)}`);
  }
  lines.push(worker.hasSession ? "有对话记忆" : "没有对话记忆");
  return lines.join("\n");
}

function groupByProject(workers) {
  const groups = new Map();
  for (const worker of workers) {
    const key = worker.cwd || "（未设置目录）";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(worker);
  }
  return [...groups.entries()]
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]), "zh-CN"))
    .map(([path, list]) => ({
      path,
      list: list.slice().sort((a, b) => String(a.name).localeCompare(String(b.name), "zh-CN")),
    }));
}

async function openFolder(path) {
  if (!path) return;
  const result = await softApi("/api/open-folder", { method: "POST", body: JSON.stringify({ path }) });
  if (!result.ok) setFormNote(`打不开目录：${result.error?.message || ""}`, "error");
}

/* ---------------- 顶部状态字 ---------------- */

export function renderStatusline() {
  const line = $("statusline");
  if (!line) return;
  line.classList.toggle("expanded", Boolean(state.statusExpanded));

  const counts = state.overview?.counts?.stages || {};
  const map = {
    running: $("stage-running"),
    waiting: $("stage-waiting"),
    queued: $("stage-queued"),
    done: $("stage-done"),
  };
  for (const stage of STAGE_ORDER) {
    if (map[stage]) map[stage].textContent = String(counts[stage] ?? 0);
  }

  for (const chip of line.querySelectorAll(".sc")) {
    chip.classList.toggle("active", chip.dataset.stage === state.stage);
  }

  const expand = $("status-expand");
  if (expand) {
    expand.textContent = state.statusExpanded ? "▴" : "▾";
    expand.title = state.statusExpanded ? "收起说明" : "展开每项是什么意思";
  }

  const clear = $("clear-filter");
  if (clear) clear.hidden = !state.stage;

  const showSide = $("show-side");
  if (showSide && showSide.checked !== state.showSide) showSide.checked = state.showSide;

  const scope = $("list-scope");
  if (scope) scope.textContent = STAGE_TEXT[state.stage] || "全部";
}

/* ---------------- 左栏：项目与员工 ---------------- */

/** 折叠过的项目按路径记住，刷新后不会自己弹开。 */
const collapsedProjects = new Set();

export function renderProjects() {
  const list = $("project-list");
  if (!list) return;
  const signature = JSON.stringify(state.workers) + `|${state.sideCollapsed}`;
  if (signature === state.projectsSignature) return;
  state.projectsSignature = signature;
  list.replaceChildren();

  if (!state.workers.length) {
    list.append(el("p", "empty", "还没有员工。点上面的「+」新建一个，选个目录就能派活了。"));
    return;
  }

  const groups = groupByProject(state.workers);

  // 同名项目（比如两个 docs）才需要路径行做区分；平时项目名已经够用，那一行是纯重复。
  const nameCount = new Map();
  for (const group of groups) {
    const name = baseName(group.path);
    nameCount.set(name, (nameCount.get(name) || 0) + 1);
  }

  for (const group of groups) {
    const name = baseName(group.path);
    const details = document.createElement("details");
    details.className = "project";
    details.open = !collapsedProjects.has(group.path);
    details.addEventListener("toggle", () => {
      if (details.open) collapsedProjects.delete(group.path);
      else collapsedProjects.add(group.path);
    });

    const summary = document.createElement("summary");
    summary.className = "project-head";
    // 完整路径始终挂在 summary 的 title 上：悬浮随时能看到，不占版面。
    summary.title = group.path;
    summary.append(el("span", "project-name", name));
    summary.append(el("span", "project-count", String(group.list.length)));
    details.append(summary);

    if ((nameCount.get(name) || 0) > 1 && !group.path.startsWith("（")) {
      const pathLine = el("code", "project-path", middleEllipsis(group.path));
      pathLine.title = group.path;
      details.append(pathLine);
    }

    const workers = el("div", "worker-list");
    for (const worker of group.list) workers.append(workerRow(worker));
    details.append(workers);

    const tools = el("div", "project-tools");
    tools.append(
      button("link", "+ 在这里加员工", () => openWorkerModal(null, group.path)),
      button("link", "打开目录", () => openFolder(group.path)),
    );
    details.append(tools);

    list.append(details);
  }
}

function workerRow(worker) {
  const info = workerBadge(worker);
  const row = el("div", `worker-row${worker.enabled ? "" : " disabled"}`);
  row.title = workerTitle(worker);

  const dot = el("i", `w-dot ${info.cls}`);
  dot.title = info.text;

  const name = button("worker-row-name", worker.name, () => {
    const select = $("worker-select");
    if (select && [...select.options].some((option) => option.value === worker.id && !option.disabled)) {
      select.value = worker.id;
      select.dispatchEvent(new Event("change"));
      $("prompt")?.focus();
      setFormNote(`已选中「${worker.name}」，写任务内容就能派。`, "ok");
    } else {
      setFormNote(`「${worker.name}」现在不能接活（停用或命令不可用）。`, "error");
    }
  });

  const more = button("worker-row-more", "⋯", () => {
    openRowMenu(more, [
      { label: "编辑", run: () => openWorkerModal(worker.id) },
      { label: worker.enabled ? "停用" : "启用", run: () => toggleWorker(worker) },
      { label: "用量", run: () => openUsageModal(worker.id) },
      { label: "打开项目目录", run: () => openFolder(worker.cwd) },
      { label: "删除", danger: true, run: () => removeWorker(worker) },
    ]);
  });
  more.title = "更多";

  row.append(dot, name, el("span", `worker-row-badge ${info.cls}`, info.text), more);
  return row;
}

/* ---------------- 浮动菜单 ---------------- */

let menuCloser = null;

function openRowMenu(anchor, items) {
  const menu = $("row-menu");
  if (!menu) return;
  menu.replaceChildren();
  for (const item of items) {
    menu.append(
      button(`row-menu-item${item.danger ? " danger" : ""}`, item.label, () => {
        closeRowMenu();
        item.run();
      }),
    );
  }
  menu.classList.remove("hidden");
  const rect = anchor.getBoundingClientRect();
  const size = menu.getBoundingClientRect();
  menu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - size.height - 8))}px`;
  menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - size.width - 8))}px`;

  menuCloser = (event) => {
    if (menu.contains(event.target) || anchor.contains(event.target)) return;
    closeRowMenu();
  };
  window.setTimeout(() => {
    document.addEventListener("click", menuCloser, true);
    document.addEventListener("keydown", escCloser);
  }, 0);
}

function escCloser(event) {
  if (event.key === "Escape") closeRowMenu();
}

function closeRowMenu() {
  const menu = $("row-menu");
  if (menu) menu.classList.add("hidden");
  if (menuCloser) {
    document.removeEventListener("click", menuCloser, true);
    document.removeEventListener("keydown", escCloser);
    menuCloser = null;
  }
}

/* ---------------- 中栏：派活 ---------------- */

export function renderWorkerSelect() {
  const select = $("worker-select");
  if (!select) return;
  const signature = state.workers.map((worker) => `${worker.id}:${worker.name}:${worker.enabled}`).join("|");
  if (signature === state.selectSignature) return;
  state.selectSignature = signature;

  const previous = select.value;
  select.replaceChildren();
  for (const worker of state.workers) {
    const option = document.createElement("option");
    option.value = worker.id;
    option.textContent = worker.enabled ? `${worker.name}（${baseName(worker.cwd || "")}）` : `${worker.name}（停用）`;
    option.disabled = !worker.enabled;
    select.append(option);
  }
  if (previous && state.workers.some((worker) => worker.id === previous && worker.enabled)) {
    select.value = previous;
  } else {
    const firstEnabled = state.workers.find((worker) => worker.enabled);
    if (firstEnabled) select.value = firstEnabled.id;
  }

  if (!state.cwdInitialized) {
    const selected = workerById(select.value);
    if (selected?.cwd) {
      $("cwd").value = selected.cwd;
      state.cwdInitialized = true;
    }
  }
  syncModelField();
}

/**
 * 模型候选全部由后端从本机配置里读出来，前端不写死任何模型名。
 * 用 datalist：能下拉选，也能直接手打库里没有的模型。
 */
async function fillModelOptions(listId, kind, workerId = null) {
  try {
    const query = new URLSearchParams({ kind: kind || "" });
    if (workerId) query.set("workerId", workerId);
    const data = await api(`/api/models?${query}`);
    const list = $(listId);
    if (!list) return data;
    list.replaceChildren();
    for (const item of data.models || []) {
      const option = document.createElement("option");
      option.value = item.id;
      // datalist 有 label 时显示 label，插入的仍是 value。
      option.label = item.label || item.id;
      list.append(option);
    }
    return data;
  } catch {
    return null;
  }
}

/** 派活区的模型框：留空 = 完全跟随 CLI / 路由；占位提示写出那个默认值。 */
async function syncModelField() {
  const worker = workerById($("worker-select")?.value);
  if (!worker) return;
  const data = await fillModelOptions("model-options", worker.kind, worker.id);
  const effective = data?.current || worker.effectiveModel || "";
  const input = $("model");
  if (!input) return;
  input.placeholder = effective || "跟随路由";
  input.title = effective
    ? `留空＝用路由给这个 harness 配的模型 ${effective}。只有想临时换一次时才填。`
    : "留空就跟随 CLI / 路由配置；想临时换一次才填。";
}

export async function loadTemplates() {
  const result = await softApi("/api/templates");
  state.templates = result.ok ? result.data.templates || [] : [];
  renderTemplates();
}

export function renderTemplates() {
  const box = $("template-chips");
  if (!box) return;
  box.replaceChildren();
  if (!state.templates.length) {
    box.append(el("span", "template-empty", "还没有模板。写好一段任务后点「存为模板」。"));
    return;
  }
  for (const tpl of state.templates) {
    const chip = el("button", "template-chip");
    chip.type = "button";
    chip.title = `${tpl.prompt.slice(0, 160)}${tpl.prompt.length > 160 ? "…" : ""}`;
    chip.append(el("span", "template-chip-name", tpl.name));
    const remove = el("span", "template-chip-remove", "×");
    remove.title = "删除这个模板";
    chip.append(remove);
    chip.addEventListener("click", (event) => {
      if (event.target === remove) {
        event.stopPropagation();
        deleteTemplate(tpl);
        return;
      }
      applyTemplate(tpl);
    });
    box.append(chip);
  }
}

/** 点模板只填内容，不直接派发——每次的素材和范围都会变，得让人改一遍。 */
function applyTemplate(tpl) {
  $("prompt").value = tpl.prompt;
  if (tpl.workerId && state.workers.some((item) => item.id === tpl.workerId && item.enabled)) {
    $("worker-select").value = tpl.workerId;
    const worker = workerById(tpl.workerId);
    if (worker?.cwd) {
      $("cwd").value = worker.cwd;
      state.cwdInitialized = true;
    }
    syncModelField();
  }
  if (tpl.cwd) {
    $("cwd").value = tpl.cwd;
    state.cwdInitialized = true;
  }
  updateSaveTemplateVisibility();
  $("prompt").focus();
  setFormNote(`已填入模板「${tpl.name}」，改完再派发。`, "ok");
}

function updateSaveTemplateVisibility() {
  const save = $("save-template");
  if (save) save.hidden = !$("prompt").value.trim();
}

async function saveTemplateFromPrompt() {
  const prompt = $("prompt").value.trim();
  if (!prompt) {
    setFormNote("先写点内容，再存成模板。", "error");
    return;
  }
  const suggested = prompt.split(/\r?\n/).find(Boolean)?.slice(0, 12) || "新模板";
  const name = window.prompt("给这个模板起个名字（以后点它就填这一段）", suggested);
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) {
    setFormNote("模板名字不能为空。", "error");
    return;
  }
  const result = await softApi("/api/templates", {
    method: "POST",
    body: JSON.stringify({
      name: trimmed,
      prompt,
      workerId: $("worker-select").value,
      cwd: $("cwd").value.trim(),
    }),
  });
  if (!result.ok) {
    setFormNote(result.error?.message || "存模板失败", "error");
    return;
  }
  await loadTemplates();
  setFormNote(`已存成模板「${trimmed}」，以后点一下就能填回来。`, "ok");
}

async function deleteTemplate(tpl) {
  const ok = window.confirm(`删除模板「${tpl.name}」？只删模板，已经派出去的任务不受影响。`);
  if (!ok) return;
  const result = await softApi(`/api/templates/${encodeURIComponent(tpl.id)}`, { method: "DELETE" });
  if (!result.ok) {
    setFormNote(result.error?.message || "删除失败", "error");
    return;
  }
  await loadTemplates();
  setFormNote(`已删除模板「${tpl.name}」。`, "ok");
}

/* ---------------- 中栏：任务流 ---------------- */

function visibleTasks() {
  const list = state.tasks || [];
  return state.showSide ? list : list.filter((task) => !isSide(task));
}

function latestProgress(task) {
  const progress = task.progress || [];
  return progress.length ? progress[progress.length - 1]?.message || "" : "";
}

export function renderTasks() {
  const list = $("task-list");
  if (!list) return;
  const tasks = visibleTasks();

  // 每 2.5 秒刷一次，没变化就别重建 DOM——否则鼠标悬停和点击会被打断。
  const signature = [
    state.stage,
    state.showSide ? "1" : "0",
    state.selectedId || "",
    tasks.map((task) => `${task.id}:${task.status}:${task.acknowledgedAt ? 1 : 0}:${(task.progress || []).length}`).join(","),
  ].join("|");
  if (signature === state.flowSignature) return;
  state.flowSignature = signature;

  const scrollTop = list.scrollTop;
  list.replaceChildren();

  if (!tasks.length) {
    list.append(
      el(
        "p",
        "empty",
        state.stage
          ? `「${STAGE_TEXT[state.stage]}」里现在没有任务`
          : state.showSide
            ? "还没有任务"
            : "还没有任务。上面写好内容，按「派发任务」。",
      ),
    );
    return;
  }

  for (const task of tasks) {
    const stage = stageOf(task);
    const row = button(
      `row${task.id === state.selectedId ? " selected" : ""}${stage === "waiting" ? " needs-you" : ""}`,
      "",
      () => actions.selectTask(task.id),
    );
    row.title = [task.title, latestProgress(task)].filter(Boolean).join("\n");

    row.append(el("i", `row-dot ${stage}`));
    row.append(el("span", "row-title", task.title || task.id));
    row.append(el("span", "row-worker", workerName(task.workerId)));
    if (isSide(task)) row.append(el("span", "row-tag side", "侧问"));
    if (task.acknowledgedAt) row.append(el("span", "row-tag", "已处理"));
    row.append(el("span", "row-time", shortTime(task.createdAt)));
    row.append(el("span", `status ${task.status}`, STATUS_TEXT[task.status] || task.status));

    list.append(row);
  }
  list.scrollTop = scrollTop;
}

/* ---------------- 右栏：任务详情 ---------------- */

function setDetailOpen(open) {
  document.body.dataset.detail = open ? "open" : "closed";
}

export function renderDetail() {
  const task = state.detail;
  const detail = $("detail");
  const empty = $("detail-empty");
  if (!detail || !empty) return;

  if (!task) {
    detail.classList.add("hidden");
    empty.classList.remove("hidden");
    setDetailOpen(false);
    renderTalk();
    return;
  }
  empty.classList.add("hidden");
  detail.classList.remove("hidden");
  setDetailOpen(true);

  const status = $("detail-status");
  status.className = `status ${task.status}`;
  status.textContent = STATUS_TEXT[task.status] || task.status;
  $("detail-id").textContent = task.id;
  const sideTag = $("detail-side-tag");
  if (sideTag) sideTag.hidden = !isSide(task);
  $("detail-title").textContent = task.title || "";

  const attempts = Number(task.attempts || 0);
  const maxAttempts = Math.max(Number(task.maxAttempts || 1), 1);
  const metaBits = [
    workerName(task.workerId),
    `开始 ${formatTime(task.startedAt || task.createdAt)}`,
    `耗时 ${duration(task)}`,
    `尝试 ${attempts ? `${attempts} / ${maxAttempts}` : `— / ${maxAttempts}`}`,
    task.sessionId ? `会话 ${String(task.sessionId).slice(0, 8)}` : "会话 尚未建立",
  ];
  const meta = $("detail-meta");
  meta.replaceChildren();
  for (const bit of metaBits) meta.append(el("span", "meta-bit", bit));
  if (task.steerCount) meta.append(el("span", "meta-bit", `插话 ${task.steerCount} 次`));

  const cwd = $("meta-cwd");
  cwd.textContent = task.cwd ? middleEllipsis(task.cwd) : "—";
  cwd.title = task.cwd || "";
  $("open-cwd").disabled = !task.cwd;
  $("copy-cwd").disabled = !task.cwd;

  renderUsage(task);

  // 结果常显：这是用户最想第一眼看到的东西。
  const resultBlock = $("result-block");
  const hasResult = Boolean(task.result);
  resultBlock.hidden = !hasResult;
  $("detail-result").textContent = task.result || "";

  const errorBlock = $("error-block");
  errorBlock.hidden = !task.error;
  $("detail-error").textContent = task.error || "";

  // 进度默认折叠：summary 里带条数和最新一句，不展开也知道在干什么。
  const progressList = $("progress-list");
  progressList.replaceChildren();
  for (const entry of task.progress || []) {
    const item = document.createElement("li");
    item.append(el("time", "", shortTime(entry.time)), document.createTextNode(entry.message));
    progressList.append(item);
  }
  if (!progressList.children.length) progressList.append(el("li", "", "暂无进度记录"));
  const progressSummary = $("progress-summary");
  const count = (task.progress || []).length;
  const newest = latestProgress(task);
  progressSummary.textContent = `执行进度 · ${count} 条${newest ? ` · ${newest.slice(0, 40)}` : ""}`;

  $("detail-prompt").textContent = task.prompt || "";
  $("detail-log").textContent = task.logTail || "暂无原始日志";

  $("copy-result").hidden = !hasResult;
  $("stop-task").hidden = !["queued", "running", "retrying", "cancelling"].includes(task.status);
  $("retry-task").hidden = !["completed", "failed", "cancelled", "interrupted"].includes(task.status);
  $("ack-task").hidden = !(stageOf(task) === "waiting" && !task.acknowledgedAt);

  renderTalk();
}

function renderUsage(task) {
  const usage = task?.usage || null;
  const line = usageText(usage);
  const box = $("usage-box");
  if (!line) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  $("usage-text").textContent = line;

  // 金额必须说清两件事：是整个会话累计，而且是按 Claude 牌价估的。
  const note = $("usage-note");
  if (usage.costUsd) {
    note.textContent = `$${Number(usage.costUsd).toFixed(2)} 是整个会话的累计花费（含之前续接的对话），按 Claude 牌价估，不是你实际扣费。`;
  } else {
    note.textContent = "这个员工不上报金额，只能看 token 用量。";
  }
}

/* ---------------- 用量弹窗 ---------------- */

export function openUsageModal(focusWorkerId = null) {
  const body = $("usage-body");
  if (!body) return;
  body.replaceChildren();
  const rows = state.workers.map((worker) => ({ worker, today: worker.today || {} }));
  const total = rows.reduce(
    (acc, item) => {
      acc.tasks += Number(item.today.tasks) || 0;
      acc.completed += Number(item.today.completed) || 0;
      acc.outputTokens += Number(item.today.outputTokens) || 0;
      acc.inputTokens += Number(item.today.inputTokens) || 0;
      acc.cacheReadTokens += Number(item.today.cacheReadTokens) || 0;
      return acc;
    },
    { tasks: 0, completed: 0, outputTokens: 0, inputTokens: 0, cacheReadTokens: 0 },
  );

  const table = el("div", "usage-table");
  const head = el("div", "usage-row head");
  head.append(el("span", "", "员工"), el("span", "", "今天任务"), el("span", "", "完成"), el("span", "", "输出"), el("span", "", "缓存命中"));
  table.append(head);
  for (const item of rows) {
    const row = el("div", `usage-row${item.worker.id === focusWorkerId ? " focus" : ""}`);
    row.append(
      el("span", "usage-name", item.worker.name),
      el("span", "", String(item.today.tasks || 0)),
      el("span", "", String(item.today.completed || 0)),
      el("span", "", formatTokens(item.today.outputTokens)),
      el("span", "", formatTokens(item.today.cacheReadTokens)),
    );
    table.append(row);
  }
  const sum = el("div", "usage-row sum");
  sum.append(
    el("span", "usage-name", "合计"),
    el("span", "", String(total.tasks)),
    el("span", "", String(total.completed)),
    el("span", "", formatTokens(total.outputTokens)),
    el("span", "", formatTokens(total.cacheReadTokens)),
  );
  table.append(sum);
  body.append(table);
  body.append(
    el(
      "p",
      "usage-foot",
      "只统计今天。金额不显示：CLI 报的 cost 是会话累计，按天相加会重复计算，给了反而误导。",
    ),
  );

  showModal("usage-modal", true);
}

/* ---------------- 员工增删改启停 ---------------- */

async function toggleWorker(worker) {
  const result = await softApi(`/api/workers/${encodeURIComponent(worker.id)}`, {
    method: "PUT",
    body: JSON.stringify({ disabled: worker.enabled }),
  });
  if (!result.ok) {
    setFormNote(result.error?.message || "改状态失败", "error");
    return;
  }
  setFormNote(`「${worker.name}」已${worker.enabled ? "停用" : "启用"}。`, "ok");
  await actions.refresh();
}

async function removeWorker(worker) {
  const ok = window.confirm(`删除员工「${worker.name}」？\n已经跑过的任务记录会保留，但之后不能再派活给它。`);
  if (!ok) return;
  const result = await softApi(`/api/workers/${encodeURIComponent(worker.id)}`, { method: "DELETE" });
  if (!result.ok) {
    setFormNote(result.error?.message || "删除失败", "error");
    return;
  }
  setFormNote(`已删除「${worker.name}」。`, "ok");
  await actions.refresh();
}

function renderKindOptions(selected) {
  const select = $("w-kind");
  select.replaceChildren();
  for (const adapter of state.adapters || []) {
    const option = document.createElement("option");
    option.value = adapter.kind;
    option.textContent = adapter.label;
    select.append(option);
  }
  if (selected) select.value = selected;
}

function renderPermOptions(kind, selected) {
  const adapter = adapterOf(kind);
  const select = $("w-perm");
  select.replaceChildren();
  for (const mode of adapter?.permissionModes || []) {
    const option = document.createElement("option");
    option.value = mode.value;
    option.textContent = mode.label;
    option.dataset.hint = mode.hint || "";
    select.append(option);
  }
  const wanted =
    selected && [...select.options].some((option) => option.value === selected)
      ? selected
      : adapter?.defaultPermissionMode || select.options[0]?.value || "";
  select.value = wanted;
  updatePermHint();
}

function updatePermHint() {
  const selected = $("w-perm").selectedOptions[0];
  $("w-perm-hint").textContent = selected?.dataset.hint || "";
}

/**
 * 启动方式：新建时用同类员工现成的（免得用户知道 node xxx.js 这种东西），
 * 编辑时保留这个员工自己的。用户看不见 argsPrefix，但它必须一起提交。
 */
function applyLaunchTemplate(kind, worker = null) {
  const adapter = adapterOf(kind);
  const template = adapter?.commandTemplate || { command: "", argsPrefix: [] };
  const command = worker?.commandPath || template.command || "";
  const argsPrefix = worker?.commandPath
    ? Array.isArray(worker.argsPrefix)
      ? worker.argsPrefix
      : []
    : template.argsPrefix || [];

  $("w-command").value = command;
  $("w-command").placeholder = adapter?.commandHint || "默认同类员工已配好的命令";
  state.pendingArgsPrefix = argsPrefix;

  const hint = $("w-launch-hint");
  if (!hint) return;
  if (!command) {
    hint.textContent = "这台机器上还没有同类员工，暂时没有可复用的启动方式；先建一个同类员工就会自动带出来。";
  } else {
    const suffix = argsPrefix.length ? ` ${argsPrefix.join(" ")}` : "";
    hint.textContent = `实际启动：${command}${suffix}`;
  }
}

/** 预算字段只对支持的 CLI 显示，不支持的直接藏起来，免得填了没效果。 */
function updateBudgetField(kind) {
  const adapter = adapterOf(kind);
  const supported = Boolean(adapter?.supportsBudget);
  $("w-budget-field").hidden = !supported;
  $("w-budget-hint").textContent = supported ? adapter.budgetHint || "" : "";
}

/**
 * 插话相关字段：只有支持流式插话的员工类型才显示。
 * 不支持的（Codex / 反重力）藏起来并说明原因；后端还没给这个字段时也要说清是「没读到」而不是「不支持」。
 */
function updateSteerFields(kind) {
  const adapter = adapterOf(kind);
  const supports = adapter?.supportsSteer === true;
  $("w-steer-field").hidden = !supports;
  $("w-steer-idle-field").hidden = !supports;
  const label = adapter?.label || "这个类型";
  if (supports) {
    $("w-steer-hint").textContent =
      "打开后任务跑着的时候也能插话（员工在这一轮就看到）。关着更省心，插话按钮会提示你打开。";
  } else if (adapter?.supportsSteer === false) {
    $("w-steer-hint").textContent = adapter.steerHint || `${label}不支持插话，只能用侧问。`;
  } else {
    $("w-steer-hint").textContent = `还没读到插话能力（需要 Hub 0.7.0 的 supportsSteer），现在只能用侧问。`;
  }
}

/** 员工表单里的模型框：候选来自该 CLI 自己的配置，占位提示写清「留空会用什么」。 */
async function syncWorkerModelField(workerId) {
  const kind = $("w-kind").value;
  const data = await fillModelOptions("w-model-options", kind, workerId);
  const effective = data?.current || "";
  $("w-model").placeholder = effective ? `留空＝${effective}` : "留空＝跟随路由";
  $("w-model-label").textContent = effective
    ? `模型（留空＝跟随路由的 ${effective}）`
    : "模型（留空＝跟随路由）";
}

export function openWorkerModal(id = null, presetCwd = "") {
  state.editingWorkerId = id;
  const worker = id ? workerById(id) : null;
  $("worker-modal-title").textContent = worker ? `编辑员工 · ${worker.name}` : "新增员工";
  $("w-delete").hidden = !worker;
  $("w-msg").textContent = "";
  $("w-msg").className = "modal-note";

  $("w-name").value = worker?.name || "";
  renderKindOptions(worker?.kind || state.adapters?.[0]?.kind);
  renderPermOptions($("w-kind").value, worker?.permissionMode);
  $("w-cwd").value = worker?.cwd || presetCwd || "";
  state.commandTouched = false;
  applyLaunchTemplate($("w-kind").value, worker);
  $("w-model").value = worker?.model || "";
  $("w-retry").value = String(worker?.retryMaxAttempts ?? 3);
  $("w-budget").value = Number(worker?.maxBudgetUsd) > 0 ? String(worker.maxBudgetUsd) : "";
  updateBudgetField($("w-kind").value);
  updateSteerFields($("w-kind").value);
  $("w-stream").checked = Boolean(worker?.streamInput);
  $("w-steer-idle").value = String(Math.round((Number(worker?.steerIdleMs) || 3000) / 1000));
  $("w-side-timeout").value = String(Math.round((Number(worker?.sideTimeoutMs) || 180000) / 1000));
  $("w-note").value = worker?.note || "";
  $("w-extra").value = (worker?.extraDirs || []).join(";");
  syncWorkerModelField(worker?.id || null);

  showModal("worker-modal", true);
  window.setTimeout(() => $("w-name").focus(), 40);
}

async function saveWorker() {
  const payload = {
    name: $("w-name").value.trim(),
    kind: $("w-kind").value,
    cwd: $("w-cwd").value.trim(),
    permissionMode: $("w-perm").value,
    model: $("w-model").value.trim(),
    note: $("w-note").value.trim(),
    command: $("w-command").value.trim(),
    argsPrefix: state.pendingArgsPrefix,
    addDirs: $("w-extra").value
      .split(/[;,]/)
      .map((part) => part.trim())
      .filter(Boolean),
    retry: { maxAttempts: Math.max(1, Number($("w-retry").value) || 1) },
    maxBudgetUsd: Number($("w-budget").value) > 0 ? Number($("w-budget").value) : null,
    // 后端 0.7.0 才认这两个；老版本会安静地忽略，不会报错。
    streamInput: $("w-stream").checked,
    steerIdleMs: Math.min(60000, Math.max(3000, (Number($("w-steer-idle").value) || 3) * 1000)),
    sideTimeoutMs: Math.min(900000, Math.max(30000, (Number($("w-side-timeout").value) || 180) * 1000)),
  };
  const message = $("w-msg");
  message.className = "modal-note";
  message.textContent = "保存中…";
  const result = state.editingWorkerId
    ? await softApi(`/api/workers/${encodeURIComponent(state.editingWorkerId)}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      })
    : await softApi("/api/workers", { method: "POST", body: JSON.stringify(payload) });
  if (!result.ok) {
    message.className = "modal-note error";
    message.textContent = result.error?.message || "保存失败";
    return;
  }
  showModal("worker-modal", false);
  setFormNote("员工已保存，立刻生效。", "ok");
  state.selectSignature = "";
  await actions.refresh();
}

async function deleteEditingWorker() {
  const worker = workerById(state.editingWorkerId);
  if (!worker) return;
  const ok = window.confirm(`删除员工「${worker.name}」？已经跑过的任务记录会保留。`);
  if (!ok) return;
  const result = await softApi(`/api/workers/${encodeURIComponent(worker.id)}`, { method: "DELETE" });
  if (!result.ok) {
    $("w-msg").className = "modal-note error";
    $("w-msg").textContent = result.error?.message || "删除失败";
    return;
  }
  showModal("worker-modal", false);
  setFormNote(`已删除「${worker.name}」。`, "ok");
  await actions.refresh();
}

/* ---------------- 目录选择器 ---------------- */

async function loadDrives() {
  if (state.drives) return state.drives;
  const data = await api("/api/fs/drives");
  state.drives = data.drives;
  return state.drives;
}

async function openDirPicker(startPath) {
  state.onPickDir = (path) => {
    $("w-cwd").value = path;
    showModal("dir-modal", false);
  };
  $("dir-msg").textContent = "";
  $("dir-msg").className = "modal-note";
  $("dir-new-name").value = "";
  showModal("dir-modal", true);
  try {
    const drives = await loadDrives();
    renderDrives(drives);
    await loadDirectory(startPath || drives[0]?.path || "C:\\");
  } catch (error) {
    $("dir-msg").textContent = error.message;
  }
}

function renderDrives(drives) {
  const row = $("dir-drives");
  row.replaceChildren();
  for (const drive of drives) {
    const chip = button("drive-chip", drive.label, () => loadDirectory(drive.path));
    if (state.dir?.path?.startsWith(drive.path)) chip.classList.add("active");
    row.append(chip);
  }
}

async function loadDirectory(path) {
  try {
    const data = await api(`/api/fs/list?path=${encodeURIComponent(path)}`);
    state.dir = data;
    $("dir-path").textContent = data.path;
    $("dir-up").disabled = !data.parent;
    renderDrives(state.drives || []);
    const list = $("dir-list");
    list.replaceChildren();
    if (data.warning) list.append(el("p", "empty", data.warning));
    if (!data.dirs.length) list.append(el("p", "empty", "这个目录下没有子文件夹"));
    for (const dir of data.dirs) {
      const item = button("dir-item", "", () => loadDirectory(dir.path));
      item.append(el("span", "dir-icon", "▸"), el("span", "dir-name", dir.name));
      item.addEventListener("dblclick", () => state.onPickDir?.(dir.path));
      list.append(item);
    }
    $("dir-msg").textContent = "";
  } catch (error) {
    $("dir-msg").className = "modal-note error";
    $("dir-msg").textContent = error.message;
  }
}

async function createFolderHere() {
  const name = $("dir-new-name").value.trim();
  if (!name) {
    $("dir-msg").className = "modal-note error";
    $("dir-msg").textContent = "先输入文件夹名字";
    return;
  }
  try {
    const data = await api("/api/fs/mkdir", {
      method: "POST",
      body: JSON.stringify({ parent: state.dir?.path, name }),
    });
    $("dir-new-name").value = "";
    await loadDirectory(data.path);
    $("dir-msg").className = "modal-note";
    $("dir-msg").textContent = `已新建：${data.path}，点「用这个目录」即可。`;
  } catch (error) {
    $("dir-msg").className = "modal-note error";
    $("dir-msg").textContent = error.message;
  }
}

/* ---------------- 派活与任务动作 ---------------- */

async function dispatchTask() {
  const prompt = $("prompt").value.trim();
  if (!prompt) {
    setFormNote("先写任务内容。", "error");
    $("prompt").focus();
    return;
  }
  const dispatch = $("dispatch");
  dispatch.disabled = true;
  setFormNote("正在写入任务队列…");
  const freshStart = $("new-session").checked;
  const result = await softApi("/api/tasks", {
    method: "POST",
    body: JSON.stringify({
      workerId: $("worker-select").value || state.workers[0]?.id,
      prompt,
      cwd: $("cwd").value.trim(),
      model: $("model").value.trim(),
      newSession: freshStart,
    }),
  });
  dispatch.disabled = false;
  if (!result.ok) {
    setFormNote(result.error?.message || "派发失败", "error");
    return;
  }
  const task = result.data?.task;
  if (!task?.id) {
    setFormNote("派发成功了，但没拿到任务号；刷新一下看任务流。", "ok");
    await actions.refresh();
    return;
  }
  $("prompt").value = "";
  $("new-session").checked = false;
  updateSaveTemplateVisibility();
  setFormNote(
    `已派发，任务号 ${task.id}${freshStart ? "（已清空记忆，从头开始）" : "（接着上次对话）"}`,
    "ok",
  );
  await actions.refresh();
  await actions.selectTask(task.id);
}

async function taskAction(task, action, note, confirmText = "") {
  if (!task) return;
  if (confirmText) {
    const ok = window.confirm(confirmText);
    if (!ok) return;
  }
  const result = await softApi(`/api/tasks/${encodeURIComponent(task.id)}/${action}`, {
    method: "POST",
    body: "{}",
  });
  if (!result.ok) {
    setFormNote(result.error?.message || `${note}失败`, "error");
    return;
  }
  if (result.data?.task) state.detail = result.data.task;
  setFormNote(note, "ok");
  renderTasks();
  renderDetail();
  await actions.refresh();
}

/* ---------------- 事件绑定 ---------------- */

export function initWorkbench() {
  $("add-worker").addEventListener("click", () => openWorkerModal());
  $("w-cancel").addEventListener("click", () => showModal("worker-modal", false));
  $("w-cancel-2").addEventListener("click", () => showModal("worker-modal", false));
  $("w-save").addEventListener("click", () => saveWorker());
  $("w-delete").addEventListener("click", () => deleteEditingWorker());
  $("w-browse").addEventListener("click", () => openDirPicker($("w-cwd").value.trim()));
  $("w-kind").addEventListener("change", () => {
    const kind = $("w-kind").value;
    renderPermOptions(kind, null);
    // 换类型必须换启动方式：沿用上一个类型的命令，会得到一个「显示可用、一派就废」的员工。
    if (!state.commandTouched) {
      applyLaunchTemplate(kind);
    } else {
      $("w-command").placeholder = adapterOf(kind)?.commandHint || "";
    }
    updateBudgetField(kind);
    updateSteerFields(kind);
    syncWorkerModelField(state.editingWorkerId);
  });
  $("w-command").addEventListener("input", () => {
    state.commandTouched = true;
  });
  $("w-perm").addEventListener("change", updatePermHint);

  $("dir-cancel").addEventListener("click", () => showModal("dir-modal", false));
  $("dir-cancel-2").addEventListener("click", () => showModal("dir-modal", false));
  $("dir-up").addEventListener("click", () => {
    if (state.dir?.parent) loadDirectory(state.dir.parent);
  });
  $("dir-choose").addEventListener("click", () => {
    if (state.dir?.path) state.onPickDir?.(state.dir.path);
  });
  $("dir-new").addEventListener("click", () => createFolderHere());
  $("dir-new-name").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      createFolderHere();
    }
  });

  $("worker-select").addEventListener("change", () => {
    const worker = workerById($("worker-select").value);
    if (worker?.cwd) {
      $("cwd").value = worker.cwd;
      state.cwdInitialized = true;
    }
    syncModelField();
  });
  $("dispatch").addEventListener("click", () => dispatchTask());
  $("save-template").addEventListener("click", () => saveTemplateFromPrompt());
  $("prompt").addEventListener("input", updateSaveTemplateVisibility);
  $("prompt").addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      dispatchTask();
    }
  });

  // 顶部状态字：点一下筛，再点一下取消；▾ 展开每项的意思。
  for (const chip of document.querySelectorAll(".sc")) {
    chip.addEventListener("click", () => {
      const next = chip.dataset.stage || "";
      actions.setStage(state.stage === next ? "" : next);
    });
  }
  $("clear-filter").addEventListener("click", () => actions.setStage(""));
  $("status-expand").addEventListener("click", () => {
    state.statusExpanded = !state.statusExpanded;
    renderStatusline();
  });
  $("show-side").addEventListener("change", (event) => {
    state.showSide = event.target.checked;
    renderStatusline();
    renderTasks();
  });

  // 左栏折叠
  $("side-toggle").addEventListener("click", () => {
    state.sideCollapsed = !state.sideCollapsed;
    document.body.dataset.side = state.sideCollapsed ? "collapsed" : "open";
    state.projectsSignature = "";
    renderProjects();
  });

  // 右栏动作
  $("close-detail").addEventListener("click", () => {
    actions.clearSelection();
    renderDetail();
    renderTasks();
  });
  $("open-cwd").addEventListener("click", () => openFolder(state.detail?.cwd));
  $("copy-cwd").addEventListener("click", async () => {
    const ok = await copyText(state.detail?.cwd || "");
    setFormNote(ok ? "路径已复制。" : "浏览器不让自动复制，请手动选中。", ok ? "ok" : "error");
  });
  $("stop-task").addEventListener("click", () => {
    const task = state.detail;
    taskAction(task, "stop", "已发送停止请求。", `停止任务「${task?.title || ""}」？已经产生的文件修改不会自动撤销。`);
  });
  $("retry-task").addEventListener("click", () => taskAction(state.detail, "retry", "已重新放回队列。"));
  $("ack-task").addEventListener("click", () => taskAction(state.detail, "ack", "已标记处理完，移出「等你」。"));
  $("copy-result").addEventListener("click", async () => {
    const ok = await copyText(state.detail?.result || "");
    setFormNote(ok ? "结果已复制。" : "浏览器不允许自动复制，请手动选择结果文字。", ok ? "ok" : "error");
  });

  // 用量弹窗
  $("usage-open").addEventListener("click", () => openUsageModal());
  $("usage-cancel").addEventListener("click", () => showModal("usage-modal", false));
  $("usage-close").addEventListener("click", () => showModal("usage-modal", false));

  // 中栏刷新（轮询之外的手动一次）
  $("refresh-tasks").addEventListener("click", () => {
    actions.hardRefresh();
    toast("已刷新", "ok");
  });
}
