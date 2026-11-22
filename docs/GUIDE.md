# Agent Team 使用与架构说明（v1.9.0）

> 这份文档是**完整说明**：它是什么、怎么装、怎么用、里面怎么转、每个功能与接口的准确含义、以及已知边界。
> 想先看结论：第 1 节「三分钟速览」。想改代码：第 3 节「架构」；想排错：第 12 节。
>
> 配套文档：设计依据 [`charter-default.md`](./charter-default.md) ｜ 实测记录 [`verification-p2.md`](./verification-p2.md) ｜ 面板规格 [`panels.md`](./panels.md) ｜ 版本与边界 [`../CHANGELOG.md`](../CHANGELOG.md)

---

## 1. 三分钟速览

**它是什么**：给 DeepSeek Harness（DSH）加两个工作模式——`Agent Team · Leader` 与 `Agent Team · Worker`。
leader 会话变成"包工头"：它不自己写代码，而是**建 worker 会话、把任务派下去、收汇报、审批交接**；
worker 会话只在自己的岗位范围内干活，向 leader 汇报。所有会话之间用一套 Host 侧的组播消息通信。

**三个卖点**：

1. **隔离是真的**：团队工具只装配在团队模式的作用域里，标准模式的会话**根本看不到** `team_*`——不是靠提示词自觉，也不是靠工具内部拒绝。
2. **审批是落地的**：默认 leader 每次派活都要写成"待批申请"，用户在面板点批准才真的建会话；也有一键「完全权限」档，由用户随时开关，每次自主派发都留痕。
3. **能自我维护**：leader 归档后可以面板移交；交接单可以要求补充；store 超上限自动归档（不删）。

**五分钟上手**：

```bash
node scripts/desktop-bundle.mjs install      # 装进桌面端（自动备份）
node scripts/guard-daily-profile.mjs         # 必须 exit 0 才重启
# 重启桌面端 → 新建会话 → 模式选择器选 "Agent Team · Leader" → 对它说：先看岗位表，然后派一个前端 worker 写登录页
```

leader 会先 `team_roster` 看有没有现成岗位，没有就 `team_spawn_worker`；默认档位下这会变成一条待批申请，你侧边栏底部的 **Agent Team** 按钮会出现角标，点开点「批准」，worker 会话就被建出来并收到任务。

---

## 2. 它解决什么问题（以及不解决什么）

### 2.1 解决的问题

单会话跑长任务会遇到三件事：

| 问题 | 本插件的回答 |
|---|---|
| 一个会话做不了并行（前端、后端、QA 同时干） | 一个 leader + N 个 worker，各自独立上下文并行 |
| 上下文满了只能人工重开，且新会话什么都不记得 | **交接**：worker 申请 → 写自包含交接单 → 批准后建继任会话并归档旧会话 |
| 谁在干什么、花在哪、谁批准的，事后说不清 | 岗位表 + 全部消息落盘 + 派发日志 + 权限切换日志 + 归档记录 |

### 2.2 不解决的问题（设计边界）

- **不是多用户系统**：面板只对本机 loopback 开放，没有账号与权限体系。
- **不是工作流引擎**：没有 DAG、没有重试策略、没有超时自动处置。编排判断归 leader（模型），协议只保证"说清楚、留痕"。
- **不接受多个 leader**：一个团队一个 leader（用户 2026-11-21 决定）。团队做"深"靠 worker 挂子智能体，不靠多 leader 并存。
- **不替代人审**：默认档位下所有新建会话都要人点头；「完全权限」是用户主动下放，随时可收回。

---

## 3. 架构

### 3.1 三块拼图

一个 bundle（`agent-team/`）里塞了三样东西，对应 `cordis.patch.yml` 里的三行：

