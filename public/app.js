/**
 * 工作台入口：全局状态装载、轮询、阶段筛选，把各面板接起来。
 *
 * 这里只做三件事：
 *   1. 拉数据（overview + tasks + adapters + templates），失败也只降级不白屏；
 *   2. 把数据变化转成一次渲染（渲染细节在 panel-*.js 里）；
 *   3. 注册 actions，让面板之间不互相 import 也能调用刷新 / 选中。
 */

import {
  $,
  actions,
  api,
  isActive,
  setConnection,
  setFormNote,
  softApi,
  state,
} from "./panel-common.js";
import {
  initWorkbench,
  loadTemplates,
  renderDetail,
  renderProjects,
  renderStatusline,
  renderTasks,
  renderWorkerSelect,
} from "./panel-workbench.js";
import { initTalk } from "./panel-talk.js";
import { initChannels } from "./panel-channels.js";

const REFRESH_MS = 2500;

function renderAll() {
  renderStatusline();
  renderProjects();
  renderWorkerSelect();
  renderTasks();
}

/** 读一条任务的完整详情（结果、进度、日志、插话都在这里）。 */
async function loadDetail(id, { preserveScroll = false } = {}) {
  const scrollTop = preserveScroll ? $("inspector")?.scrollTop || 0 : 0;
  const result = await softApi(`/api/tasks/${encodeURIComponent(id)}`);
  if (state.selectedId !== id) return;
  if (!result.ok) {
    if (!result.notImplemented) {
      setFormNote(`读不到任务详情：${result.error?.message || ""}`, "error");
    }
    renderDetail();
    return;
  }
  state.detail = result.data.task || null;
  renderDetail();
  if (preserveScroll) {
    const box = $("inspector");
    if (box) box.scrollTop = scrollTop;
  }
}

async function selectTask(id) {
  state.selectedId = id;
  state.talk.note = "";
  state.talk.noteType = "";
  state.talk.warning = "";
  state.detail = null;
  state.flowSignature = "";
  renderTasks();
  await loadDetail(id);
}

async function loadOverview({ quiet = false } = {}) {
  if (state.refreshing) return;
  state.refreshing = true;
  try {
    const params = new URLSearchParams();
    if (state.stage) params.set("stage", state.stage);
    // role=all 才带侧问；老后端会忽略这个参数，行为不变。
    params.set("role", state.showSide ? "all" : "main");
    const query = `?${params.toString()}`;

    const [overview, tasks] = await Promise.all([api("/api/overview"), api(`/api/tasks${query}`)]);
    state.overview = overview;
    state.workers = overview.workers || [];
    state.tasks = tasks.tasks || [];
    setConnection("online", "中枢在线");
    renderAll();

    if (!state.selectedId && state.tasks.length) {
      await selectTask(state.tasks[0].id);
    } else if (state.selectedId && !state.detail) {
      await loadDetail(state.selectedId);
    } else if (state.selectedId && state.detail && isActive(state.detail)) {
      // 只有还在跑的任务需要跟着刷；已结束的别动，否则用户滚到哪都会被拽回去。
      await loadDetail(state.selectedId, { preserveScroll: true });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const networkIssue = /fetch|network|load failed|failed to fetch|连不上/i.test(message);
    setConnection(networkIssue ? "offline" : "online", networkIssue ? "中枢离线" : "中枢在线");
    if (!quiet) {
      setFormNote(
        networkIssue ? `${message}。请先运行 npm start。` : `页面渲染出错：${message}`,
        "error",
      );
    }
  } finally {
    state.refreshing = false;
  }
}

function wireActions() {
  actions.refresh = () => loadOverview({ quiet: true });
  actions.hardRefresh = () => {
    // 手动刷新：连下拉选项和员工列表一起重建，别留过期缓存。
    state.selectSignature = "";
    state.projectsSignature = "";
    return loadOverview({ quiet: false });
  };
  actions.selectTask = (id) => selectTask(id);
  actions.reloadDetail = () => loadDetail(state.selectedId, { preserveScroll: true });
  actions.clearSelection = () => {
    state.selectedId = null;
    state.detail = null;
    state.talk.note = "";
    state.talk.warning = "";
    state.flowSignature = "";
    document.body.dataset.detail = "closed";
    const empty = $("detail-empty");
    if (empty) empty.classList.remove("hidden");
    const detail = $("detail");
    if (detail) detail.classList.add("hidden");
    renderDetail();
  };
  actions.setStage = async (stage) => {
    state.stage = stage;
    state.flowSignature = "";
    await loadOverview({ quiet: true });
  };
}

async function boot() {
  wireActions();
  document.body.dataset.side = "open";
  // 先让骨架能点，再去拿数据：任何一个接口慢或 404，界面都还在。
  initWorkbench();
  initTalk();
  initChannels();

  const adapters = await softApi("/api/adapters");
  state.adapters = adapters.ok ? adapters.data.adapters || [] : [];

  await loadTemplates();
  await loadOverview();

  state.booted = true;
  window.__hubBooted = true;

  window.setInterval(() => {
    // 切到后台就不刷，省得白跑。
    if (document.hidden) return;
    loadOverview({ quiet: true });
  }, REFRESH_MS);
}

boot().catch((error) => {
  // 兜底：即使启动过程里出了意料外的错，也要说清是什么，并把看门狗关掉。
  window.__hubBooted = true;
  setConnection("offline", "启动失败");
  setFormNote(`界面启动失败：${error instanceof Error ? error.message : String(error)}`, "error");
});
