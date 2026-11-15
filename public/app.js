const $ = (id) => document.getElementById(id);

const state = {
  overview: null,
  workers: [],
  adapters: null,
  tasks: [],
  stage: "",
  selectedId: null,
  detail: null,
  refreshing: false,
  cwdInitialized: false,
  editingWorkerId: null,
  selectSignature: "",
  projectsSignature: "",
  dir: null,
  drives: null,
  onPickDir: null,
  /** 员工表单：当前类型的启动参数。用户看不见它，但必须跟着类型走。 */
  pendingArgsPrefix: [],
  /** 用户是否手动改过启动命令；没改过就允许按类型自动覆盖。 */
  commandTouched: false,
  templates: [],
};

const STATUS_TEXT = {
  queued: "排队",
  running: "执行中",
  retrying: "重试中",
  cancelling: "停止中",
  waiting: "等你",
  completed: "完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "中断",
};

const STAGE_TEXT = {
  "": "全部",
  running: "在跑",
  waiting: "等你",
  queued: "队列里",
  done: "已结束",
};

const TIME_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return TIME_FORMAT.format(date);
}

function shortTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

function duration(task) {
  if (!task.startedAt) return "—";
  const end = task.finishedAt ? new Date(task.finishedAt).getTime() : Date.now();
  const start = new Date(task.startedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "—";
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remain = seconds % 60;
  if (minutes < 60) return `${minutes} 分 ${remain} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function baseName(path) {
  const parts = String(path || "").split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}

function setConnection(mode, label) {
  const element = $("connection");
  element.classList.remove("online", "offline");
  if (mode) element.classList.add(mode);
  $("connection-text").textContent = label;
}

function setFormNote(message, type = "") {
  const element = $("form-note");
  element.textContent = message;
  element.className = `form-note ${type}`.trim();
}

function isActive(task) {
  return ["queued", "running", "retrying", "cancelling"].includes(task.status);
}

function workerName(workerId) {
  const worker = state.workers.find((item) => item.id === workerId);
  return worker?.name || workerId;
}

function adapterOf(kind) {
  return (state.adapters || []).find((item) => item.kind === kind) || null;
}

function workerBadge(worker) {
  if (!worker.enabled) return { text: "已停用", cls: "bad" };
  if (!worker.available) return { text: "命令不可用", cls: "bad" };
  if (worker.activeTaskId) return { text: "执行中", cls: "busy" };
  if (worker.queued > 0) return { text: `排队 ${worker.queued}`, cls: "busy" };
  return { text: "待命", cls: "ok" };
}

/* ---------------- 项目与员工 ---------------- */

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
  try {
    await api("/api/open-folder", { method: "POST", body: JSON.stringify({ path }) });
  } catch (error) {
    setFormNote(error.message, "error");
  }
}

function renderProjects() {
  const list = $("project-list");
  // 员工没变化就不重建 DOM，否则每 2.5 秒刷新一次会打断点击和悬停。
  const signature = JSON.stringify(state.workers);
  if (signature === state.projectsSignature) return;
  state.projectsSignature = signature;
  list.replaceChildren();

  if (!state.workers.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "还没有员工。点右上角「+ 新增员工」，选一个项目目录就开始。";
    list.appendChild(empty);
    return;
  }

  for (const group of groupByProject(state.workers)) {
    const wrap = el("div", "project");

    const head = el("div", "project-head");
    const title = el("div", "project-title");
    title.append(el("span", "project-name", baseName(group.path)));
    const pathCode = el("code", "project-path", group.path);
    pathCode.title = group.path;
    title.append(pathCode);
    const actions = el("div", "project-actions");
    const addHere = el("button", "ghost small", "+ 在这里加员工");
    addHere.type = "button";
    addHere.addEventListener("click", () => openWorkerModal(null, group.path));
    const open = el("button", "ghost small", "打开目录");
    open.type = "button";
    open.disabled = group.path.startsWith("（");
    open.addEventListener("click", () => openFolder(group.path));
    actions.append(addHere, open);
    head.append(title, actions);

    const cards = el("div", "worker-list");
    for (const worker of group.list) {
      cards.appendChild(workerCard(worker));
    }

    wrap.append(head, cards);
    list.appendChild(wrap);
  }
}

function workerCard(worker) {
  const card = el("div", `worker-card${worker.enabled ? "" : " disabled"}`);

  const head = el("div", "worker-head");
  head.append(el("span", "worker-name", worker.name));
  const info = workerBadge(worker);
  head.append(el("span", `worker-badge ${info.cls}`, info.text));

  const meta = el(
    "p",
    "worker-meta",
    `${worker.kindLabel || worker.kind} · ${worker.permissionMode} · 排队 ${worker.queued} · 重试 ${worker.retryMaxAttempts} 次${worker.hasSession ? " · 有记忆" : ""}`,
  );

  // 模型写清楚“实际在用哪个、这个值从哪来”，避免以为没配就是没模型。
  const modelLine = el("p", "worker-meta");
  if (worker.effectiveModel) {
    const from = worker.modelSource === "worker" ? "员工指定" : "路由配置";
    modelLine.textContent = `模型：${worker.effectiveModel}（${from}）`;
  } else {
    modelLine.textContent = "模型：未读到（路由没配，或 CLI 配置读不到）";
  }
  if (worker.baseUrl) modelLine.title = `接口地址：${worker.baseUrl}`;

  card.append(head, meta, modelLine);

  // 今日用量：让人一眼知道这个员工今天干了多少活、烧了多少 token。
  // 不显示金额——CLI 报的是会话累计，加到天级会重复计算，给了反而误导。
  const today = worker.today;
  if (today && Number(today.tasks) > 0) {
    const bits = [`今天 ${today.tasks} 个任务`];
    if (Number(today.completed) < Number(today.tasks)) bits.push(`完成 ${today.completed}`);
    const output = Number(today.outputTokens) || 0;
    if (output) bits.push(`输出 ${formatTokens(output)}`);
    const cache = Number(today.cacheReadTokens) || 0;
    if (cache) bits.push(`缓存 ${formatTokens(cache)}`);
    card.append(el("p", "worker-meta", bits.join(" · ")));
  }
  if (worker.maxBudgetUsd) {
    card.append(el("p", "worker-meta", `单任务上限 $${worker.maxBudgetUsd}（按牌价估，超了停下等你）`));
  }
  if (worker.extraDirs?.length) {
    card.append(el("p", "worker-meta", `附加目录：${worker.extraDirs.join("；")}`));
  }
  if (worker.note) {
    card.append(el("p", "worker-note", worker.note));
  }

  const actions = el("div", "worker-actions");
  const edit = el("button", "link", "编辑");
  edit.type = "button";
  edit.addEventListener("click", () => openWorkerModal(worker.id));
  const toggle = el("button", "link", worker.enabled ? "停用" : "启用");
  toggle.type = "button";
  toggle.addEventListener("click", () => toggleWorker(worker));
  const remove = el("button", "link danger", "删除");
  remove.type = "button";
  remove.addEventListener("click", () => removeWorker(worker));
  actions.append(edit, toggle, remove);
  card.append(actions);

  return card;
}

function renderWorkerSelect() {
  const select = $("worker-select");
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
    select.appendChild(option);
  }
  if (previous && state.workers.some((worker) => worker.id === previous && worker.enabled)) {
    select.value = previous;
  } else {
    const firstEnabled = state.workers.find((worker) => worker.enabled);
    if (firstEnabled) select.value = firstEnabled.id;
  }

  if (!state.cwdInitialized) {
    const selected = state.workers.find((worker) => worker.id === select.value);
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
    list.replaceChildren();
    for (const item of data.models || []) {
      const option = document.createElement("option");
      option.value = item.id;
      // datalist 有 label 时显示 label，插入的仍是 value。
      option.label = item.label || item.id;
      list.appendChild(option);
    }
    return data;
  } catch {
    return null;
  }
}

/** 派活区的模型框：留空 = 完全跟随 CLI / 路由；占位提示写出那个默认值。 */
async function syncModelField() {
  const worker = state.workers.find((item) => item.id === $("worker-select").value);
  if (!worker) return;
  const data = await fillModelOptions("model-options", worker.kind, worker.id);
  const effective = data?.current || worker.effectiveModel || "";
  const input = $("model");
  input.placeholder = effective || "跟随路由";
  input.title = effective
    ? `留空＝用路由给这个 harness 配的模型 ${effective}。只有想临时换一次时才填，别处不用改。`
    : "留空就跟随 CLI / 路由配置；想临时换一次才填。";
}

async function toggleWorker(worker) {
  try {
    await api(`/api/workers/${encodeURIComponent(worker.id)}`, {
      method: "PUT",
      body: JSON.stringify({ disabled: worker.enabled }),
    });
    setFormNote(`「${worker.name}」已${worker.enabled ? "停用" : "启用"}。`, "ok");
    await loadOverview({ quiet: true });
  } catch (error) {
    setFormNote(error.message, "error");
  }
}

async function removeWorker(worker) {
  const ok = window.confirm(`删除员工「${worker.name}」？\n已经跑过的任务记录会保留，但之后不能再派活给它。`);
  if (!ok) return;
  try {
    await api(`/api/workers/${encodeURIComponent(worker.id)}`, { method: "DELETE" });
    setFormNote(`已删除「${worker.name}」。`, "ok");
    await loadOverview({ quiet: true });
  } catch (error) {
    setFormNote(error.message, "error");
  }
}

/* ---------------- 员工表单 ---------------- */

function showModal(id, show) {
  $(id).classList.toggle("hidden", !show);
}

function renderKindOptions(selected) {
  const select = $("w-kind");
  select.replaceChildren();
  for (const adapter of state.adapters || []) {
    const option = document.createElement("option");
    option.value = adapter.kind;
    option.textContent = adapter.label;
    select.appendChild(option);
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
    select.appendChild(option);
  }
  const wanted = selected && [...select.options].some((option) => option.value === selected)
    ? selected
    : adapter?.defaultPermissionMode || select.options[0]?.value || "";
  select.value = wanted;
  updatePermHint();
}

function updatePermHint() {
  const selected = $("w-perm").selectedOptions[0];
  $("w-perm-hint").textContent = selected?.dataset.hint || "";
}

function openWorkerModal(id = null, presetCwd = "") {
  state.editingWorkerId = id;
  const worker = id ? state.workers.find((item) => item.id === id) : null;
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
  $("w-note").value = worker?.note || "";
  $("w-extra").value = (worker?.extraDirs || []).join(";");
  syncWorkerModelField(worker?.id || null);

  showModal("worker-modal", true);
  setTimeout(() => $("w-name").focus(), 40);
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
    ? (Array.isArray(worker.argsPrefix) ? worker.argsPrefix : [])
    : (template.argsPrefix || []);

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
  $("w-budget-hint").textContent = supported ? (adapter.budgetHint || "") : "";
}

/** 员工表单里的模型框：候选来自该 CLI 自己的配置，占位提示写清“留空会用什么”。 */
async function syncWorkerModelField(workerId) {
  const kind = $("w-kind").value;
  const data = await fillModelOptions("w-model-options", kind, workerId);
  const effective = data?.current || "";
  $("w-model").placeholder = effective ? `留空＝${effective}` : "留空＝跟随路由";
  $("w-model-label").textContent = effective
    ? `模型（留空＝跟随路由的 ${effective}）`
    : "模型（留空＝跟随路由）";
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
    addDirs: $("w-extra").value.split(/[;,]/).map((part) => part.trim()).filter(Boolean),
    retry: { maxAttempts: Math.max(1, Number($("w-retry").value) || 1) },
    maxBudgetUsd: Number($("w-budget").value) > 0 ? Number($("w-budget").value) : null,
  };
  const message = $("w-msg");
  message.className = "modal-note";
  message.textContent = "保存中…";
  try {
    if (state.editingWorkerId) {
      await api(`/api/workers/${encodeURIComponent(state.editingWorkerId)}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
    } else {
      await api("/api/workers", { method: "POST", body: JSON.stringify(payload) });
    }
    showModal("worker-modal", false);
    setFormNote("员工已保存，立刻生效。", "ok");
    await loadOverview({ quiet: true });
  } catch (error) {
    message.className = "modal-note error";
    message.textContent = error.message;
  }
}