```
┌─────────────────────────────────────────────────────────────────────┐
│                        一个工作区（workspace）                        │
│                                                                     │
│  ┌──────────────────┐   ┌──────────────────┐   ┌────────────────┐  │
│  │ preset-agent-team│   │preset-agent-team-│   │ agent-team-host│  │
│  │  （Leader 模式）  │   │  worker（Worker） │   │  （Host 状态机）│  │
│  │                  │   │                  │   │                │  │
│  │ 工具：            │   │ 工具：            │   │ · 岗位表/消息   │  │
│  │ spawn_worker     │   │ post_report      │   │ · 派发/交接申请 │  │
│  │ post_roster      │   │ handoff_request  │   │ · 唯一写者      │  │
│  │ handoff_approve  │   │ 上闩守卫          │   │ · /agent-team/*│  │
│  │ handoff_more_info│   │ (agent/pre-step) │   │ · SSE 推送      │  │
│  └──────────────────┘   └──────────────────┘   └────────────────┘  │
│         ▲ 只对选了该 preset 的会话可见                    ▲          │
│         └──────────────┬──────────────────────────────────┘          │
│                        │ 读写                                       │
│              ┌─────────┴──────────┐                                 │
│              │ <工作区>/.team/     │  store.json / bodies/ / handoffs/│
│              │                    │  archive/messages/              │
│              └────────────────────┘                                 │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ 前端（client.js）：侧边栏底部按钮 + 右侧抽屉（待办 / 消息）      │   │
│  │ 走同源 HTTP：/agent-team/*，只读 + 审批，不碰会话               │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

| 半边 | 是什么 | 关键约束 |
|---|---|---|
| **Host**（`agent-team-host`） | 单写者状态机：岗位表、消息、派发/交接申请、权限档位、归档日志；对外提供 `agentTeam` 服务与 `/agent-team/*` 路由；**不注册任何工具** | 一个工作区一份 store；模型调不到管理路由 |
| **Leader preset** | 一个独立的 Cordis scope，注册 5 个 leader 工具 | 工具只继承给选了 `agent-team` 的会话 |
| **Worker preset** | 独立 scope，注册 3 个 worker 工具 + `agent/pre-step` 上闩守卫 | 同上；守卫只在这个 scope 里 |
| **前端** | `sidebar.footer.action` 按钮 + `shell.overlay` 抽屉 | 只走 loopback HTTP，不改会话、不动已读游标 |

### 3.2 隔离为什么成立（机制，不是约定）

1. 每个 preset 被 `@deepseek-ai/dsh-agent-preset` 铸成一个**独立 scope**（`dsh-agent-preset-registry/lib/index.js:513`）。
2. 选该 preset 的会话，它的 scope **以 preset scope 为父**（同文件 `:686`）。
3. 工具注册表沿 scope 父链继承（`dsh-tools/lib/index.js:477-508`）。

所以在 preset 插件里 `ctx.tools.register` 的工具，**只有该 preset 的会话能继承**。
Host 插件里的工具则是全局的——这就是为什么本 bundle 的 Host 半边**一个工具都不注册**。

> 读取会话 preset 的权威 API 不是 `session.header.agentPreset`（那是初始化时的记录），
> 而是投影：`ctx.agentPresets.presetForSession(session)` / 运行中 agent 用 `composedPreset(agent.ctx)`。

### 3.3 目录布局

```
AgentWorkTeam/
├── agent-team/                 插件本体（bundle）
│   ├── index.js                Host：状态机 + 路由 + SSE + 保留策略 + 移交
│   ├── tools.js                两个 preset 作用域里的工具 + 上闩守卫 + guardDecision
│   ├── client.js               前端：侧边栏按钮 + 抽屉（待办 / 消息）
│   ├── cordis.patch.yml        三行声明（host + 两个 preset，工具清单由脚本生成）
│   ├── package.json            dsh.client / dsh.bundle 入口，files 白名单
│   ├── docs/DETAIL.md          实现细节（给改代码的人）
│   ├── locale/{zh,en}.json     插件市场里的标题/描述
│   ├── icon.svg
│   └── LICENSE                 MIT（随包分发）
├── spike-p2/                   验收 harness（只在独立 profile 跑）
│   ├── index.js                75 项断言
│   ├── cordis.patch.yml        harness 自己的声明
│   └── sandbox.patch.yml       把 workspaceRoot 改到 <sandbox>（必须最后叠加）
├── scripts/
│   ├── desktop-bundle.mjs      status / install / uninstall（自动备份 + SHA256SUMS）
│   ├── guard-daily-profile.mjs 体检：测试插件没进 bundles、pre-step 没有裸 return
│   ├── gen-preset-tools.mjs    preset 工具清单从 standard 生成（--check/--write/--diff）
│   ├── repro-pre-step-waterfall.mjs  waterfall 语义复现
│   └── asar-extract.py         读 app.asar（list/cat/x/tree）
├── docs/                       设计、实测、面板规格、git 流程、本文
└── CHANGELOG.md
```

**运行期数据**（不进仓库，`.gitignore` 里挡掉）：

```
<workspaceRoot>/.team/
├── store.json            岗位表 / 消息 / 申请 / 交接 / 日志（唯一写者：Host）
├── bodies/m-000123.md    每条消息的正文（独立文件，store 里只存路径）
├── handoffs/h-xxx.md     交接单（自包含）
└── archive/messages/m-000001..m-000009.json   超上限时归档的最旧消息
```

### 3.4 进程、端口与"谁能调谁"

- Host 跑在 DSH 主进程里，路由挂在 web server 的 `/agent-team` 前缀下。
- 所有路由**只接受 loopback**（`127.0.0.1` / `::1`），非本机一律 403。
- **模型没有任何路径能碰到管理路由**（reset / archive / promote-leader / prune / authority）：没有对应工具，工具表里只有第 7 节那 8 个。
- 前端和 Host 走同一个源，页面本身已经带着 token 打开，所以 SSE 与 fetch 不需要额外凭据；插件市场里的 `locale` 只管展示文案。

---

## 4. 安装、升级与卸载

### 4.1 装

```bash
node scripts/desktop-bundle.mjs install    # 写 desktop profile：dependencies + bundles + junction
node scripts/guard-daily-profile.mjs       # 判据：exit 0
# 重启桌面端
```

`install` 做的事：在 `<DSH_HOME>/profiles/desktop/` 里加依赖（`link:<repo>/agent-team`）、把 `dsh-agent-team` 加进 bundles、写 `cordis.patch.yml`，**改之前先备份** `package.json` + `cordis.patch.yml` 并生成 `SHA256SUMS`。

### 4.2 升级

**DSH 升级之后**必须做这一步，否则团队会话可能少工具：

```bash
node scripts/gen-preset-tools.mjs --check    # 先看有没有漂移
node scripts/gen-preset-tools.mjs --write    # 有漂移就按新 standard 重写两份清单
node scripts/guard-daily-profile.mjs         # exit 0
# 重启桌面端
```

> 为什么必须：preset 的 `plugins` 是**完整清单**，没有"继承 standard"这种写法，所以我们只能列一份。
> **1.8.0 起是"策展白名单"**：`scripts/gen-preset-tools.mjs` 里的 `CURATED` 列明团队会话要的 16 个插件，
> 条目正文仍从 `standard` 取（config 跟着新版走）；`persona` 与 `delegation` 用我们自己的版本（override），
> 末尾追加 `tool-agent-team-*`。
>
> - standard **新增**插件 → 不会自动进来（要就加进 `CURATED`）；
> - `CURATED` 里的 id 在 standard 里**找不到**（改名/删除）→ `--check` **直接报错**，附"请改 CURATED"的提示。
>
> 这样换 DSH 版本时是"安装即用"，而不是"引用到不存在的包、启动即报错"。
> `--check` 已经接进 `.githooks/pre-commit`，提交时就会拦。

### 4.3 卸载

```bash
node scripts/desktop-bundle.mjs uninstall
node scripts/guard-daily-profile.mjs
# 重启桌面端
```

`.team/` 数据不会被删；要清场用面板或 `POST /agent-team/admin/reset`（需要 `confirm: "RESET"`）。

---

## 5. 使用流程

### 5.1 建一个 leader

新建会话 → 模式选择器 → **`Agent Team · Leader`**。

- 该模式下**第一个**调用 leader 工具的会话，会被惰性认领成这个团队的 leader（记 `state.leader`）。
- 之后**再开一个** `Agent Team · Leader` 会话调 leader 工具会直接报错：
  `此会话不是 leader：本队 leader 是 at-lead-xxx（active）…`——这是刻意的，不接受并存。

### 5.2 派第一个 worker

你对 leader 说人话就行，例如：「看下岗位表，然后派一个前端 worker，任务是把登录页做完，涉及 src/pages/login.tsx」。

leader 内部会：

```
team_roster（看有没有现成岗位）
   └─ 有 frontend？→ 直接 team_post 派活（不重复建会话）
   └─ 没有 → team_spawn_worker { job: 'frontend', task: '…自包含任务书…', complexity: 'moderate' }
                ├─ 完全权限（autonomous）→ 立即建会话，返回 { status: 'created', sessionId: 'at-w-01-frontend' }
                └─ 需批准（ask，默认）→ 只登记申请，返回 { status: 'needs_user_approval', requestId: 's-…' }
```

**你在面板点「批准」之后**才真的建会话：

```
批准 → sessionController.create(sessionId, workspaceId, agentPreset: 'agent-team-worker')
     → 先 rename 钉住标题（否则标题会被内部信封污染）
     → 写岗位表 → 可选地按 complexity 设推理强度
     → 生成一条 task 消息投递给新会话（会唤醒它）
     → 给 leader 发一条系统回执：「已批准派发：frontend → at-w-01-frontend」
```

> 标题为什么必须提前钉：DSH 用会话收到的**第一条 human 消息**生成标题，而我们的第一条是
> `[Agent Team m-000001] from=…` 这种内部信封。`rename` 写入的 source.kind 是 `user`，
> 会钉住并取消在途的自动生成。

### 5.3 worker 干活、leader 协调

worker 侧可用的工具：`team_status`（看自己/同事堵着几条）、`team_directory`（找同事）、`team_context`（看上下文）、`team_post`（发给 leader 或指定同事）、`team_report`（汇报）、`team_handoff_request`（申请交接）。
它**不能**派发、不能群发（`role:` 群发只有 leader 能用）。

leader 用 `team_post` 发指令、`team_roster` 看进度。所有消息先入库再投递；投递失败只标记该收件人，不丢消息。

### 5.4 交接（换人，不丢上下文）

worker 上下文快满时（或需要干净重开），它调 `team_handoff_request`：

```
1. 写交接单 .team/handoffs/h-xxx.md（自包含：目标 / 已完成 / 产物路径 / 下一步 / 建议强度）
2. 给 leader 发 handoff-request
3. 本会话上闩 —— 之后不再开新步骤（人类消息除外）
```

leader 有三条路：

| 决定 | 效果 |
|---|---|
| **批准** `team_handoff_approve` | 建同岗位继任会话 → 更新岗位表 → 把交接单投给它 → 归档旧会话 → 解除上闩 |
| **拒绝**（面板，或 leader 直接回消息说明） | 不建会话，解除上闩，旧会话继续干 |
| **要求补充** `team_handoff_more_info` | 申请**保持挂起**、解除上闩让它能补、把"缺什么"发给它；补齐后重新提交**更新同一张单子**（不新建） |

> 为什么"要求补充"必须解除上闩：上闩守卫会否决 worker 的下一步，不解闩它连补单子那一轮都跑不了。

**leader 给自己提继任**（1.6.0 起）：leader 到 suggest 档（`team_context`）时用 `team_request_successor` 给自己提申请——**只能由你批准**（它不能批准自己的继任）。批准后系统建一个 `at-lead-NN` 的**新 leader 会话**、交接单交给它、旧 leader 归档、`leaderHistory` 记 `reason:'leader-handoff'`。所以"leader 交接"不再需要你手动开新会话或手动移交。

### 5.5 leader 归档了怎么办（1.5.0 起自动处理）

leader 会话被归档后，Host **自己会发现并让位**（`reconcileArchived()`：面板每次刷新、`leaderState`、`claimLeader` 都会对账）：
`state.leader` 清空、岗位表里那条标成 `archived`、`leaderHistory` 记一条 `by:'system' / reason:'leader-archived'`，
并给活着的成员发一条 `roster-update`（inject，不唤醒）。

**你不需要再手动移交**：新开一个「Agent Team · Leader」会话，它第一次调团队工具时会按既有规则惰性认领席位。
在有人接任之前，交接审批由你在面板代批（`awaiting: 'user'`）。

想主动换人（旧 leader 还在）时，仍然用面板 leader 卡片的「移交…」。

在面板「待办」页顶部的 **leader 卡片**点「移交…」→ 填接任会话 id（或点候选）→ 确认：

```
一次写盘内先卸任再任命：旧 leader 记 status: 'replaced' + replacedBy（留档不删）
                       state.leader 同时换人
写一条 leaderHistory  → 给活着的成员发 roster-update（inject，不唤醒）
```

- 只有**面板/本机 HTTP** 能触发（`POST /admin/promote-leader`，必须带 `confirm: "PROMOTE"`）；模型没有这条路径。
- 拒绝已归档的会话与不存在的 id；目标本来就是 leader 时幂等返回 `changed:false`。
- 目标是普通会话时给警告：它能代批，但没有派发工具（那些工具只装配在 `agent-team` 作用域里）。

### 5.6 面板怎么用

侧边栏底部 **Agent Team** 按钮：有待办时是红色数字角标；**没有待办但 leader 没了 / 有投递异常时是琥珀色小点**（不点开也看得见），悬停标题写明原因。团队卡片只列**活跃**会话，已归档/已替换的另起一行标数量。

**待办页**

| 区块 | 能做什么 |
|---|---|
| leader 卡片 | 显示 leader 与状态（在线 / 已归档 / 还没有）；「移交…」换人 |
| 派发权限 | 一键开「完全权限」或改回「需要你批准」（三次点击都有日志，`by: panel`） |
| 团队 | 岗位表快照（会话 id · 岗位） |
| 待批 | 派发申请：批准 / 拒绝（可填原因）；交接申请：批准 / 拒绝 / **要求补充**（理由必填）；`awaiting !== 'user'` 时提示"leader 在线，这条由 leader 批准；你不需要处理" |

**消息页**

- 四个筛选：类型 / 收件人 / 时间（最近 1 小时、24 小时、今天）/ 投递状态（有失败、未投递、已投递、已旁听），可叠加，任一生效出现「清空」。
- 搜索：摘要 / id / 发送方。
- 点击一条 → 右侧详情（发送方、收件人、逐收件人投递状态、按需加载正文）。
- 列表底部「加载更早（还有 N 条）」按 id 游标往前翻。
- 抽屉标题栏右侧：绿点「实时」= SSE 连着；黄点「轮询」= 断流退回了 3 秒轮询。

### 5.7 一次完整任务的时间线

```
你           leader 会话                     Host                       worker 会话
│               │                             │                            │
├─「派个前端」──►│                             │                            │
│               ├─ team_roster ──────────────►│ 读岗位表                    │
│               ├─ team_spawn_worker ────────►│ 写 pending 申请 s-…         │
│               │                             │                            │
├─ 面板点批准 ────────────────────────────────►│ create + rename + 派活      │
│               │                             ├─ task 消息 ────────────────►│ 收到，开始干
│               │                             ├─ 回执：已批准派发 ──────────►│（给 leader）
│               │◄────────────────────────────┤                            │
│               │                             │◄── team_report ────────────┤
│               │◄────────────────────────────┤                            │
│               ├─ team_post（复核意见）──────►│ ───────────────────────────►│
│               │                             │◄── handoff_request ────────┤ 上下文快满
│               │                             │    （上闩：它不能再开步骤）  │
│               ├─ team_handoff_approve ─────►│ 建继任 + 归档旧会话          │
│               │                             ├─ 交接单 ──────────────────►│ 新会话接手
```

---

## 6. 功能介绍（逐项）

### 6.1 模式与作用域隔离

- `agent-team`（展示名 `Agent Team · Leader`，order 5）与 `agent-team-worker`（order 6）。
- 工具清单 = **策展白名单（16 项）+ 我们自己的 `persona`/`delegation` + 追加 `tool-agent-team-*`**；条目正文从 shipped `standard` 取，`--check` 会校验白名单里的 id 在新版 DSH 里仍然存在。
- worker 模式也会出现在模式选择器里（DSH 的 preset 行没有"隐藏"字段），靠名称与描述标注「由 leader 自动创建，请勿手选」。

### 6.2 单 leader 与惰性认领

- 第一个用 leader 工具的会话成为 leader；`state.leader` 一旦有值，第二个会话 `claimLeader` 失败并报出当前 leader 与状态。
- 认领**不发生在建会话时**，而发生在这会话第一次调 leader 工具时——所以"建了两个 leader 会话但只用了一个"不会出错。

### 6.3 派发两档

| 档位 | 行为 | 留痕 |
|---|---|---|
| `ask`（默认） | 只写 `spawnRequests` 里的 pending 申请，等面板批准 | `requestedBy` / `requestedAt` / 批准后 `approvedBy` |
| `autonomous`（完全权限） | 直接建会话并派活 | `spawnLog` 每条记 `authority: 'autonomous'`、`approvedBy: null` |

切换只走面板或 `POST /agent-team/authority`，每次写 `authorityLog`（`at / by / value`）。**模型没有工具能改它。**

### 6.4 组播消息

| 发送方 | 单播（一个 id） | 多播（显式多个 id） | 岗位组广播 `role:<岗位>` | 全体广播 `all` |
|---|---|---|---|---|
| leader | ✓ | ✓ | ✓ 任意岗位 | ✓ |
| worker | ✓ | ✓（必须逐个写 id） | ✓ **只能自己岗位** | ✗ `只有 leader 可以发给全体` |

- 越权**抛错**，不静默丢弃、不放宽成广播。
- **归档 / 已被交接替换的会话不再是收件人**：`all` 与 `role:` 会跳过它们；显式发给它们会报错 `收件人已归档`（1.2.0 起）。
- 收件人解析在投递端做（不做"广播后过滤"）。
- 8 种消息类型：`task / question / answer / report / notice / handoff-request / handoff-approval / roster-update`。

**worker 怎么知道该发给谁**：`team_directory`（只读通讯录）返回 `{leader, total, members:[{session, job, role, title, isLeader, self}]}`。
它**只有"谁是谁"**，不含活动指标与待批申请（那些是 leader 的 `team_roster`）。已归档/被替换的会话不出现。

### 6.5 三种投递方式

| 方式 | 触发 | 语义 |
|---|---|---|
| `queue` | 默认（`task`/`question`/`answer`/`report`/`handoff-*`） | 追加到对方 `next-turn`，**下一轮 + 唤醒** |
| `steer` | `priority: 'urgent'` | 打进对方**当前这一步** + 唤醒（只在其正在跑时有意义） |
| `inject` | `notice` / `roster-update` | 进对方 `next-step`，**不唤醒**（旁听/状态） |

> **团队协作是异步的**：团队 preset **没有** `wait_agent` / `list_agents` / `send_message`（那是子智能体树的通道，
> 拿它等同事回复会把整轮堵死，团队消息只能等这一轮结束才被取走）。发完消息就结束这一轮，回复会在下一轮开始时到达。

三种都**由我们自己造消息**（`agent.followup` / `agent.steer` / `agent.inject`），消息带
`source: { kind: 'agent-team', messageId, mode }`。这一点很关键：它让上闩守卫能分辨"人说的话"和"队友发来的消息"
（详见 6.8）。**目标会话已上闩时不投递，改为暂扣（`held`），解闩后自动补投。**

关键事实：**多个 worker 同时汇报 = 逐条排队、一条一轮**（FIFO，不合并）。DSH 的 `next-turn` inbox 每次只取 1 条
（`dsh-agent-loop/lib/index.js:103-105`），3 个 worker 汇报 → leader 跑 3 轮。

### 6.6 先入库后投递

消息一经 `post()` 就写进 store 与 `bodies/`，然后才投递。投递失败只把该收件人的 slot 标 `failed`（并记 `error`），**不回滚、不静默丢**。

幂等：每个收件人的 slot 是状态机（`pending → delivered/injected/held/failed`），标记后立即 `save()`，
重启不会重复投递。

### 6.7 交接（四条路径）

见 5.4。补充实现细节：

- 交接单字段：目标、原因、已完成、产物路径、下一步、建议推理强度。
- `status`: `pending → approved | rejected`；`infoRequested` 只在"要求补充"后存在，补齐即清除。
- `revisions[]` 记录每次重新提交（最多 20 条，只记摘要与时间）。
- 批准后旧会话记 `status: 'archived'` + `replacedBy`，并调用 `archiveSession(id, { stopActivity: true })`。
- leader 不在线时，用户代批的「接手」任务由 `at-system` 署名，不冒充已归档的 leader。

### 6.8 上闩：两层隔离

交接申请发出后，旧会话不许再干活。这是**两层**，缺一层都等于没上闩：

**第一层：不投递（暂扣）** —— `deliver()` 发现目标是已上闩的会话时，不投递，把该收件人的 slot 标成
`held`（面板消息页显示「上闩暂扣」）。`unlatch()` 之后把这些 slot 改回 `pending` 并自动补投。
所以上闩期间的消息是**暂扣**，不是丢弃。

**第二层：守卫否决** —— worker preset 里的 `agent/pre-step` 监听器：

```
1. 没上闩            → return next()
2. 批次里有任何人类消息（source.kind === 'user'）→ return next()   ← 防丢消息
3. 其余              → { kind: 'reject' }（否决这一步，不取消整轮、不打断正在进行的流）
```

**为什么两层都要**：团队消息以前走 `sessionController.prompt(...)`，它造出来的消息 `source.kind` 恒为 `'user'`
——正好命中第 2 条，守卫那一层从来没拦过团队消息。现在 `queue`/`steer`/`inject` 都由我们自己造消息并带上
`source.kind: 'agent-team'`，第 3 条才真的对"队友发来的消息"生效。

**残余窗口（如实记）**：一条消息如果已经被对方的 inbox 取走、随后才被守卫否决，它**不会回到队列**
（`kind:'reject'` 让这一轮以 `blocked` 结束，`dsh-agent-loop:759-761`）。也就是"投出去之后同一瞬间才上闩"这个极窄窗口里
可能丢一条；正常流程（先上闩再发消息）不会发生。

**铁律**：这是 waterfall，放行必须 `return next()`；裸 `return` 会把 `undefined` 当决策交回宿主，
所有会话每一轮都会炸（事故 `INC-2026-11-20-PRESTEP`）。`scripts/guard-daily-profile.mjs` 与 pre-commit 会拦。

### 6.9 推理强度

`complexity` → 推理强度：`simple → off`、`moderate → high`、`complex → max`（可在 bundle 配置里改）。
`team_spawn_worker` 建完会话后按岗位设置；失败只记 `effortError`，不影响派发。

### 6.10 面板

见 5.6。实现要点：

- 入口 `sidebar.footer.action`，抽屉 `shell.overlay`；全用 DSH 主题 token（`--dsw-alias-*`），亮/暗自动跟随。
- 下拉是**自绘控件**（按钮 + 绝对定位列表）——原生 `<select>` 的弹出层由系统绘制，深色主题下会是一块白底，样式管不到。
- 只读：没有编辑 / 删除 / 撤回 / 代发 / 导出。

### 6.11 SSE 实时

- `GET /agent-team/events`（`text/event-stream`）：连上先 `event: ready`，之后每次 `save()` 发 `event: team`（只带递增 `seq`，不带内容）。
- 面板收到就重拉 `/state`——推送与审计读同一份投影，不会出现"推送里的计数和列表对不上"。
- `save()` 侧 120ms 合并；25 秒注释帧心跳；断开时清理订阅与定时器；插件卸载时 `end()` 所有订阅。
- 前端连上就停轮询；断流退回 3 秒轮询，浏览器按 `retry: 3000` 重连，标题栏小圆点显示实时/轮询。

### 6.12 消息分页

- `/state` 只带最新 100 条 + `totalMessages`；更早的用 `before` **id 游标**翻（`/messages?limit=100&before=m-000050`）。
- 不用 offset：消息只追加，offset 在"翻页期间来了新消息"时会漏条/重条。

### 6.13 store 保留策略

| 项 | 默认 | 说明 |
|---|---|---|
| `maxMessages` | 5000 | 活跃消息超过就动手（`post()` 尾部） |
| `retainMessages` | 2000 | 动手时降回这个数 |
| 归档 | `.team/archive/messages/<首id>..<末id>.json` | 整条消息（含 `bodyPath`）原样搬走 |
| 正文 | 不删 | `bodies/*.md` 留在原地 |
| 顺序 | 写归档 → **回读校验** → 才摘除 | 校验不过抛错，store 原封不动 |
| 跳过 | 还有 `pending` 投递的 | 它们要重投 |
| 手动 | `POST /admin/prune` | **默认干跑**；真跑要 `confirm: "PRUNE"` |
| 留痕 | `state.pruneLog`（≤50）+ `activity().archivedMessages` | |

**取舍**：归档里的消息面板看不到（`/body` 只查活跃 store），要看历史直接读归档 json。

### 6.14 上下文成本与裁剪（1.2.0）

一次团队会话请求（实测，126k 上下文）里装的东西：

| 组成 | 量 | 能不能省 |
|---|---|---|
| 工具 schema（61 个） | 16.4k tokens | 只有 **preset 挂的** 能删；`diagram_*` / `motion_*` / `browser_*` 等 19 个来自桌面 profile 的 bundle，preset 管不到 |
| system prompt | 3.3k | persona 已是我们自己的 |
| AGENTS.md 提醒 | 3.7k | **1.2.0 已从团队 preset 移除** |
| 历史消息 | **≈71k（56%）** | 只能靠压缩或换会话（交接就是换会话） |

1.2.0 从两个团队 preset 移除 4 个挂件：`agent-instructions`（不再注入 AGENTS.md）、`tool-schedule`、`command-goal`、`tool-goal`，22 → **18 项**。
效果：新会话首次请求 31.6k → 约 26.3k（−17%）；长会话 126k → 约 120.7k（−4%）。

**要更省就得动历史**：调低 `compaction` 触发阈值，或让长会话在**质量拐点**交接（见 6.15）。两条都改行为。

### 6.15 交接触发看数据：`team_context`（1.3.0）

会话**看不到自己用了多少上下文**（DSH 的 runtime context 里没有这个数），所以"该不该交接"以前只能靠猜。现在有真数据：

```
team_context → { used: 126000, window: 1048576, ratio: 0.12, percent: 12, band: 'keep-working',
                 hint: '已用 12%：够用，不要因为"感觉快满了"交接。' }
```

- `used = inputTokens + cacheReadTokens`（真实上下文大小，不是新输入）；
- 三档：`keep-working`（<45%）/ `suggest-handoff`（45–55%）/ `handoff-now`（≥55%），阈值可配；
- 没跑过模型轮 → `available:false, reason:'no-usage'`（不瞎猜）。

**交接单会带真数字**：`- 上下文：126000 / 1048576（12%，keep-working）`，leader 不用再问"为什么现在交接"。

**纪律（写进 persona）**：worker 交接前先看 `team_context`；`keep-working` 不得因"感觉快满了"交接；`suggest-handoff` 做完当前里程碑再交；`handoff-now` 立刻交。leader 批准交接**不做二次核对**，`要求补充` 只用于结构性缺口；自己的用量到 suggest 档就主动建议用户开新会话并给出数字。

> 为什么按比例而不按 token 数：窗口约 1M，社区实测约 500k（≈48%）之后**质量**开始下降。所以拐点在质量，不在"省 token"——过早交接反而增加次数、丢工作记忆、加重重复劳动。


---

### 6.16 多工作区：一个工作区一个团队（1.9.0）

1.8.0 及以前是"一个 profile 一个团队"：在任何工作区里新建 `Agent Team · Leader`，读写的都是配置里那个
`workspaceRoot` 的 `.team/` —— 在项目 B 里建团队，实际动的是项目 A 的岗位表。1.9.0 起**按工作区划分**：

| 入口 | 怎么知道是哪个团队 |
|---|---|
| 工具调用（`team_*`） | 按**调用方会话**反查它属于哪个工作区（`workspaceRegistry.list()` 每个工作区的 `sessionIds` 是权威账本）。**工具签名一个没动** |
| 面板 HTTP `/agent-team/*` | `?workspace=<绝对路径>`；不带就回落到配置里的默认工作区（单工作区行为与 1.8.0 完全一致） |
| 建 worker / 继任会话 | 建在该团队**自己的工作区**里，不再是写死的默认 root |

- store 位置 = `<工作区>/.team/`。已有团队**零迁移**（它本来就在自己的工作区里）；新工作区第一次用到时自动建空 store；
- **跨区守卫**：A 团队的会话 `team_post` 给 B 团队的会话 → 直接拒绝
  `收件人不在本团队: <id>（它属于工作区 … 的团队；跨团队投递不支持）`
  （用户 2026-11-21 定的口径：不允许跨团队点对点）；
- **面板**：抽屉头部「工作区」下拉 = 注册表里的工作区；徽章口径**只算当前工作区**，
  别的团队只在它自己的选项上带 `●N`；选择记在 localStorage（刷新还停在同一个团队）；
- **只读原则**：下拉里别的团队的 `●N` 是**只读扫** `<ws>/.team/store.json` 得来的，
  不会为了画一个圆点就在别人的项目里建目录。

切换工作区**只换视图**，不影响任何正在跑的会话。

---

## 7. 工具参考

### 7.1 Leader（9 个）

| 工具 | 参数（必填加粗） | 返回 |
|---|---|---|
| `team_spawn_worker` | **job**（2–32 位小写字母/数字/连字符）、**task**（自包含任务书）、title、complexity（simple/moderate/complex） | ask 档：`{status:'needs_user_approval', requestId, preset}`；完全权限：`{status:'created', sessionId, preset, messageId, authority:'full', note}` |
| `team_context` | session（默认自己；leader 可查任意成员） | `{used, window, ratio, percent, band, hint}` |
| `team_directory` | role（all / leader / worker，默认 all） | `{leader, total, members:[{session, job, role, title, isLeader, self}]}` |
| `team_status` | session（默认自己；可查在职队友） | `{session, self, role, job, title, archived, replaced, live, status, latched, inbox, delivery, activity, context, hint}` |
| `team_post` | **to**（`leader` / `all` / `role:<岗位>` / id 列表）、**summary**（≤500）、body、kind、priority | `{id, to, delivery:[{session, state, mode, outcome, targetStatus, ahead, queue, hint}]}` |
| `team_roster` | include（roster / activity / both，默认 both） | `{roster, activity}` |
| `team_handoff_approve` | **requestId**（`h-` 开头） | `{successor, archived, doc}` |
| `team_handoff_more_info` | **requestId**、**note**（要补什么） | `{id, status, infoRequested}` |
| `team_request_successor` | **summary**、reason、completed[]、artifacts[]、next[]、effort | `{id, status, docPath, context}`（给自己提继任，等你批） |

### 7.2 Worker（6 个）

| 工具 | 参数 | 返回 |
|---|---|---|
| `team_directory` | role（all / leader / worker，默认 all） | `{leader, total, members:[{session, job, role, title, isLeader, self}]}` |
| `team_status` | session（默认自己；查队友时 `context` 为 null） | 同 leader 版；`context` 只有自己或 leader 看别人时才有 |
| `team_context` | session（只能是自己） | `{used, window, ratio, percent, band, hint}` |
| `team_post` | 同 leader 版，但收件人只能是 leader 或团队成员 id | `{id, to, delivery:[{session, state, mode, outcome, targetStatus, ahead, queue, hint}]}` |
| `team_report` | **summary**、body、kind（report/question/answer）、priority | `{id, delivery:[{session, state, mode, outcome, targetStatus, ahead, queue, hint}]}` |
| `team_handoff_request` | **summary**、reason、completed[]、artifacts[]、next[]、effort（off/high/max） | `{id, status, docPath}` |

> 已上闩的会话：**发不发得出去**不受影响（它自己发的消息照常入库投递），但**收不到**新消息——
> 发给它的那条会被暂扣成 `held`，解闩后自动补投。

---

## 8. HTTP 接口（只接受 loopback）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/agent-team/state` | 面板主数据：快照 + `leaderStatus` + `leaderHistory` + `totalMessages` + `retention` + `pending` + `rows`（最新 100 条） |
| GET | `/agent-team/workspaces` | 工作区下拉的数据源：`{default, workspaces:[{id,path,title,default,sessions,hasTeam,pending}]}`（`pending` 只读扫各自的 store.json） |
| GET | `/agent-team/events` | SSE：`ready` / `team` 事件 |
| GET | `/agent-team/roster` | 岗位表 + 待批派发申请 |
| GET | `/agent-team/messages?limit&since&before` | 消息分页（`since` 增量 / `before` 往前翻） |
| GET | `/agent-team/activity` | 活动指标（数字与指针，不含正文） |
| GET | `/agent-team/authority` | 当前派发权限 + 最近 10 次切换 |
| POST | `/agent-team/authority` | 切换档位 `{authority: 'ask'\|'autonomous'}` |
| POST | `/agent-team/approve` | 批准 `{requestId}`（`h-` 走交接，`s-` 走派发） |
| POST | `/agent-team/reject` | 拒绝 `{requestId, reason?}` |
| POST | `/agent-team/more-info` | 要求补充 `{requestId, note}`（`note` 必填） |
| GET | `/agent-team/body?id=` | 单条消息正文（markdown） |
| POST | `/agent-team/admin/promote-leader` | 移交 `{sessionId, reason?, confirm:'PROMOTE'}` |
| POST | `/agent-team/admin/prune` | 归档旧消息 `{keep?, dryRun?, confirm:'PRUNE'}`（默认干跑） |
| POST | `/agent-team/admin/reset` | 清空团队 `{confirm:'RESET'}`（保留当前权限档位） |
| POST | `/agent-team/admin/archive-sessions` | 批量归档 `{ids?/prefix?, keep?, confirm:'ARCHIVE'}`（**跳过有活跃 agent 的会话**） |
| POST | `/agent-team/admin/unarchive-sessions` | 批量恢复 `{ids?/prefix?, confirm:'ARCHIVE'}` |
| POST | `/agent-team/diag` | **诊断用**（面板 `?diag=1` 才发）：把客户端 `pointerdown`/`click` 事实追加到 `.team/client-diag.jsonl` |

**`?workspace=`（1.9.0 起，除 `/workspaces` 外都认）**：绝对路径，必须是注册表里已有的工作区；
不带 = 配置里的默认工作区；未知路径回 **400**（不会在陌生目录里建 `.team/`）。

---

## 9. 数据模型

`<工作区>/.team/store.json`（**每个工作区一份**；`workspaceRoot` 只是默认工作区。Host 是唯一写者，原子写：tmp + rename）：

| 字段 | 含义 |
|---|---|
| `version` / `generation` | schema 版本 / 换代计数 |
| `leader` | 当前 leader 会话 id（`null` = 还没有） |
| `sessions` | 岗位表：`id → {role, job, title, preset, status, createdAt, createdBy, effort?, approval?, replacedBy?, promotedAt?}` |
| `messages` | 消息数组（时间正序），每条含 `id / ts / from / toExpr / to / kind / priority / mode / summary / body / bodyPath / delivery[]` |
| `spawnRequests` | 派发申请：`s-… → {job, title, task, complexity, requestedBy, status, approvedBy?, sessionId?}` |
| `handoffs` | 交接申请：`h-… → {from, job, summary, reason, effort, completed[], artifacts[], next[], status, docPath, revisions[], infoRequested?, infoLog?}` |
| `latched` | 上闩表：`sessionId → {at, reason}` |
| `leaderHistory` | 移交记录 `{at, by, from, to, reason}`（≤50） |
| `pruneLog` | 归档记录 `{at, count, range, archive}`（≤50） |
| `authority` / `authorityLog` | 当前派发档位 / 切换日志（最近 10 条给面板看） |
| `spawnLog` | 派发日志：`{at, session, job, requestedBy, approvedBy, authority, requestId}` |
| `preStep` / `rejects` | 守卫计数器（验收用：证明守卫只看得到团队会话、真的否决过） |

投递状态（每条消息的 `delivery[]`）：`pending / delivered / injected / held / failed`。`held` = 对方上闩中，已暂扣，解闩后自动补投。
**没有 `read`**——会话里跑的是 agent，没有"已读"事件可观测。面板里的"已读"应读作"已投递"。

---

## 10. 配置项（`cordis.patch.yml` 的 `agent-team-host.config`）

| 键 | 默认 | 说明 |
|---|---|---|
| `workspaceRoot` | `<repo>` | **默认**工作区：不带 `?workspace=` 的请求、以及没挂任何工作区的会话落在这里。1.9.0 起其他工作区各用自己的 `.team/`；验收 harness 用 `sandbox.patch.yml` 覆盖到 `<sandbox>`（**仓库外**：放仓库里会变成一个「仓库内工作区」，会话与面板下拉跟着脏） |
| `spawnAuthority` | `ask` | 首次初始化档位；运行时档位存在 `state.authority` |
| `maxMessages` | `5000` | 活跃消息上限，超过就归档 |
| `retainMessages` | `2000` | 归档后保留多少条 |
| `effortPolicy` | `{simple:'off', moderate:'high', complex:'max'}` | `complexity` 到推理强度的映射 |
| `contextWindow` | `1048576` | 模型的上下文窗口（用来算 `team_context` 的百分比） |
| `handoffSuggestAt` | `0.45` | 到这一档建议交接（`suggest-handoff`） |
| `handoffRequireAt` | `0.55` | 到这一档必须交接（`handoff-now`） |

---

## 11. 验收

```bash
# 1) 结构体检（判据：exit 0）
node scripts/guard-daily-profile.mjs

# 2) preset 工具清单没跟 standard 漂移（判据：exit 0）
node scripts/gen-preset-tools.mjs --check

# 3) waterfall 语义没变（判据：exit 0）
node scripts/repro-pre-step-waterfall.mjs

# 4) 全量验收（独立 profile + 沙箱工作区，约 40 秒；判据是 .p2/report.json 的 ok）
rm -rf "<sandbox>/.team" .p2/report.json
export ELECTRON_RUN_AS_NODE=1
E="<dsh-exe>"
B="<dsh-bin>"
timeout -s KILL 150 env DSH_P2_AUTORUN=1 "$E" "$B" --profile p2-test \
  --patch "<repo>/agent-team/cordis.patch.yml" \
  --patch "<repo>/spike-p2/cordis.patch.yml" \
  --patch "<repo>/spike-p2/sandbox.patch.yml" --port 0 --no-open
node -e "console.log(require('./.p2/report.json').ok)"     # true，121 项

# 5) 面板（真鼠标 CDP，判据是退出码 0；需要 9222 上的调试浏览器）
node ~/.dsh/bin/cdp/launch.mjs
node spike-p2/panel-probe.mjs "<带 token 的测试服务 URL>" .p2/panel \
  "<sandbox>/ws-b" "<sandbox>"   # 15/15
```

- **`sandbox.patch.yml` 必须最后叠加**：它把 `workspaceRoot` 改到 `<sandbox>`。少了它，验收会写进**桌面端正在用的**真实团队 store（2026-11-21 真出过一次）。
- 验收进程跑完不会自己退出（web server 挂着事件循环），`timeout` 包一层即可；判据始终是 `report.json` 的 `ok`。
- 桌面端的端到端记录见 [`verification-p2.md`](./verification-p2.md) §6.9；面板实测见 [`verification-frontend.md`](./verification-frontend.md)。

---

## 12. 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 团队工具在会话里完全没有 | 会话不是团队 preset（选的是标准模式），或 preset 加载失败 | 看模式选择器；`node scripts/guard-daily-profile.mjs`；重启 |
| leader 工具报「此会话不是 leader」 | 团队已有 leader | 正常。要换人：面板 leader 卡片「移交…」，或先归档旧 leader |
| 派活后没反应 | 档位是 `ask`，申请在面板等你批准 | 点侧边栏 Agent Team 按钮 → 待办 → 批准 |
| worker 会话标题是 `[Agent Team m-…]` | `rename` 失败（下游报错记在岗位表 `renameError`） | 重启后重试；持久失败看 DSH 日志 |
| worker 卡住不动 | 它发过交接申请 → 已上闩 | 批准 / 拒绝 / 要求补充，三条路都会解闩 |
| 面板显示"轮询" | SSE 断了 | 正常降级；查 `GET /agent-team/events` 是否 200 |
| 消息里"已读"永远是"已投递" | 没有已读回执（见 §9） | 设计如此 |
| store.json 很大 | 消息多 | `POST /admin/prune`（先干跑看计划） |
| 归档后老消息在面板消失 | 归档只保证"活跃 store 有界" | 直接读 `.team/archive/messages/*.json` |
| 面板工作区下拉点了没反应 | Electron 里 `-webkit-app-region: drag` 的区域会吞掉点击；或列表被祖先的层叠/裁剪挡住 | 1.9.0 已修（抽屉 `no-drag` + 列表 `fixed` 锚点）。再遇到：URL 加 `&diag=1`（或 `localStorage.setItem('dsh.agent-team.diag','1')`）刷新，点一下，看 `<工作区>/.team/client-diag.jsonl` 里的 `pointerdown` 记录 |
| 面板显示的是别的团队 | `?workspace=` 或 localStorage 里记着上一个工作区 | 下拉切回；或 `localStorage.removeItem('dsh.agent-team.workspace')` 后刷新回默认 |
| 验收 121 项里失败若干 | 先看 `report.errors` 与 `report.checks` 里 false 的项 | 常见原因：`<sandbox>/.team` 没清、上轮进程没退干净（`run.lock`）；1.9.0 起断言数从 115 增到 121（多工作区 6 条） |

---

## 13. 已知边界（有意为之）

- **桌面通知不做**（用户 2026-11-21 决定）。
- **导出 / 编辑 / 删除 / 撤回 / 代发**：面板只读，满足"存在过就留痕"。
- **已读回执没有**：投递状态只有 `pending / delivered / injected / held / failed`。
- **多个 worker 同时汇报 = 逐条排队、一条一轮**：FIFO、不合并；想要"先看汇总"靠协议，不靠队列。
- **`urgent` 不插队**：只在对方正在跑时打进当前这一步。
- **队列没有上限**；leader 归档后是投递失败（`failed`），不静默丢。
- **一条消息一轮推理**：10 个 worker 汇报 = 10 轮，成本上要自己权衡（纯通知用 `notice` → `inject` 不唤醒）。
- **并发双击审批没压测**：非 `pending` 再批会报"申请不是待批状态"。
- **交接单只有摘要级版本历史**（`revisions`），没有正文 diff。
- **上闩的残余窗口**：已被对方 inbox 取走、随后才被守卫否决的消息不会回到队列（"投出去后同一瞬间才上闩"的极窄窗口）。正常流程是先上闩再发消息，不会发生。
- **`steer` 在 `priority: urgent` 时直接选**，没有先判对方是否正在跑。

---

## 14. 回退

```bash
git tag --sort=-creatordate | head            # v1.9.0 = 当前可用版本（多工作区）
git reset --hard v1.9.0                       # 代码回到该版本
# 分步回退：改造四站 mw-step1-store / mw-step2-resolve / mw-step3-panel
git reset --hard pre-multi-workspace          # 整条线放弃（= v1.8.0 = 5d5d501）
node scripts/desktop-bundle.mjs uninstall     # 桌面端摘掉（会先备份）
node scripts/guard-daily-profile.mjs          # 必须 exit 0
# 重启桌面端
```

运行期数据不受代码回退影响（在 `.team/` 里）；要清场用 `POST /agent-team/admin/reset`（`confirm: "RESET"`，保留当前权限档位）。

---

## 15. 术语表

| 词 | 意思 |
|---|---|
| **preset / 模式** | DSH 里一套「系统提示 + 工具集」的声明；每个 preset 是一个独立作用域 |
| **岗位（job）** | 团队里的角色标识（`frontend` / `backend` / `qa`…），会话 id 形如 `at-w-01-frontend` |
| **上闩（latch）** | 交接申请发出后，禁止旧会话继续开新步骤的状态 |
| **交接单** | 自包含的接手材料：目标、已完成、产物路径、下一步、建议强度 |
| **追问（要求补充）** | 审批方不批准也不拒绝，让申请方补材料；单子保持挂起 |
| **完全权限** | `autonomous` 档：leader 跳过用户审批直接建会话，逐次留痕 |
| **inject / 旁听** | 只进对方下一步上下文、不唤醒算力的投递方式 |
| **SSE** | Server-Sent Events，面板的实时通道；断流退回轮询 |
| **归档（消息）** | 从活跃 store 挪进 `.team/archive/messages/`，不删除 |
