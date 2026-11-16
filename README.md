# DSH Agent Hub

DSH 当总调度，独立 Hub 管队列和结果，命令行 Agent 当员工。当前接入：**Claude**、**Codex**、**反重力（Antigravity，默认停用：账号地区受限）**。

新增员工的完整说明见 `CHANGELOG.md` 与面板上的「+ 新增员工」。

## 任务中对话

任务在跑时可以在右栏直接说话，不用等它结束：

- **插话**：把新要求追加到正在跑的员工进程，会改变这次任务的走向。目前只有 Claude CLI 支持，要先在员工设置里打开「允许插话」。
- **侧问**：另起一条只读任务问一句，不打断主任务、不改文件、也不会冲掉主任务的会话记忆。
- **Enter 默认走 `auto`**：能插就插，插不进去自动降级成侧问；对着侧问结果按 Enter 就是「继续追问」，新侧问仍挂在原主任务下面。

接口统一是 `POST /api/tasks/:id/say`，带 `text` 与 `mode`（`auto` / `steer` / `side`）。判定规则只在后端一处，网页和手机消息走同一套。

## 工单阶段

面板只看四个阶段，比原始 `status` 更接近「我现在要不要动手」：

| 阶段 | 包含的原始状态 | 含义 |
|---|---|---|
| **在跑** | `running` / `retrying` / `cancelling` | 机器在干，含自动重试等待，不用管 |
| **等你** | `failed` / `interrupted` / `waiting` | 卡在人身上：重试耗尽、Hub 中断、员工求助 |
| **队列里** | `queued` | 排着，还没轮到 |
| **已结束** | `completed` / `cancelled` / 已标记处理 | 完成或已收尾 |

「等你」里的任务有两个出口：**重新派发**（额度重置再跑一次）或**已处理**（不改状态，只移出等你）。
`stage` 由服务端派生，不写盘；接口用 `GET /api/tasks?stage=waiting`。

## 失败自动重试

员工配置里写 `retry` 就启用，不写就不重试（**面板新建的员工默认写 3 次**）：

```json
"retry": { "maxAttempts": 3, "baseDelayMs": 3000, "maxDelayMs": 60000 }
```

- 间隔按 3s → 6s → 12s 递增，封顶 60s。
- 重试使用**全新会话**：上一次可能停在半截，续接容易原地复发同一个错误。
- **配置类错误不重试**（命令不存在、员工停用、类型不支持），直接进「等你」。
- 重试耗尽才落 `failed`，面板上就是「等你」，由人决定重派还是收掉。

## 结构

- `src/server.mjs`：本地 Hub，只监听 `127.0.0.1:4647`
- `src/hub.mjs`：任务队列、状态机、停止、会话续接、自动重试
- `src/store.mjs`：任务持久化与阶段派生（`stageOf`）
- `src/workers-store.mjs`：员工配置的校验、落盘与热加载
- `src/fsutil.mjs`：命令探测、盘符/目录枚举、路径检查
- `src/adapters/`：员工适配器与注册表
  - `claude.mjs`、`codex.mjs`、`agy.mjs`
  - `index.mjs`：按 `kind` 查适配器；新增类型在这里加一行
  - `shared.mjs`：三种 CLI 共用的启动、逐行解析与收尾
- `plugin/index.mjs`：DSH 工具（派活、列表、结果、停止、重派）
- `plugin/client.mjs`：DSH 左侧 Agent Hub 面板
- `public/`：独立网页工作台（三栏），拆成 `app.js` / `panel-common.js` / `panel-workbench.js` / `panel-talk.js` / `panel-channels.js`
- `src/channels/`：手机消息通道。Telegram（long polling）、飞书（WebSocket 长连接）已可用；企业微信、个人微信只留接口位
- `src/routes/channels.mjs`：通道配置、配对码、绑定、测试连接接口
- `bin/dsh-agent-hub.mjs`：命令行 / 未来 npx 入口；`src/cli-options.mjs` + `src/config.mjs` 负责参数与路径解析
- `tools/launch.mjs` + `start-hub.bat` + 桌面 bat：双击启动链路
- `config/workers.json`：员工与工作目录配置
- `data/`：任务、日志、会话号，只保存在本机
- `CHANGELOG.md`：版本更新日志
- `INSTALL.md`：DSH 插件安装步骤

## 启动 Hub

**最省事：双击桌面上的「启动 Agent Hub.bat」。** 会弹出一个黑色窗口并自动打开面板。这个窗口不要关——关掉窗口就是停止服务，手机上就派不了活了。

也可以在命令行里手动启动：

```powershell
cd "E:\workPM\dsh-agent-hub"
npm start
```

`npm start` 和双击走的是同一个入口（`bin/dsh-agent-hub.mjs`），也是以后 `npx dsh-agent-hub` 那条路。想换端口或数据目录：

```powershell
npm run cli -- --port 4648 --data-dir "D:\my-hub-data"
```

保持窗口运行，然后打开：

```text
http://127.0.0.1:4647
```