async function deleteEditingWorker() {
  const worker = state.workers.find((item) => item.id === state.editingWorkerId);
  if (!worker) return;
  const ok = window.confirm(`删除员工「${worker.name}」？已经跑过的任务记录会保留。`);
  if (!ok) return;
  try {
    await api(`/api/workers/${encodeURIComponent(worker.id)}`, { method: "DELETE" });
    showModal("worker-modal", false);
    setFormNote(`已删除「${worker.name}」。`, "ok");
    await loadOverview({ quiet: true });
  } catch (error) {
    $("w-msg").className = "modal-note error";
    $("w-msg").textContent = error.message;
  }
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
    const button = el("button", "drive-chip", drive.label);
    button.type = "button";
    if (state.dir?.path?.startsWith(drive.path)) button.classList.add("active");
    button.addEventListener("click", () => loadDirectory(drive.path));
    row.appendChild(button);
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
    if (data.warning) {
      list.append(el("p", "empty", data.warning));
    }
    if (!data.dirs.length) {
      list.append(el("p", "empty", "这个目录下没有子文件夹"));
    }
    for (const dir of data.dirs) {
      const button = el("button", "dir-item");
      button.type = "button";
      button.append(el("span", "dir-icon", "▸"), el("span", "dir-name", dir.name));
      button.addEventListener("click", () => loadDirectory(dir.path));
      button.addEventListener("dblclick", () => state.onPickDir?.(dir.path));
      list.appendChild(button);
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

/* ---------------- 概览与任务 ---------------- */

function renderStages() {
  const counts = state.overview?.counts;
  if (!counts) return;
  const stages = counts.stages || {};
  $("stage-running").textContent = stages.running || 0;
  $("stage-waiting").textContent = stages.waiting || 0;
  $("stage-queued").textContent = stages.queued || 0;
  $("stage-done").textContent = stages.done || 0;

  for (const card of document.querySelectorAll(".stage-card")) {
    card.classList.toggle("active", card.dataset.stage === state.stage);
  }
  $("list-scope").textContent = STAGE_TEXT[state.stage] || "全部";
  $("clear-filter").classList.toggle("hidden", !state.stage);
}

function renderOverview() {
  if (!state.overview) return;
  renderStages();
  renderProjects();
  renderWorkerSelect();
}

function makeStatus(task) {
  const span = document.createElement("span");
  span.className = `status ${task.status}`;
  span.textContent = STATUS_TEXT[task.status] || task.status;
  return span;
}

function renderTasks() {
  const list = $("task-list");
  const tasks = state.tasks;
  list.replaceChildren();

  if (!tasks.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = state.stage
      ? `「${STAGE_TEXT[state.stage]}」里现在没有任务`
      : "还没有任务";
    list.appendChild(empty);
    return;
  }

  for (const task of tasks) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = [
      "task-item",
      task.id === state.selectedId ? "selected" : "",
      task.stage === "waiting" ? "needs-you" : "",
    ].filter(Boolean).join(" ");
    button.addEventListener("click", () => selectTask(task.id));

    const top = document.createElement("div");
    top.className = "task-item-top";
    const title = document.createElement("span");
    title.className = "task-item-title";
    title.textContent = task.title;
    top.append(title);
    if (task.acknowledgedAt) top.append(el("span", "tag", "已处理"));
    top.append(makeStatus(task));

    const meta = document.createElement("div");
    meta.className = "task-item-meta";
    const worker = document.createElement("span");
    worker.textContent = workerName(task.workerId);
    const created = document.createElement("span");
    created.textContent = shortTime(task.createdAt);
    const latest = task.progress?.[0]?.message;
    if (latest) {
      const preview = document.createElement("span");
      preview.textContent = latest;
      preview.style.overflow = "hidden";
      preview.style.textOverflow = "ellipsis";
      preview.style.whiteSpace = "nowrap";
      meta.append(worker, preview, created);
    } else {
      meta.append(worker, created);
    }
    button.append(top, meta);
    list.appendChild(button);
  }
}

function stageOf(task) {
  if (!task) return "done";
  if (task.acknowledgedAt) return "done";
  if (task.status === "queued") return "queued";
  if (["running", "retrying", "cancelling"].includes(task.status)) return "running";
  if (["waiting", "failed", "interrupted"].includes(task.status)) return "waiting";
  return "done";
}

/** token 数量按“万”压缩，避免一屏数字。 */
function formatTokens(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** 用量一句话：轮数 + 输出 + 输入 + 缓存命中。 */
function usageText(usage) {
  if (!usage) return null;
  const parts = [];
  if (usage.turns) parts.push(`${usage.turns} 轮`);
  if (usage.outputTokens) {
    const thinking = usage.thinkingTokens ? `（含思考 ${formatTokens(usage.thinkingTokens)}）` : "";
    parts.push(`输出 ${formatTokens(usage.outputTokens)}${thinking}`);
  }
  if (usage.inputTokens) parts.push(`输入 ${formatTokens(usage.inputTokens)}`);
  if (usage.cacheReadTokens) parts.push(`缓存命中 ${formatTokens(usage.cacheReadTokens)}`);
  return parts.length ? parts.join(" · ") : null;
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
    note.hidden = false;
  } else {
    note.textContent = "这个员工不上报金额，只能看 token 用量。";
    note.hidden = false;
  }
}

function renderDetail() {
  const task = state.detail;
  if (!task) {
    $("detail").classList.add("hidden");
    $("detail-empty").classList.remove("hidden");
    return;
  }
  $("detail-empty").classList.add("hidden");
  $("detail").classList.remove("hidden");

  const status = $("detail-status");
  status.className = `status ${task.status}`;
  status.textContent = STATUS_TEXT[task.status] || task.status;
  $("detail-id").textContent = task.id;
  $("detail-title").textContent = task.title;
  $("meta-worker").textContent = workerName(task.workerId);
  $("meta-started").textContent = formatTime(task.startedAt || task.createdAt);
  $("meta-duration").textContent = duration(task);
  const attempts = Number(task.attempts || 0);
  const maxAttempts = Math.max(Number(task.maxAttempts || 1), 1);
  $("meta-attempts").textContent = attempts ? `${attempts} / ${maxAttempts}` : `— / ${maxAttempts}`;
  $("meta-session").textContent = task.sessionId ? task.sessionId.slice(0, 12) : "尚未建立";
  $("meta-session").title = task.sessionId || "";
  $("meta-cwd").textContent = task.cwd || "—";
  $("open-cwd").disabled = !task.cwd;
  $("detail-prompt").textContent = task.prompt || "";
  renderUsage(task);

  const progressList = $("progress-list");
  progressList.replaceChildren();
  for (const entry of task.progress || []) {
    const item = document.createElement("li");
    const time = document.createElement("time");
    time.textContent = shortTime(entry.time);
    item.append(time, document.createTextNode(entry.message));
    progressList.appendChild(item);
  }
  if (!progressList.children.length) {
    const item = document.createElement("li");
    item.textContent = "暂无进度记录";
    progressList.appendChild(item);
  }

  const resultBlock = $("result-block");
  resultBlock.hidden = !task.result;
  $("detail-result").textContent = task.result || "";
  const errorBlock = $("error-block");
  errorBlock.hidden = !task.error;
  $("detail-error").textContent = task.error || "";
  $("detail-log").textContent = task.logTail || "暂无原始日志";

  $("copy-result").hidden = !task.result;
  const stage = stageOf(task);
  $("stop-task").hidden = !["queued", "running", "retrying", "cancelling"].includes(task.status);
  $("retry-task").hidden = !["completed", "failed", "cancelled", "interrupted"].includes(task.status);
  $("ack-task").hidden = !(stage === "waiting" && !task.acknowledgedAt);
}

async function loadDetail(id, { preserveScroll = false } = {}) {
  const previousResultScroll = $("detail-result").scrollTop;
  const previousLogScroll = $("detail-log").closest("details")?.scrollTop || 0;
  try {
    const data = await api(`/api/tasks/${encodeURIComponent(id)}`);
    if (state.selectedId !== id) return;
    state.detail = data.task;
    renderDetail();
    if (preserveScroll) {
      $("detail-result").scrollTop = previousResultScroll;
      const details = $("detail-log").closest("details");
      if (details) details.scrollTop = previousLogScroll;
    }
  } catch (error) {
    setFormNote(error.message, "error");
  }
}

async function selectTask(id) {
  state.selectedId = id;
  state.detail = null;
  renderTasks();
  await loadDetail(id);
}

async function loadOverview({ quiet = false } = {}) {
  if (state.refreshing) return;
  state.refreshing = true;
  try {
    const query = state.stage ? `?stage=${encodeURIComponent(state.stage)}` : "";
    const [overview, tasks] = await Promise.all([
      api("/api/overview"),
      api(`/api/tasks${query}`),
    ]);
    state.overview = overview;
    state.workers = overview.workers || [];
    state.tasks = tasks.tasks;
    setConnection("online", "Hub 在线");
    renderOverview();
    renderTasks();

    if (!state.selectedId && state.tasks.length) {
      await selectTask(state.tasks[0].id);
    } else if (state.selectedId && state.detail && isActive(state.detail)) {
      await loadDetail(state.selectedId, { preserveScroll: true });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const networkIssue = /fetch|network|load failed|failed to fetch/i.test(message);
    setConnection(networkIssue ? "offline" : "online", networkIssue ? "Hub 离线" : "Hub 在线");
    if (!quiet) {
      setFormNote(
        networkIssue
          ? `连不上 Hub：${message}。请先运行 npm start。`
          : `页面渲染出错：${message}`,
        "error",
      );
    }
  } finally {
    state.refreshing = false;
  }
}

async function loadTemplates() {
  try {
    const data = await api("/api/templates");
    state.templates = data.templates || [];
  } catch {
    state.templates = [];
  }
  renderTemplates();
}

function renderTemplates() {
  const box = $("template-chips");
  box.replaceChildren();
  if (!state.templates.length) {
    box.append(el("span", "template-empty", "还没有模板。写好一段任务后点右边「存为模板」。"));
    return;
  }
  for (const tpl of state.templates) {
    const chip = el("button", "template-chip");
    chip.type = "button";
    chip.title = `${tpl.prompt.slice(0, 120)}${tpl.prompt.length > 120 ? "…" : ""}`;
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
    box.appendChild(chip);
  }
}

/** 点模板只填内容，不直接派发——每次的素材和范围都会变，得让人改一遍。 */
function applyTemplate(tpl) {
  $("prompt").value = tpl.prompt;
  if (tpl.workerId && state.workers.some((item) => item.id === tpl.workerId && item.enabled)) {
    $("worker-select").value = tpl.workerId;
    const worker = state.workers.find((item) => item.id === tpl.workerId);
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
  $("save-template").hidden = !$("prompt").value.trim();
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
  try {
    await api("/api/templates", {
      method: "POST",
      body: JSON.stringify({
        name: trimmed,
        prompt,
        workerId: $("worker-select").value,
        cwd: $("cwd").value.trim(),
      }),
    });
    await loadTemplates();
    setFormNote(`已存成模板「${trimmed}」，以后点一下就能填回来。`, "ok");
  } catch (error) {
    setFormNote(error.message, "error");
  }
}

async function deleteTemplate(tpl) {
  const ok = window.confirm(`删除模板「${tpl.name}」？只删模板，已经派出去的任务不受影响。`);
  if (!ok) return;
  try {
    await api(`/api/templates/${encodeURIComponent(tpl.id)}`, { method: "DELETE" });
    await loadTemplates();
    setFormNote(`已删除模板「${tpl.name}」。`, "ok");
  } catch (error) {
    setFormNote(error.message, "error");
  }
}

async function dispatchTask() {
  const prompt = $("prompt").value.trim();
  if (!prompt) {
    setFormNote("先写任务内容。", "error");
    $("prompt").focus();
    return;
  }
  const button = $("dispatch");
  button.disabled = true;
  setFormNote("正在写入任务队列...");
  const freshStart = $("new-session").checked;
  try {
    const data = await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        workerId: $("worker-select").value || state.workers[0]?.id,
        prompt,
        cwd: $("cwd").value.trim(),
        model: $("model").value.trim(),
        newSession: freshStart,
      }),
    });
    $("prompt").value = "";
    $("new-session").checked = false;
    updateSaveTemplateVisibility();
    setFormNote(
      `已派发，任务号 ${data.task.id}${freshStart ? "（已清空记忆，从头开始）" : "（接着上次对话）"}`,
      "ok",
    );
    state.selectedId = data.task.id;
    state.detail = null;
    await loadOverview({ quiet: true });
    await loadDetail(data.task.id);
  } catch (error) {
    setFormNote(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function stopTask() {
  const task = state.detail;
  if (!task) return;
  const ok = window.confirm(`停止任务「${task.title}」？已经产生的文件修改不会自动撤销。`);
  if (!ok) return;
  try {
    await api(`/api/tasks/${encodeURIComponent(task.id)}/stop`, { method: "POST", body: "{}" });
    setFormNote("已发送停止请求。", "ok");
    await loadDetail(task.id);
    await loadOverview({ quiet: true });
  } catch (error) {
    setFormNote(error.message, "error");
  }
}

async function retryTask() {
  const task = state.detail;
  if (!task) return;
  try {
    await api(`/api/tasks/${encodeURIComponent(task.id)}/retry`, { method: "POST", body: "{}" });
    setFormNote("已重新放回队列。", "ok");
    await loadDetail(task.id);
    await loadOverview({ quiet: true });
  } catch (error) {
    setFormNote(error.message, "error");
  }
}

async function acknowledgeTask() {
  const task = state.detail;
  if (!task) return;
  try {
    await api(`/api/tasks/${encodeURIComponent(task.id)}/ack`, { method: "POST", body: "{}" });
    setFormNote("已标记处理完，移出「等你」。", "ok");
    await loadDetail(task.id);
    await loadOverview({ quiet: true });
  } catch (error) {
    setFormNote(error.message, "error");
  }
}

async function copyResult() {
  if (!state.detail?.result) return;
  try {
    await navigator.clipboard.writeText(state.detail.result);
    setFormNote("结果已复制。", "ok");
  } catch {
    setFormNote("浏览器不允许自动复制，请手动选择结果文字。", "error");
  }
}

/* ---------------- 事件绑定 ---------------- */

$("add-worker").addEventListener("click", () => openWorkerModal());
$("w-cancel").addEventListener("click", () => showModal("worker-modal", false));
$("w-cancel-2").addEventListener("click", () => showModal("worker-modal", false));
$("w-save").addEventListener("click", saveWorker);
$("w-delete").addEventListener("click", deleteEditingWorker);
$("w-browse").addEventListener("click", () => openDirPicker($("w-cwd").value.trim()));
$("w-kind").addEventListener("change", () => {
  const kind = $("w-kind").value;
  renderPermOptions(kind, null);
  // 换类型必须换启动方式：沿用上一个类型的命令，会得到一个“显示可用、一派就废”的员工。
  if (!state.commandTouched) {
    applyLaunchTemplate(kind);
  } else {
    $("w-command").placeholder = adapterOf(kind)?.commandHint || "";
  }
  updateBudgetField(kind);
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
$("dir-new").addEventListener("click", createFolderHere);
$("dir-new-name").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    createFolderHere();
  }
});
$("open-cwd").addEventListener("click", () => {
  if (state.detail?.cwd) openFolder(state.detail.cwd);
});
$("worker-select").addEventListener("change", () => {
  const worker = state.workers.find((item) => item.id === $("worker-select").value);
  if (worker?.cwd) {
    $("cwd").value = worker.cwd;
    state.cwdInitialized = true;
  }
  syncModelField();
});
$("dispatch").addEventListener("click", dispatchTask);
$("save-template").addEventListener("click", saveTemplateFromPrompt);
$("prompt").addEventListener("input", updateSaveTemplateVisibility);
$("prompt").addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    dispatchTask();
  }
});
$("stop-task").addEventListener("click", stopTask);
$("retry-task").addEventListener("click", retryTask);
$("ack-task").addEventListener("click", acknowledgeTask);
$("copy-result").addEventListener("click", copyResult);

for (const card of document.querySelectorAll(".stage-card")) {
  card.addEventListener("click", async () => {
    const next = card.dataset.stage || "";
    state.stage = state.stage === next ? "" : next;
    await loadOverview({ quiet: true });
  });
}
$("clear-filter").addEventListener("click", async () => {
  state.stage = "";
  await loadOverview({ quiet: true });
});

(async () => {
  try {
    const data = await api("/api/adapters");
    state.adapters = data.adapters;
  } catch {
    state.adapters = [];
  }
  await loadTemplates();
  await loadOverview();
  setInterval(() => {
    const active = state.detail && isActive(state.detail);
    loadOverview({ quiet: active });
  }, 2500);
})();
