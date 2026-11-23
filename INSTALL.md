# DSH 插件安装步骤

这份步骤对应你机器上的实际情况：**desktop profile**，DSH `0.2.2-rc.1`。

## 先理解一件事

这里有两个东西，别混：

| 东西         | 是什么                                     | 必须一直开着吗   |
| ---------- | --------------------------------------- | --------- |
| **Hub 服务** | 真正管队列、启动 Claude 的进程，跑在 `127.0.0.1:4647` | 是，关了就派不了活 |
| **DSH 插件** | 装在 DSH 里的遥控器：让 DSH 能派活、看状态、读结果          | 跟着 DSH 走  |

插件装好了但 Hub 没开，DSH 里的工具会报“连不上 Agent Hub”。这是正常的，不是装错。

---

## 第 0 步：把 Hub 跑起来

开一个终端，保持窗口别关：

```powershell
cd "C:\path\to\cyber-foreman"
npm start
```

看到它监听 4647 就对了。浏览器打开 `http://127.0.0.1:4647` 能出面板，说明 Hub 正常。

---

## 第 1 步：装插件

**注意：`dsh plugin` 这条命令对 desktop profile 无效。** DSH 源码里硬编码了一条规则，只要 profile 名是 `desktop` 就直接拒绝，因为桌面端要独占管理它。图形界面那条路也只认 npm 上发布过的包名，不认本地文件。

所以用 pnpm 直接装成链接：

```powershell
cd %USERPROFILE%\.dsh\profiles\desktop
pnpm add "link:C:\path\to\cyber-foreman"
```

装完在 `node_modules\` 下会出现对应的包链接，它指向项目目录。

**为什么用 `link:` 而不是 tgz：** 链接是实时的，以后改插件代码，重启 DSH 就生效，不用重新打包。tgz 是复制一份，每次改都要重装。

> 插件本身零第三方依赖，不引用 `@deepseek-ai/dsh-tools`，所以不会被 DSH 版本升级带崩。

---

## 第 2 步：注册到 bundles（关键，别漏）

**装包不等于加载。** DSH 只加载 `package.json` 里 `dsh.profile.bundles` 列出来的包。

打开这个文件：

```
%USERPROFILE%\.dsh\profiles\desktop\package.json
```

在 `bundles` 数组末尾加一行，注意上一行要有逗号：

```json
        "your-other-plugin",
        "cyber-foreman"
```

加完这一段应该长这样（只贴结尾部分）：

```json
      "bundles": [
        "@deepseek-ai/dsh-base",
        "...中间不动...",
        "your-other-plugin",
        "cyber-foreman"
      ]
```

保存。

---

## 第 3 步：重启 DSH

完全退出 DSH（不是最小化，是退出进程），再打开。

---

## 第 4 步：验证三处

**1. 左侧边栏**：应该多出一个 `Agent Hub` 图标，点开是任务面板（里面就是那个 4647 页面）。

**2. 工具列表**：DSH 里应该能用这五个工具：

| 工具                   | 干什么        |
| -------------------- | ---------- |
| `agent_hub_workers`  | 看有哪些员工、忙不忙 |
| `agent_hub_dispatch` | 派活         |
| `agent_hub_tasks`    | 列任务        |
| `agent_hub_result`   | 等结果、读回报    |
| `agent_hub_stop`     | 停任务        |

**3. 真派一个活**：对 DSH 说一句

> 用 agent_hub_dispatch 派一个任务给 Claude：在 xxx 目录建一个 test.txt，写一行 hello。

然后让它用 `agent_hub_result` 收结果。能收到 Claude 的回报，就算通了。

---

## 卸载

```powershell
cd %USERPROFILE%\.dsh\profiles\desktop
pnpm remove "cyber-foreman"
```

再把 `package.json` 里 `bundles` 那行 `"cyber-foreman"` 删掉，重启 DSH。

---

## 如果没出现面板

按顺序排查：

1. **bundles 加了吗？** 九成的问题出在这一步。
2. **DSH 真的重启了吗？** 改完配置必须重启进程。
3. **Hub 在跑吗？** 终端里 `curl http://127.0.0.1:4647/api/health`，能出 JSON 就是好的。
4. **看 DSH 启动日志**有没有 `cyber-foreman` 相关的报错。

---

## 备选：不改配置的临时挂法

如果只想先试试、不想动 profile，可以临时加载：

```powershell
dsh web --patch "C:\path\to\cyber-foreman\cordis.patch.yml"
```

这个方式不改任何配置文件，关掉就没了。适合先尝个鲜，但不适合长期用。
