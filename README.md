<a id="zh"></a>

# Agent Team 模式（DeepSeek Harness 插件）

> 中文 ｜ [English](#en)

给 DSH 增加两个工作模式：**`Agent Team · Leader`** 与 **`Agent Team · Worker`**。
只有选了这两个模式的会话才会进入团队流程；标准模式等其它模式**看不到任何团队工具**。

> 当前版本 **1.10.0**。功能边界与已知限制见 [CHANGELOG.md](./CHANGELOG.md)，完整说明见 [docs/GUIDE.md](./docs/GUIDE.md)。
> 宿主：DSH **0.2.2-rc.5**（桌面端 Electron 打包版）实测通过。

## 安装

走 DSH 官方的插件安装路径（`dsh plugin` 装包 + bundle 选择），装完**重启桌面端**。

```bash
# 前置：dsh plugin 会调用 pnpm（没装先装一个）
npm i -g pnpm

# 从 GitHub 安装（当前可用）
dsh plugin --profile desktop add "github:1289959658wang-hue/dsh-agent-team#path:/agent-team"
```

> **已实测通过**（2026-11-22）：`#path:/agent-team` 子目录语法可用，装完 `dsh --dump-config`
> 能看到两个 preset，运行时 `/agent-team/state` 返回 200。
> 完整记录（含组合配置、默认工作区推导、未验证项）：[docs/verification-install.md](./docs/verification-install.md)

**npm 包暂未发布**（账号环节还在准备中）。发布之后会多一种更短的写法：

```bash
# 尚未可用，发布后才有
dsh plugin --profile desktop add dsh-agent-team
```

装完重启桌面端，新建会话时在模式选择器里选 **Agent Team · Leader** 即可。

卸载（不论从 GitHub 还是将来从 npm 装，包名都是 `dsh-agent-team`）：

```bash
dsh plugin --profile desktop remove dsh-agent-team
```

> 包里只有插件本身（`index.js` / `tools.js` / `client.js` / `cordis.patch.yml` / `locale` / `docs/DETAIL.md` / `icon.svg` / `LICENSE`），
> 不含任何测试用例或验收脚本。

## 先读这个：什么时候该用，什么时候别用

**适合长期项目**：工作会跨很多次会话、上下文迟早撑爆、需要几个人并行分工、需要"换个人接着干"。
这个插件真正的价值是两件事 —— **自动创建会话**（leader 一声令下开出一个同级 worker）和
**自动会话继承**（上下文快到上限时，旧会话写交接单、新会话接手，岗位不变、上下文清零重来）。

**不适合短任务。** 如果一件事单个会话一次就能做完、上下文压力本来就不大，用这个模式
**提升幅度不大，但 token 成本会成倍数增长**（实测结论：AI 会话本身很贵，而这里每条消息
都是一次唤醒，每个 worker 都是一份独立的系统提示 + 工具表 + 历史）。判断标准很简单：

| 你的情况 | 该用吗 |
|---|---|
| 一次性脚本、单个文件改动、问一个问题 | ❌ 别用，直接一个会话做完 |
| 半天以内能收尾的小项目 | ❌ 不值得，协调成本大于收益 |
| 要跨好几天、上下文会撞上限、需要并行分工 | ✅ 用 |
| 需要"做完一段就换人接着干"的长跑任务 | ✅ 用（这是它的主场） |

> 一句话：**它买的是"不撞上下文上限"和"能并行"，代价是 token。短任务里这两样都用不上。**

## 它是什么

| 角色 | 能做什么 |
|---|---|
| **Leader** | 看岗位表、派发新 worker、组播消息、审批交接。团队里**只有一个人**能当 leader |
| **Worker** | 接任务、向 leader 汇报、在 leader 允许范围内与同事协同；不能派发、不能群发 |
| **Host 侧** | 岗位表、组播消息、派发/交接申请的唯一写者（落 `<工作区>/.team/`，**一个工作区一份**） |

审批路径是固定的，不靠提示词自觉：

- **派发**（开新 worker）：leader 申请 → **用户批准**（或用户切到「完全权限」，leader 直接派）；
- **交接**（同岗位换人）：worker 申请 → **leader 批准**；只有 leader 不可用时才由用户代批；
- **移交**（leader 归档/宕机后）：在抽屉的 leader 卡片里指定接任会话，一次写盘内卸任+任命，留 `leaderHistory`；模型没有这条路径。

> 面板（待办 / 消息两个标签页、leader 卡片、工作区下拉）见下面 [面板](#面板) 一节。

## 如何开始

### 1. 建一个 leader 会话

新建会话 → 模式选择器里选 **`Agent Team · Leader`**。这个团队里的**第一个** leader 会话会自动成为 leader
（之后再开 leader 会话也不会抢位，只会被告知"本队 leader 是某某"）。每个工作区各有自己的团队，互不干扰。

### 2. 直接对它说你要做什么

不用先配置什么。典型的第一句：

> 先看一下岗位表，然后派一个前端 worker 把登录页写了，任务书写清楚点。

leader 会调 `team_roster` / `team_directory` 看现状，然后调 `team_spawn_worker` 派活。

### 3. 批准派发（默认要你点一下）

默认档位是「需要你批准」：leader 派活**不会直接建会话**，而是写一条待批申请 —— 你去面板点「批准」，
它才真的建出 worker、把任务书投递过去。嫌麻烦可以在面板里切到「完全权限」（每次派发仍会留日志）。

### 4. worker 自己干活、自己汇报

worker 是**同级的真实会话**（不是子智能体）：它有自己的上下文、自己的工具（`team_report` 汇报、
`team_post` 和同事协同），做完会用 `team_report` 把结果发给 leader。leader 再用 `team_context`
看谁快撑不住了、用 `team_status` 看谁在忙/队列里堵了几条。

### 5. 上下文快满时，自动交接

worker 的上下文到 **45% 建议交接、55% 必须交接**（可配）。它自己调 `team_handoff_request` 写一张
自包含的交接单（目标、已完成、产物路径、下一步），然后**上闩**——在批准前它不能再开新步骤，
避免"边交接边改"。leader 批准 → 建一个同岗位的继任会话、投递交接单、归档旧会话。
leader 自己的继任申请只能由**你**批准（leader 不能批准自己的继任）。

### 6. leader 没了怎么办

leader 归档或宕机后，在抽屉的 **leader 卡片**里点「移交…」指定接任会话 —— 一次写盘内卸任+任命，
记进 `leaderHistory`。模型没有这条路径。

## 面板

侧边栏底部 **Agent Team** 按钮：有待办时是**红色数字角标**；没有待办但 leader 没了 / 有投递异常时
是**琥珀色小点**（不点开也看得见）。点开是右侧抽屉，两个标签页。

抽屉**顶部**有工作区下拉（每工作区一个团队）：切工作区只换视图，不影响任何正在跑的会话；
别的团队有待办时，它的选项上带 `●N`，而侧边栏角标只算**当前**工作区。

**待办页**

| 区块 | 你能做什么 |
|---|---|
| leader 卡片 | 看 leader 是否在线；「移交…」换人 |
| 派发权限 | 一键切「完全权限 / 需要你批准」（每次切换都有日志） |
| 团队 | 岗位表快照（会话 id · 岗位），只列活跃会话 |
| 待批 | **派发申请**：批准 / 拒绝（可填原因）；**交接申请**：批准 / 拒绝 / 要求补充（理由必填）。leader 在线时 worker 的交接由 leader 批，面板会写明「你不需要处理」 |

**消息页**（只读审计）

- 四个筛选：类型 / 收件人 / 时间 / 投递状态，可叠加；
- 搜索摘要、id、发送方；点一条看详情与**逐收件人投递状态**（`未投递 / 已投递 / 已旁听 / 上闩暂扣 / 失败`）；
- 底部「加载更早」按 id 游标往前翻；
- 右上角绿点「实时」= SSE 连着，黄点「轮询」= 断流退回 3 秒轮询。

面板是**只读 + 审批**：没有编辑、删除、撤回、代发、导出。要清空团队用
`POST /agent-team/admin/reset`（`confirm: "RESET"`）。

## 多工作区

1.9.0 起每个工作区有**自己的团队**：工具按调用方会话反查它属于哪个工作区，面板用 `?workspace=` 取数，
跨工作区投递直接拒绝（`收件人不在本团队`）。已有团队零迁移——store 本来就在各自工作区的 `.team/` 里。

`workspaceRoot` 不用配：留空就用 DSH 注册表里的默认工作区。要钉死某个目录再在
`agent-team/cordis.patch.yml` 的 `config.workspaceRoot` 里写绝对路径。

## 安全须知

1. **`agent/pre-step` 是 waterfall**：监听器必须声明 `next`，放行一律 `return next()`。
   裸 `return` 会让**宿主上所有会话每一轮都报错**（历史上真发生过，见 [docs/pitfall-pre-step-waterfall.md](./docs/pitfall-pre-step-waterfall.md)）。
2. 守卫监听器只注册在 **worker preset 的作用域**里，标准会话进不了它的视野。
3. `apply()` 里没有任何自动运行：插件启动时只读写自己的 store，不建会话、不发消息。

## 文档

| 想了解 | 看 |
|---|---|
| **完整说明（装/用/架构/流程/功能/接口/排错）** | [docs/GUIDE.md](./docs/GUIDE.md) |
| 插件内部结构（给你要改代码时） | [agent-team/docs/DETAIL.md](./agent-team/docs/DETAIL.md) |
| 版本与已知边界 | [CHANGELOG.md](./CHANGELOG.md) |
| 团队章程 | [docs/charter-default.md](./docs/charter-default.md) |
| 面板规格 | [docs/panels.md](./docs/panels.md) |
| 设计调研与组播协议 | [docs/reusable-solutions.md](./docs/reusable-solutions.md) |
| 写钩子前必读 | [docs/pitfall-pre-step-waterfall.md](./docs/pitfall-pre-step-waterfall.md) |
| 安装实测 | [docs/verification-install.md](./docs/verification-install.md) |
| 索引 | [docs/README.md](./docs/README.md) |

## 开发与贡献

```bash
git clone <repo> && cd <repo>
node scripts/guard-daily-profile.mjs     # 体检：exit 0
node scripts/gen-preset-tools.mjs --check  # preset 工具清单没跟 DSH 的 standard 漂移
node scripts/desktop-bundle.mjs install  # 装进本机 desktop profile（会先备份）
```

验收与测试用例**不随包发布**，只在维护者仓库里跑（见 [CONTRIBUTING.md](./CONTRIBUTING.md)）。

## 许可证

MIT，见 [LICENSE](./LICENSE)。

---

<a id="en"></a>

# Agent Team mode (DeepSeek Harness plugin)

> [中文](#zh) ｜ English

Adds two working modes to DSH: **`Agent Team · Leader`** and **`Agent Team · Worker`**.
Only sessions created in those two modes join the team workflow; standard mode and every other
mode **see no team tools at all**.

> Current version **1.10.0**. Feature boundaries and known limits live in [CHANGELOG.md](./CHANGELOG.md);
> the full manual is [docs/GUIDE.md](./docs/GUIDE.md) (Chinese).
> Host: tested against DSH **0.2.2-rc.5** (Electron desktop build).

## Install

Use DSH's official plugin path (`dsh plugin` installs the package and selects the bundle), then
**restart the desktop app**.

```bash
# Prerequisite: `dsh plugin` shells out to pnpm
npm i -g pnpm

# Install from GitHub (works today)
dsh plugin --profile desktop add "github:1289959658wang-hue/dsh-agent-team#path:/agent-team"
```

> **Verified** (2026-11-22): the `#path:/agent-team` sub-directory syntax works; after installing,
> `dsh --dump-config` shows both presets and `/agent-team/state` returns 200 at runtime.
> Full record (composed config, default-workspace resolution, open items):
> [docs/verification-install.md](./docs/verification-install.md) (Chinese).

**The npm package is not published yet** (the account setup is still in progress). Once it is,
there will be a shorter form:

```bash
# Not available yet — only after publishing
dsh plugin --profile desktop add dsh-agent-team
```

After installing, restart the desktop app and pick **Agent Team · Leader** in the mode selector when
creating a session.

Uninstall (the package is named `dsh-agent-team` whichever source you installed from):

```bash
dsh plugin --profile desktop remove dsh-agent-team
```

> The package contains the plugin only (`index.js` / `tools.js` / `client.js` / `cordis.patch.yml` /
> `locale` / `docs/DETAIL.md` / `icon.svg` / `LICENSE`). It ships **no test cases or acceptance scripts**.

## Read this first: when to use it, when not to

**Built for long-running projects**: work that spans many sessions, where the context window will
eventually overflow, where several people need to work in parallel, and where "someone else has to
pick it up" is normal. The plugin earns its keep with two things — **creating sessions automatically**
(a leader opens a peer worker on demand) and **automatic session inheritance** (as the context
approaches its limit, the old session writes a handoff document and a new session takes over: same
role, fresh context).

**Not for small tasks.** If one session can finish the job in one go and context pressure is low,
this mode buys you **little upside while multiplying token cost** (measured: an AI session is
expensive on its own, and here every message is a wake-up, while every worker is a separate system
prompt + tool table + history). A simple rule of thumb:

| Your situation | Should you use it? |
|---|---|
| One-off script, single-file change, one question | ❌ No — just do it in one session |
| A small project you can wrap up within half a day | ❌ Not worth it; coordination costs more than it saves |
| Runs for days, context will hit the limit, needs parallel work | ✅ Yes |
| Long haul where "hand it to someone else after this stretch" matters | ✅ Yes — this is the sweet spot |

> In one line: **it buys you "never hit the context ceiling" and "parallelism", and you pay in tokens.
> Small tasks need neither.**

## What it is

| Role | What it can do |
|---|---|
| **Leader** | Read the roster, spawn new workers, multicast messages, approve handoffs. **Exactly one** session in a team can be the leader |
| **Worker** | Take tasks, report to the leader, cooperate with peers within the leader's rules; cannot spawn or broadcast |
| **Host side** | The single writer for the roster, the multicast log and dispatch/handoff requests (stored in `<workspace>/.team/`, **one store per workspace**) |

Approval paths are structural, not prompt-driven:

- **Dispatch** (open a new worker): leader asks → **the user approves** (or the user switches to
  "full authority" and the leader dispatches directly);
- **Handoff** (replace a role): worker asks → **the leader approves**; only when the leader is
  unavailable does the user approve instead;
- **Transfer** (after the leader is archived or dies): pick the successor in the leader card of the
  drawer — demotion and appointment happen in one write, recorded in `leaderHistory`. The model has
  no path to this.

> The panel (Pending / Messages tabs, leader card, workspace dropdown) is described in [Panel](#panel) below.

## Getting started

### 1. Create a leader session

New session → pick **`Agent Team · Leader`** in the mode selector. The **first** leader session of a
team becomes the leader automatically (later leader sessions do not take over; they are simply told
who the leader is). Each workspace has its own team; they do not interfere.

### 2. Just tell it what you want

No setup needed. A typical first message:

> Take a look at the roster, then spawn a frontend worker to build the login page — make the task
> brief thorough.

The leader calls `team_roster` / `team_directory` to inspect the team, then `team_spawn_worker` to
dispatch.

### 3. Approve the dispatch (one click by default)

The default authority is "needs your approval": dispatching **does not create a session directly** —
it files a pending request. You click **Approve** in the panel, and only then is the worker created
and the task brief delivered. If that is too much friction, switch to "full authority" in the panel
(every dispatch is still logged).

### 4. Workers work and report on their own

A worker is a **real peer session** (not a sub-agent): it has its own context and its own tools
(`team_report` to report, `team_post` to cooperate). When done it sends the result to the leader via
`team_report`. The leader uses `team_context` to see who is close to the limit and `team_status` to
see who is busy and how many messages are queued ahead.

### 5. Automatic handoff when context fills up

At **45% the worker is advised to hand off, at 55% it must** (configurable). It calls
`team_handoff_request` to write a self-contained handoff document (goal, completed work, artifact
paths, next steps) and then **latches** itself — it cannot start new steps until the request is
resolved, so it cannot keep editing while handing over. The leader approves → a successor session is
created in the same role, the handoff is delivered, and the old session is archived. A leader's own
successor request can only be approved by **you** (a leader cannot approve its own replacement).

### 6. When the leader is gone

After the leader is archived or dies, click **Transfer…** in the leader card of the drawer and pick a
successor — demotion and appointment happen in one write and are recorded in `leaderHistory`. The
model has no path to this.

## Panel

The **Agent Team** button sits at the bottom of the sidebar: a **red count badge** while pending items
exist; when there are none but the leader is gone or deliveries failed, an **amber dot** (visible
without opening anything). Clicking it opens the drawer on the right with two tabs.

The **top of the drawer** holds the workspace dropdown (one team per workspace): switching only
changes the view and never disturbs a running session. Teams with pending items show `●N` on their
option, while the sidebar badge counts **the current workspace only**.

**Pending tab**

| Block | What you can do |
|---|---|
| Leader card | See whether the leader is online; **Transfer…** to replace it |
| Dispatch authority | Switch between "full authority" and "needs your approval" (every switch is logged) |
| Team | A roster snapshot (session id · role), active sessions only |
| Pending | **Dispatch requests**: approve / reject (reason optional); **handoff requests**: approve / reject / request more info (reason required). While the leader is online it approves worker handoffs and the panel says "you don't need to act" |

**Messages tab** (read-only audit)

- Four filters — kind / recipient / time / delivery state — combinable;
- Search by summary, id or sender; click a row for details and **per-recipient delivery state**
  (`not delivered / delivered / injected / held (latched) / failed`);
- "Load earlier" at the bottom pages backwards by id cursor;
- Green "live" dot = SSE connected; amber "polling" dot = fell back to 3-second polling.

The panel is **read-only plus approvals**: no editing, deleting, retracting, sending on behalf of
others, or exporting. To reset a team use `POST /agent-team/admin/reset` (`confirm: "RESET"`).

## Multiple workspaces

Since 1.9.0 every workspace has **its own team**: tools resolve the caller's session to its
workspace, the panel passes `?workspace=`, and cross-workspace delivery is rejected outright
(`recipient is not in this team`). Existing teams migrate with zero effort — the store already lives
in each workspace's `.team/`.

`workspaceRoot` needs no configuration: leave it empty and the default workspace from the DSH
registry is used. To pin a specific directory, set an absolute path in
`agent-team/cordis.patch.yml` under `config.workspaceRoot`.

## Safety notes

1. **`agent/pre-step` is a waterfall**: listeners must declare `next` and always pass through with
   `return next()`. A bare `return` makes **every session on the host error on every turn** (this
   really happened; see [docs/pitfall-pre-step-waterfall.md](./docs/pitfall-pre-step-waterfall.md)).
2. The guard listener is registered only in the **worker preset scope**; standard sessions never
   reach it.
3. Nothing runs automatically inside `apply()`: on startup the plugin only reads and writes its own
   store — it creates no sessions and sends no messages.

## Documentation

Most docs are bilingual (Chinese first, English second, in the same file). Deep reference sections — architecture, tool reference, HTTP API, data model — are Chinese-only for now; the English guide to `docs/GUIDE.md` links to them.

| To learn | Read |
|---|---|
| **Full manual (install / usage / architecture / flows / features / API / troubleshooting)** | [docs/GUIDE.md](./docs/GUIDE.md) |
| Plugin internals (when you are changing code) | [agent-team/docs/DETAIL.md](./agent-team/docs/DETAIL.md) |
| Versions and known limits | [CHANGELOG.md](./CHANGELOG.md) |
| Team charter | [docs/charter-default.md](./docs/charter-default.md) |
| Panel specification | [docs/panels.md](./docs/panels.md) |
| Design notes and the multicast protocol | [docs/reusable-solutions.md](./docs/reusable-solutions.md) |
| Read before writing hooks | [docs/pitfall-pre-step-waterfall.md](./docs/pitfall-pre-step-waterfall.md) |
| Install verification | [docs/verification-install.md](./docs/verification-install.md) |
| Index | [docs/README.md](./docs/README.md) |

## Development and contributing

```bash
git clone <repo> && cd <repo>
node scripts/guard-daily-profile.mjs       # health check: exit 0
node scripts/gen-preset-tools.mjs --check  # preset tool list has not drifted from DSH's standard
node scripts/desktop-bundle.mjs install    # install into the local desktop profile (backs up first)
```

Acceptance tests and fixtures are **not shipped with the package**; they only run in the maintainer's
repository (see [CONTRIBUTING.md](./CONTRIBUTING.md), Chinese).

## License

MIT — see [LICENSE](./LICENSE).
