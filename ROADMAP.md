# CyberForeman（赛博包工头）演进路线图 (ROADMAP)

> 定位：独立运行的本地多 Agent 调度中枢（跨桌面端 MCP 枢纽 + 独立网页看板 + 手机四通道遥控 + 多 CLI 员工矩阵）。

## 架构与安全红线

贯穿所有里程碑、不可突破的底线：

1. **MCP 入口极度轻量**：`bin/cyber-foreman-mcp.mjs`（及兼容入口 `bin/dsh-agent-hub-mcp.mjs`）与 `src/mcp/` 只做 STDIO JSON-RPC 到本地 HTTP（默认 `http://127.0.0.1:4647`）的薄转发，不在 MCP 进程内重复实现任务队列、状态机或持久化。
2. **本机子进程合规隔离**：所有 CLI 适配器严格遵循「本机子进程调用、单员工串行排队、限定工作目录、不接触/不转发账号凭证」原则。
3. **不放松权限边界**：保持 Claude `acceptEdits` + `--permission-prompts none` 与 Codex `workspace-write` 默认安全边界，绝不引入全盘免审参数。

---

## 里程碑规划

### v0.8.5 — MCP Server 双向枢纽化 & AGY 激活（已完成）

- **标准 STDIO MCP Server 入口**：新增 `bin/dsh-agent-hub-mcp.mjs` 并注册至 `package.json#bin`，支持 `DSH_HUB_URL` 环境变量（默认 `http://127.0.0.1:4647`）。
- **5 个核心 MCP Tools**：`list_workers`、`dispatch_task`、`get_task_status`、`say_to_task`、`cancel_task`，附带中英双语说明以引导主控 Agent 拆解与派发任务。
- **激活 Antigravity (`agy`) 自动探测**：升级 `src/fsutil.mjs` 增加可扩展的 `CLI_PROBES` 探测机制，本机检测到 `agy` 可执行文件时默认启用，移除 `README.md` 与配置中的旧停用说明。
- **文档与自动化测试**：新增 `docs/mcp-integration.md`（覆盖 WorkBuddy 桌面端、豆包工作桌面端、Claude Code / Cursor 接入示例）与基于 mock HTTP 的 MCP 转发层测试。

### v0.9.0 — 修复三项体验缺陷 + 扩展首批主流 CLI 适配器矩阵（已完成）

- **修复 Antigravity (`agy-cli`) 派活问题**：严格核对 `agy --help`，补齐 `init` / `step_update` / `denied_actions` 解析与用量归一化，侧问强制 `plan`，无头权限拦截导致的空响应不再静默标记完成。
- **修复模型候选串台与缓存**：`src/models.mjs` 按员工 `kind` 严格隔离，支持 `GET /api/models?refresh=1` 实时重读与 `agy models` 探针，前端派活区与员工弹窗均增加「刷新」按钮并支持直接输入自定义模型名。
- **统一品牌名**：全仓库与界面将「反重力」统一改为 `Antigravity`。
- **新增适配器与自动探测**：新增 `src/adapters/kimi.mjs`（`kimi-cli`）与 `src/adapters/doubao.mjs`（`doubao-cli`），扩展 `src/fsutil.mjs` 的 `CLI_PROBES` 与全量假 CLI 自动化测试。

### v0.9.5 — 独立中台化、多通道扩展与日常痛点补齐（已完成）

- **架构独立化**：定位升级为完全独立运行的本地多 Agent 调度中台（独立 HTTP + 独立网页工作台 + 标准 MCP 作为第一顺位，`plugin/` 降级为可选 DSH 兼容附录）；优化 `dsh-agent-hub-mcp` 本地服务未启动时的中文友好引导。
- **前端重塑蓝图**：新增 `docs/ui-inspiration.md`，沉淀自 T3 Code、AionUi、VibeValley 与 Star-Office-UI 吸收的双视图切换、右侧产物实时预览、任务热切换 Handoff、可选 Git Worktree 隔离与每日工作小记规划。
- **多通道扩展（QQ & 合规微信/企业微信）**：新增 `src/channels/qq.mjs`（QQ 开放平台官方 WebSocket 长连接），重构 `src/channels/wechat.mjs`（本地合规扫码/桌面桥接）与 `src/channels/wecom.mjs`（官方群机器人 Webhook + 本地合规插件桥接），补齐面板配置项与脱敏规则。
- **主动通知推送**：任务进入 `completed` 或落入「等你」（`failed` / `waiting` / `interrupted`）时，向已绑定且开启 `notifyEnabled` 的多通道自动推送结果摘要或卡点原因（支持每通道开关）。
- **日常效率补齐**：前端模板区增加全功能编辑弹窗（`PUT /api/templates/:id`）；任务流顶部与后端新增重启中断任务一键批量重派（`POST /api/tasks/retry-interrupted`）。

### v1.0.0 — 正式封版与全局品牌重塑（已完成）

- **全局品牌重塑**：正式定名 **CyberForeman（赛博包工头）**，npm 包名升级为 `cyber-foreman`，新增主入口 `bin/cyber-foreman.mjs` 与 `bin/cyber-foreman-mcp.mjs`（同时保留 `dsh-agent-hub` / `dsh-agent-hub-mcp` 向后兼容转发）。
- **零配置一键启动**：`npx cyber-foreman` 在全新无本地配置目录下自动初始化数据目录并探测五大 CLI，零报错启动。
- **全量假 CLI 自动化测试**：覆盖五大适配器、MCP 转发层、五通道与通知推送、重启恢复及全新环境启动，零模型额度消耗。
- **开源发版完备**：补齐正式版 `README.md`、`CHANGELOG.md`、`LICENSE`（MIT）、`.gitignore` 安全隔离与 `npm pack --dry-run` 打包体检。
