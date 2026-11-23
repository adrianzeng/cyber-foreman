# MCP 接入指南（WorkBuddy / 豆包工作桌面端 / Claude Desktop / Cursor）

**CyberForeman（赛博包工头）** 是一个完全独立运行的本地多 Agent 调度中枢。除了独立网页看板（`http://127.0.0.1:4647`），还提供标准 STDIO MCP Server 入口 `cyber-foreman-mcp`（[bin/cyber-foreman-mcp.mjs](../bin/cyber-foreman-mcp.mjs)，向后兼容旧入口 `dsh-agent-hub-mcp`），可直接桥接到主流桌面端 MCP 主控客户端。

## 架构定位

- **主控入口（第一顺位）**：**WorkBuddy 桌面端**、**豆包工作桌面端**、**Claude Desktop**、**Claude Code / Cursor** 作为自然语言总控，负责拆解需求、挑选员工与收口汇总。
- **独立调度中枢**：本地 CyberForeman 服务（默认 `http://127.0.0.1:4647`）独立管理队列、单员工串行锁、会话记忆、自动重试、日志落盘与手机通知推送。
- **极简薄转发层**：`cyber-foreman-mcp` 仅把 MCP `tools/list` 和 `tools/call` 转发到本地 HTTP API，不重复实现队列或状态机，也不接触任何账号凭证。若本地后台未启动，会直接返回友好的中文启动指引，不抛出原始网络堆栈。

## 前置步骤：先启动本地 CyberForeman

在接入任何桌面端 MCP 客户端前，先确保本地中枢正在运行：

```bash
# 方式 1：npx 零配置启动
npx cyber-foreman

# 方式 2：在源码目录启动
npm start
```

默认监听 `http://127.0.0.1:4647`。如果改了端口，可在 MCP 配置的 `env` 中通过 `CYBER_FOREMAN_URL`（也兼容旧变量 `DSH_HUB_URL`）指定。

---

## 暴露的 5 个 MCP Tools

| 工具名 | 作用 | 关键参数 |
|---|---|---|
| `list_workers` | 查询可用 CLI 员工、类型、绑定目录与空闲/忙碌状态（派活前先调） | 无 |
| `dispatch_task` | 向指定员工派发子任务，立即返回 `taskId` | `workerId`、`prompt`、可选 `cwd`、可选 `resetSession` |
| `get_task_status` | 查询任务四阶段状态（`queued`/`running`/`waiting`/`done`）、进度、输出摘要与错误 | `taskId` |
| `say_to_task` | 向任务中插话或发起只读侧问（`auto` 能插则插、否则降级侧问） | `taskId`、`text`、可选 `mode`（`auto`/`steer`/`side`） |
| `cancel_task` | 停止排队中、重试中或执行中的任务 | `taskId` |

---

## 客户端配置示例

> 提示：已发布或全局安装时推荐使用 `npx -y cyber-foreman-mcp`；本地源码开发态可将 `command` 设为 `"node"`、`args` 设为 `["C:/path/to/cyber-foreman/bin/cyber-foreman-mcp.mjs"]`，启动更快且不依赖网络。

### 1. WorkBuddy 桌面端（主控入口推荐）

在 WorkBuddy 桌面端的 MCP 服务器配置（Settings → MCP Servers → 添加自定义 STDIO Server / 编辑 `mcp.json`）中加入：

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

本地源码直连写法：

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

接入后即可直接在 WorkBuddy 里下达指令：
- 「先调用 `list_workers` 看看本机有哪些员工空闲」
- 「把前端样式梳理派给 `claude-main`，测试核对派给 `codex-main`，完成后汇总给我」

### 2. 豆包工作桌面端（主控入口推荐）

在豆包工作桌面端的 MCP 工具配置（设置 → MCP / 外部工具 → JSON 导入）中加入：

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

### 3. Claude Desktop / Claude Code / Cursor

- **Claude Desktop**（`claude_desktop_config.json`）
- **Claude Code**（`.mcp.json` 或 `~/.claude.json`）
- **Cursor**（`.cursor/mcp.json` 或全局 Cursor MCP 设置）

统一配置片段：

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

---

## 常见问题排查

- **调用提示 `未检测到运行中的本地 CyberForeman（赛博包工头）服务`**：先运行 `npx cyber-foreman` 或 `npm start`（或双击 `start-hub.bat`），并核对 `CYBER_FOREMAN_URL` 端口与启动横幅一致。
- **Windows 路径转义**：使用本地源码路径时，建议写正斜杠（`C:/path/to/cyber-foreman/bin/cyber-foreman-mcp.mjs`）或双反斜杠（`\\`）。
- **权限边界**：MCP 工具只转发给本地中枢，不会绕过 Claude `acceptEdits` 或 Codex `workspace-write` 的安全限制。