## 挂到 DSH

先用临时 overlay 试，不改现有 DSH 配置。另开一个终端：

```powershell
dsh web --patch "E:\workPM\dsh-agent-hub\cordis.local.yml"
```

`cordis.local.yml` 里的插件路径必须是绝对路径。稳定使用时可把 `cordis.patch.yml` 通过 `dsh plugin --profile web add` 安装进 profile；安装前先看下一节。

## 安全边界

- Hub 只接受本机回环地址，不接受外部网络访问。
- Claude 默认使用 `acceptEdits`，并设置 `--permission-prompts none`：可以改文件，需要人工批准的命令会被拒绝，而不是自动给全权限。
- 没有使用 `--dangerously-skip-permissions`。
- Codex 用 `workspace-write` + 自动审批：只能改工作目录，不出沙箱。
- 自动重试只在进程/接口失败时触发，不会重复执行已经成功的任务；重试次数有上限（默认 3 次）。
- 每个任务有独立工作目录，建议不要让两个任务同时改同一批文件。
- 停止任务会结束员工进程树，但不会回滚已经写入的文件。
- 任务内容和结果保存在 `data/`，不会上传网络；DSH 只通过本机 HTTP 读取。

## 测试

```powershell
npm test
```

测试使用假 CLI，不消耗任何模型额度，覆盖：完成、失败、停止后队列续跑、排队取消、会话续接、工单阶段与标记已处理、自动重试成功、重试耗尽后人工重派、配置类错误不重试、员工增删改与校验、目录选择接口、配置分层重启、HTTP 接口（含阶段筛选与重派/已处理）。

## 在面板里加员工（不用改文件）

1. 点右上角「+ 新增员工」。
2. 填名字，选类型（Claude / Codex / 反重力）。
3. 点「选择目录」→ 选盘符（C/D/E 都行）→ 进到项目文件夹；没有就现场「新建」。
4. 需要的话再填「附加目录」，把另一个盘上的素材挂进来。
5. 保存，**立刻生效**，不用重启 Hub。

员工按项目目录分组显示，每个项目一组，可以「+ 在这里加员工」「打开目录」。
停用只挡新任务；删除前要先停掉它在跑或排队的任务。

## 配置分层

- `config/workers.json`：**种子模板**，只在第一次启动、`data/workers.json` 不存在时用来初始化。升级不会覆盖你的员工。
- `data/workers.json`：**运行时真配置**，面板改的就是它。想手工备份/迁移，复制这个文件即可。

`config/workers.json` 里还保留 `port`、`dataDir` 两项，属于启动参数，不随面板变化。

```json
{
  "port": 4647,
  "dataDir": "./data",
  "workers": {
    "claude-main": {
      "name": "Claude 主员工",
      "kind": "claude-cli",
      "command": "C:\\Users\\YOUR_NAME\\.local\\bin\\claude.exe",
      "cwd": "C:\\path\\to\\workspace",
      "permissionMode": "acceptEdits",
      "addDirs": [],
      "retry": { "maxAttempts": 3, "baseDelayMs": 3000, "maxDelayMs": 60000 }
    }
  }
}
```

`cwd` 是默认工作区；派任务时可由 DSH 临时指定。

**模型**：留空就用这个 CLI 当前配置里的模型（面板会显示具体是哪个）。模型是路由层（如 cc-switch）配的，Hub 不参与管理；填写只覆盖这一次任务。候选列表只来自三个地方：Claude 自己的 `ANTHROPIC_MODEL` 与 `ANTHROPIC_DEFAULT_*_MODEL` 别名映射、Codex 自己的 `config.toml`，**不读任何外部工具的模型库**。

**记忆**：会话按「员工 + 工作目录」记。同一个员工在同一个项目里会接着上次的对话；换一个项目目录就是全新开始。派活时勾「清空记忆」可以强制从头开始。

**用量**：任务详情显示本次的轮数、输出 token（含思考）、输入和缓存命中。金额只做参考——CLI 报的是**整个会话累计**、按 Claude 牌价估的，不是你实际扣费，所以今日汇总只统计 token。

**预算刹车**：Claude 员工可设「单任务花费上限」，超了停下落「等你」。它是每轮结束后才检查，最多会超出一轮的量，属于防跑飞而不是硬上限。Codex 不支持。

**模板**：派活区上方可以存常用任务，点一下把提示词、员工、目录一起填好。点模板只填不派发，改完再按「派发任务」。存在 `data/templates.json`。

## 当前限制

- 一个员工同时只跑一个任务，其余任务排队。
- 面板固定连接 `127.0.0.1:4647`；改端口后面板地址也要同步改。
- Hub 重启时，正在运行或等待重试的任务会标记为 `interrupted`（落在「等你」），不会自动重跑。
- 面板能改员工，但改端口、改数据目录仍要动 `config/workers.json` 并重启。
- 还没有：产物归档、人优先槽位、通知推送、触发器。
- 模板只能新建和删除，还不能改名或改内容。
