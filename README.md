# CyberForeman（赛博包工头）

> **打工人上班已经够累了，是时候从「一线搬砖」晋升成「赛博包工头」了。**
>
> 把 Claude Code、Codex、Antigravity、Kimi CLI、豆包 CLI 统统收编成你的本地 AI 施工队：统一派单、盯场监工、随时插话返工、验收拿结果——脏活累活交给底层 Agent 班组去卷，你只管坐镇总控台当甲方拍板。

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Node.js >= 22](https://img.shields.io/badge/Node.js-%3E%3D22-brightgreen.svg)](https://nodejs.org/)
[![Version 1.0.0](https://img.shields.io/badge/version-1.0.0-blue.svg)](./CHANGELOG.md)

---

## 为什么做 CyberForeman？

装了三五个 AI 编程 CLI 之后，日常工作反而变碎了：
- 电脑上开着五六个终端窗口，哪个在跑、哪个卡死、哪个写完全靠肉眼切屏；
- 离开工位想让家里的 CLI 顺手跑个巡检、修个 Bug，回来还得翻半天日志；
- 想让桌面端主控（WorkBuddy / 豆包工作 / Claude Desktop / Cursor）统筹多个本地 CLI 分工协作，彼此却互不认识。

**CyberForeman（赛博包工头）** 是一个**完全独立运行的本地多 Agent 调度中枢**——不绑定任何单一宿主，只做一件事：**让你像包工头管班组一样，在一个总控台里调度本机所有 AI CLI。**

```text
  WorkBuddy / 豆包工作 / Claude Desktop / Cursor（桌面主控 · STDIO MCP）
                        │
   独立网页看板 ────────┼─────── 手机四通道遥控（Telegram / 飞书 / QQ / 微信）
  (127.0.0.1:4647)      ▼
          ┌───────────────────────────────┐
          │  CyberForeman · 本地调度中枢   │
          │  队列 · 串行锁 · 会话隔离 · 重试 │
          └───────────────┬───────────────┘
      ┌─────────┬─────────┼─────────┬─────────┐
      ▼         ▼         ▼         ▼         ▼
  Claude Code  Codex  Antigravity  Kimi CLI  豆包 CLI
```

---

## 核心特性

- **跨桌面端 MCP 调度枢纽**：内置超薄标准 STDIO MCP 入口（`cyber-foreman-mcp`），一键接入 **WorkBuddy 桌面端 / 豆包工作桌面端 / Claude Desktop / Cursor**，让桌面主控 Agent 直接拆解需求、挑选空闲员工并收回成果。
- **零构建独立网页看板**：浏览器打开 `http://127.0.0.1:4647` 即用——按项目目录分组管理员工、四阶段工单流、任务模板全功能编辑、运行中流式插话与只读侧问、重启中断任务一键批量复工。
- **手机四通道遥控 + 主动汇报**：支持 **Telegram / 飞书 / QQ 官方 Bot（WebSocket 无需公网 IP）/ 合规微信本地桥接 & 企业微信 Webhook**；任务完成或失败卡住落入「等你」时，自动把结果摘要推到手机（每通道独立开关）。
- **五大 CLI 员工矩阵**：开箱自动探测本机已安装的 **Claude Code (`claude-cli`)**、**Codex (`codex-cli`)**、**Antigravity (`agy-cli`)**、**Kimi CLI (`kimi-cli`)**、**豆包 CLI (`doubao-cli`)**；模型候选列表按员工类型严格隔离，支持实时刷新与自定义手输。
- **静默后台常驻（不丢服务）**：Windows 双击 `start-hub.bat` 自动后台常驻、关窗不断流，随时双击 `stop-hub.bat` 干净停机。
- **数据完全本地、安全护栏内置**：默认仅监听 `127.0.0.1:4647`，防 DNS Rebinding、绝不转发账号凭证、保留各 CLI 原生沙箱边界、通道密钥全程掩码脱敏。

---

## 快速启动

环境要求：**Node.js >= 22**。

### 方式 1：克隆仓库本地运行（当前推荐）

```bash
git clone https://github.com/adrianzeng/cyber-foreman.git
cd cyber-foreman
npm install
npm start
```

Windows 一键后台常驻（适合录屏与全天挂机，关掉终端也不会断服务）：
- 启动：双击根目录的 [start-hub.bat](./start-hub.bat)（或运行 `npm run start:bg`），黑框 2 秒自动关闭并自动打开 `http://127.0.0.1:4647`。
- 停止：双击 [stop-hub.bat](./stop-hub.bat)（或运行 `npm run stop`）。

### 方式 2：npx / CLI 参数启动

```bash
npx cyber-foreman --open
npx cyber-foreman --port 4700 --data-dir D:\foreman-data
npx cyber-foreman --no-channels
npx cyber-foreman --help
```

> 向后兼容：旧命令名 `dsh-agent-hub` 与 `dsh-agent-hub-mcp` 继续保留转发，既有配置无需修改即可无缝过渡。

首次在全新目录启动时**无需任何预配置文件**，中枢会自动初始化数据目录并探测本机已安装的 CLI；打开 `http://127.0.0.1:4647` 点左上角 `+` 即可招募员工。批量配置示例见 [config/workers.example.json](./config/workers.example.json) 与 [config/channels.example.json](./config/channels.example.json)。

---

## 桌面端 MCP 接入（WorkBuddy / 豆包工作 / Claude Desktop / Cursor）

保持本地 CyberForeman 后台运行（默认 `http://127.0.0.1:4647`），在任意支持 STDIO MCP 的桌面端加入以下配置：

```json
{
  "mcpServers": {
    "cyber-foreman": {
      "command": "npx",
      "args": ["-y", "cyber-foreman-mcp"],
      "env": {
        "CYBER_FOREMAN_URL": "http://127.0.0.1:4647"
      }
    }
  }
}
```

本地源码态（免下载、毫秒启动）可直接指定脚本路径：

```json
{
  "mcpServers": {
    "cyber-foreman": {
      "command": "node",
      "args": ["C:/path/to/cyber-foreman/bin/cyber-foreman-mcp.mjs"],
      "env": {
        "CYBER_FOREMAN_URL": "http://127.0.0.1:4647"
      }
    }
  }
}
```

暴露 5 个双语 MCP Tools：`list_workers`、`dispatch_task`、`get_task_status`、`say_to_task`（支持 `auto` / `steer` / `side`）、`cancel_task`。若本地中枢尚未启动，MCP 入口会返回清晰中文启动指引，绝不抛原始网络堆栈。完整多客户端配置见 [docs/mcp-integration.md](./docs/mcp-integration.md)。

---

## 手机四通道遥控速查

在网页看板右上角点 **「通道」**，配置并启用任意通道后点击 **「生成配对码」**，在手机聊天框发送 `/绑定 6位配对码` 即可生效（配对码 10 分钟过期、用后即焚）。

| 通道 | 接入方式 | 特点 |
|---|---|---|
| **Telegram** | Bot Token 长轮询 | 无需公网 IP，双向遥控 + 自动结果推送 |
| **飞书** | 官方长连接 SDK（App ID + Secret） | 无需公网回调地址，支持私聊与群聊 `@` |
| **QQ** | QQ 开放平台官方 Bot WebSocket | `AppID` + `ClientSecret`，无需公网 IP |
| **企业微信 / 微信** | 企微官方群机器人 Webhook + 合规本地桥接 | 严格合规，绝不碰封号风险逆向协议 |

常用手机指令：

| 指令 | 说明 |
|---|---|
| `/员工` | 列出所有员工编号、职责、绑定项目目录及状态（★ 标当前默认） |
| `/派 任务内容` 或直接发文字 | 派给当前默认员工；若已有 1 个任务在跑则自动插话或降级只读侧问 |
| `/派 @3 任务内容` / `/派 @前端 ...` | 临时点名某位员工干活（不改默认员工，自动切到对方项目目录） |
| `/换 3` | 切换会话默认员工（工作目录跟着员工走，绝不串项目） |
| `/侧问 问题` | 对当前任务发起只读问答（不改文件、不污染主会话记忆） |
| `/任务` / `/看 1` / `/停 1` | 查看最近工单列表、详情输出或中止指定任务 |
| `/清空` | 下一次派活清空该员工在当前目录的历史会话记忆 |

---

## 四阶段工单机制

每一笔派出去的活，在网页看板、MCP 接口与手机推送里统一走同一套四阶段状态机：

1. **队列（`queued`）**：排在对应员工的串行队列里，同一员工同一时刻只改一件事，杜绝文件写冲突；不同员工天然并发。
2. **在跑（`running` / `retrying`）**：CLI 子进程执行中，支持实时日志流、600ms 防抖插话（流式员工）以及偶发故障指数退避自动重试。
3. **等你（`waiting` / `failed` / `interrupted`）**：重试耗尽、确定性权限拦截（不浪费重试）或服务重启导致中断时进入「等你」，自动推给手机；支持单条重派、标记已处理以及 **「一键重派全部中断任务」**。
4. **已结束（`completed` / `cancelled`）**：任务完成或手动取消，完整留存输出摘要、原始日志、会话 ID 与归一化 token/费用统计。

---

## 安全与合规护栏

- **仅限本机回环**：默认绑定 `127.0.0.1`，严格校验 `Host` / `Origin` 防 DNS Rebinding；若显式绑定 `0.0.0.0` 会在控制台与健康接口给出明显警告。
- **原生权限边界不妥协**：保持 Claude `acceptEdits` 与 Codex `workspace-write` 默认安全边界；Antigravity 仅在用户显式设为 `auto` 时放行无头执行，只读侧问强制 `plan` 模式。
- **零凭据转发**：所有 CLI 直接复用本机已登录态；MCP 层只做本地 HTTP 薄转发；通道 Token / Secret / Webhook URL 全程掩码并在日志中自动脱敏。
- **隐私数据彻底隔离**：运行期任务、日志、会话、真实员工配置与通道凭据全部落在 `data/`（已写入 `.gitignore`），永不随代码提交或随 npm 包发布。

---

## 演进路线与附录

- **开发路线图**：[ROADMAP.md](./ROADMAP.md)
- **更新日志**：[CHANGELOG.md](./CHANGELOG.md)
- **`v1.1.0` 前端重塑蓝图**（2D 像素工位双视图、右侧产物实时预览、员工中途热切换 Handoff、可选 Git Worktree 隔离）：[docs/ui-inspiration.md](./docs/ui-inspiration.md)
- **可选附录 · DSH 插件兼容模式**：原有 `plugin/` 目录仍完整保留，如需以插件方式嵌入 DeepSeek Harness，请参阅 [INSTALL.md](./INSTALL.md)。

## 开源协议

[MIT](./LICENSE)
