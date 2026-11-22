# Agent Team 模式（P2）

两个工作模式，一套 Host 侧共享状态。

## 它做什么

- **`Agent Team · Leader`** —— 团队里第一个开起来的会话默认是 leader。工具：`team_spawn_worker`（派发平级 worker 会话）、`team_post`（组播）、`team_roster`（岗位表与原始活动指标）。
- **`Agent Team · Worker`** —— 由 leader 派发时自动创建，preset 固定是 `agent-team-worker`。工具：`team_report`（向 leader 汇报）、`team_post`（受 leader 允许的同事协同）。
- **Host 侧** —— 岗位表、组播消息、派发申请的唯一写者，落在**会话所属工作区**的 `<workspace>/.team/store.json`（1.9.0 起一个工作区一份），并通过 `agentTeam` 服务交给两个 preset 的工具。

## 隔离是怎么做到的

不是靠开关，也不是靠工具内部拒绝：团队工具注册在 **preset 的 scope** 里。选该 preset 的会话的 scope 以它为父，所以只有这些会话能继承到工具；`standard` 等其它模式的工具表里根本没有 `team_*`。

这也是为什么 Host 插件不注册任何工具——Host 注册就是全局注册。

## 多工作区（1.9.0）

团队按**工作区**划分：`createTeamStore(root)` 一个工作区一份 store，`apply()` 用
`Map<pathKey, store>` 缓存（`pathKey` = resolve + Windows 下小写，同一个目录不会有两份写者）。

三个入口各自怎么找到"哪个团队"：

| 入口 | 解析 | 代码 |
|---|---|---|
| 工具调用 | 调用方会话 → 工作区（`workspaceRegistry.list()` 的 `sessionIds`）→ 该工作区的 api | `teamOf(exec) = ctx.agentTeam.forSession(callerOf(exec))`（tools.js 里 13 处） |
| 面板 HTTP | `?workspace=<绝对路径>`，只认已注册的工作区；不带 → 默认工作区；未知 → 400 | `storeForRequest(url)` |
| 建 worker / 继任 | `workspace()` 用**本 store 的** root 解析工作区 | `spawnWorker` / `approveHandoff` |

`ctx.agentTeam` 仍是默认工作区那份 api 的平铺投影（老调用方 `ctx.agentTeam.roster()` 不变），
另外多了 `forSession(id)` / `forWorkspace(path)`。

**跨区守卫**：`resolveRecipients` 遇到不在本 store 岗位表里的收件人时，先查它属于哪个工作区 ——
属于别的工作区就报 `收件人不在本团队: <id>（它属于工作区 … 的团队；跨团队投递不支持）`，
压根不是成员才报 `收件人不是团队成员`。所以"跨团队点对点"从设计上就不存在（用户 2026-11-21 定的口径）。

**下拉的 `●N` 只读**：别的团队不 `teamFor()`（那会 mkdir 一个 `.team/`），而是只读扫
`<ws>/.team/store.json`（按 mtime+size 缓存）。这是 `workspacePeekDoesNotCreateDirs` 断言盯着的点。

## 用法

1. 在模式选择器里选 `Agent Team · Leader` 建会话。
2. 直接对 leader 说任务；leader 用 `team_spawn_worker` 派发。默认 `spawnAuthority: ask`：它只会登记一条**待用户批准**的申请，不建会话。
3. 允许自主派发时，在 bundle 配置里改成 `spawnAuthority: autonomous`。

`Agent Team · Worker` 会出现在模式选择器里（preset 行没有隐藏字段）。手选它不会成为团队成员——没有经过 leader 派发的会话，`team_report` 会直接报错。

## 身份与审批

**一个团队只有一个 leader**：该模式下第一个会话自动成为 leader；之后开的 `Agent Team · Leader` 会话不会成为 leader，也不能派发或审批（工具直接报错，模型据此告知用户）。团队要做深，靠 worker 下面挂子智能体。

审批路径固定：

| 申请 | 谁提交 | 谁批准 |
|---|---|---|
| 派发新 worker | leader → 用户 | 用户（`ask` 档）或 leader 自己（`autonomous`「完全权限」档） |
| 交接（同岗位换人） | worker → leader | leader；**只有 leader 不可用时**才轮到用户在面板代批 |

### 完全权限

面板「待办」页顶部有一个**派发权限**开关，两个档位：

- **需要你批准**（默认）：leader 每次派活先写一条待批申请，你点批准才真的建会话。
- **完全权限**：leader 直接建 worker、直接派任务，不再等你。开启要点一次「确认开启」。

开了完全权限也不是无痕：每次自主派发都写进派发日志（会话 / 岗位 / 谁申请 / 时间），`activity()` 会给出 `fullAuthoritySpawns` 计数，档位切换本身也留记录。**模型没有工具能改这个开关**，只有你（面板/本机接口）能改。

面板里每条待办都带 `awaiting`：`user` 的才给按钮；`leader` 的只显示"等 leader，你不需要处理"。

## 消息与投递

一条消息先入库再投递（投递失败只标记该收件人，不丢弃、不回滚）。投递方式按类型与优先级自动选：

| 触发 | 方式 | 效果 |
|---|---|---|
| `kind = notice / roster-update` | `agent.inject()` | 只进对方下一步上下文，**不唤醒**（旁听） |
| `priority = urgent` | `agent.steer()` | 下一步 + 唤醒（用于紧急纠正） |
| 其余（task / question / report / handoff-*） | `agent.followup()` | 下一轮 + 唤醒 |
| 目标已上闩 | **不投递**，slot 记 `held` | 解闩后 `unlatch()` 自动补投 |

三种投递都由我们自己造消息（`teamMessage()`），带 `source: { kind: 'agent-team', messageId, mode }`。
**不要改回 `sessionController.prompt(...)`**：它造出来的消息 `source.kind` 恒为 `'user'`，会命中上闩守卫的
"人类消息放行"分支，上闩就失效了（1.1.0 之前就是这个问题）。

收件人解析在投递端完成，不做"广播后过滤"。

1.4.0 定案的通道权限：**leader** = 单播 / 多播 / 任意 `role:` / `all`；**worker** = 单播 / 多播（显式 id）/ `role:<自己的岗位>`（章程 §4.1 "同组同事"），`all` 与跨岗位 `role:` 直接抛错。
`team_post` 的描述按角色生成——以前两种角色共用一段写着"可发 all / role:"的文案，worker 照着试只会拿到权限错误。
归档（`archived` / `replaced`）的会话不算收件人：`all` / `role:` 跳过，显式发给它报错 `收件人已归档`。

**子智能体控制工具不进团队 preset**（1.7.0）：`delegation` 组里去掉 `tool-subagent-control` ——
它注册的 `wait_agent` / `list_agents` / `send_message` 会让模型误以为可以"等团队回复"，
而团队消息（inbox `next-turn`）只在新一轮开始时才被取走，于是整轮被堵死（§6.27 实测）。
`subagent` / `subagent_fork` / `workflow` 保留。`delegation` 在生成器里是 `override`，不会被 standard 覆盖回来。

**发现**：`team_directory`（`directory()`：只回 `leader`（**空 leader 时是空串**，另给 `hasLeader`）/ `members[{session,job,role,title,isLeader,self}]`，排除归档与 replaced）
**两种角色都有**（1.6.1 起）。`team_roster` 仍然只有 leader 有 —— 它带活动指标与待批申请，是判读工具。

> 为什么 leader 也要 `team_directory`：1.6.1 之前 leader 只看得到 `team_roster`，于是推断"`team_directory` 不存在"，
> 命令 worker 把产物里的工具名改错（verification §6.26）。**模型会用自己的工具表当全集** —— 这是坑，不是偶然。

## leader 的继任申请（1.6.0）

`requestHandoff` 允许 `from === state.leader`（其余仍只允许 worker）；leader 的申请 **只能 `approvedBy:'user'`** ——
`approveHandoff` 里 `isLeaderHandoff` 分支：建 `agent-team` 预设的 `at-lead-NN` 会话、切 `state.leader`、
写 `leaderHistory {reason:'leader-handoff'}`、旧 leader 标 archived+replacedBy 并归档、交接单由 `at-system` 投递。
leader 提申请时不发 `post({to:'leader'})`（那会撞"leader 不能发给自己"），改为给自己一条 inject 回执。

## 交接

worker 上下文快满（或需要干净重开）时用 `team_handoff_request`：

1. 写一张**自包含**交接单到 `.team/handoffs/`；
2. 给 leader 发 `handoff-request`；
3. 本会话**上闩**——之后不再开新步骤。

**上闩两层**（1.1.0 起）：① **不投递**——`deliver()` 见目标已上闩就把 slot 记 `held`（暂扣），`unlatch()` 后自动补投；② **守卫否决**——`agent/pre-step` 里没上闩放行、批次里有人类消息放行（防丢消息）、其余否决这一步（不取消整轮）。守卫只在 worker preset 作用域里注册。

leader 用 `team_handoff_approve`（或用户在面板点「批准」）批准后：建同岗位的继任会话（`agent-team-worker`）→ 更新岗位表 → 投递交接单 → 归档旧会话。

不合格就先要它补：leader 用 `team_handoff_more_info`（面板是「要求补充」按钮，`POST /agent-team/more-info`，`note` 必填）。这一步**不结束申请**——申请保持 `pending`，同时**解除上闩**（否则 worker 连补单子的一步都跑不了），并给它发一条 `question` 说清缺什么。它补齐后重新调 `team_handoff_request` 时**更新的是同一张单子**（同 id、`revisions+1`、清掉 `infoRequested`、重新上闩），不会冒出第二张。

**上闩守卫**注册在 worker preset 的作用域里，所以只对团队 worker 生效；它的规则是：没上闩放行、**批次里有人类消息就放行**（防丢消息）、其余否决这一步（不取消整轮）。

## 面板

侧边栏底部有一个 **Agent Team** 按钮，有待办时显示红色角标。点开是右侧抽屉，两个标签页：

- **工作区下拉**（1.9.0）：抽屉头部「工作区」按钮 = `GET /agent-team/workspaces` 的注册表列表；
  徽章口径只算当前工作区，别的团队只在选项上带 `●N`；选择存 localStorage。
  **不是原生 `<select>`** —— 和消息页的筛选一样是自绘下拉（按钮 + 列表），
  而且从 1.9.0 起列表用 `position: fixed` 锚点、抽屉标 `-webkit-app-region: no-drag`：
  Electron 里拖拽区会吃掉点击（2026-11-21 用户实测踩到，见 `docs/verification-frontend.md` §8.4）。
- **待办**：列出挂起的派发申请与**交接申请**，可**批准 / 拒绝**（拒绝可填原因）。批准会真的建出 worker 会话并投递第一条任务；批准交接会建继任会话、归档旧会话。顶部还有一张 **leader 卡片**：显示 leader 状态（在线 / 已归档 / 还没有），并有「移交…」——leader 归档后用户从面板指定接任会话，这是唯一的人工接管入口（`POST /admin/promote-leader`，必须带 `confirm: "PROMOTE"`）。
- **消息**：团队组播的只读审计——类型/收件人/时间/状态四个筛选、摘要/id/会话搜索、一键清空、按需加载正文、每个收件人的投递状态。筛选控件是自绘下拉（按钮 + 绝对定位列表），不是原生 `<select>`：原生下拉的**弹出列表由系统绘制**，深色主题下会是一块白底，样式管不到。

消息分页走 `before` **id 游标**（`/messages?limit&before=`）：`/state` 只带最新 100 条 + `totalMessages`，面板据此决定要不要显示「加载更早」。不用 offset —— 消息只追加，offset 在翻页期间来新消息时会漏条/重条。

## 消息怎么排队

`post()` 先入库再 `await deliver()`，`deliver()` 是**单写者循环**：按 id 顺序逐条投，投完一条才投下一条。所以同一 Host 里投递顺序 = `post()` 调用顺序。

投递方式（`deliveryModeOf`）：`urgent` → `steer`；`notice`/`roster-update` → `inject`（不唤醒）；其余 → `queue`。

DSH 侧（0.2.2-rc.5）：`queue` 走 `agent.followup`（追加到 `next-turn` 并唤醒，`dsh-agent-loop:573-580`），而每一步 `inbox.claim` 取 `next-turn` 时是 `mutate('next-turn', 0, 1)` —— **一次只取 1 条**（`dsh-agent-loop:103-105`）。所以：

- 多个 worker 同时汇报 → **一条消息一轮**，按到达顺序 FIFO，不会合并、不会互相覆盖；
- `inject` 不排队，躺在 `next-step` 等 leader 下次开跑时搭车，不额外唤醒；
- `urgent` 不是插队：只在 leader 正在跑时打进当前这一步，空闲时照样等下一轮；
- 队列没有上限；leader 归档后是**投递失败**（`delivery` 记 `failed`），不静默丢。

## 保留策略（store 有界）

`maxMessages`（默认 5000）→ `retainMessages`（默认 2000）：超过上限时把最旧的**挪进** `.team/archive/messages/<首id>..<末id>.json`，正文留在 `bodies/` 不删。顺序是**写归档 → 回读校验 → 才摘除**，校验不过就抛错、store 原封不动。还没投递成功的（`delivery` 里还有 `pending`）不归档。

手动：`POST /agent-team/admin/prune`（默认干跑，只回计划；真跑要 `confirm: "PRUNE"`）。归档里的消息面板看不到 —— 这是"活跃 store 有界"的代价。

面板走同源路由 `/agent-team/*`（只接受 loopback），不碰会话、不改任何已读游标。消息页有四个筛选（类型 / 收件人 / 时间 / 投递状态）+ 搜索，可叠加、可一键清空。

**实时**：`GET /agent-team/events` 是 SSE 流，只推「store 变了」这一个事实（`event: team`，带递增 `seq`），面板收到就重拉 `/state` —— 推送与审计读同一份投影。`save()` 侧按 120ms 合并，25 秒一次心跳。前端连上就停轮询，断流退回 3 秒轮询并自己重连，抽屉标题栏的小圆点显示当前是「实时」还是「轮询」。桌面通知还没做。

## leader 移交

一个团队只允许一个 leader，所以「换人」不是加一个，而是**同一次写盘里卸任 + 任命**：旧 leader 记 `status: 'replaced'` 与 `replacedBy`（留档不删），`state.leader` 同时换人，写一条 `leaderHistory`，给活着的成员发 `roster-update`（`inject`，不唤醒）。

- 只有面板/本机 HTTP 能触发（`promoteLeader` 挂在服务上，但**没有任何工具转发给它**）；`claimLeader` 依旧拒绝自动接手 —— "宕机后由人工接管"是用户 2026-11-21 的决定。
- 拒绝已归档的会话与不存在的 id；目标是现任 leader 时幂等返回 `changed: false`。
- 目标不是 `agent-team` 预设时给警告：它只有审批权，没有派发工具。
- leader 不在线时，用户代批的交接单改由 `at-system` 署名「接手」，不冒充已归档的 leader。

## 已知限制（P2 范围内，未实现的部分）

- 组播的 `steer` 只在对方正在跑时才有意义；当前实现按 `urgent` 直接选它，没有先判对方状态。
- 交接只覆盖 worker；leader 交接归用户（章程 §3.3）——面板的「移交…」是它唯一的实现，模型不能自己提拔。
- 交接三条路径都有了：leader 批准 / 拒绝 / 要求补充（面板同权）。没有"过期自动处置"，也没做交接单的版本 diff（`revisions` 只记摘要）。
- 没有消息配额、没有自动熔断——按设计如此，风控判断归 leader。
- 两个 preset 的通用工具清单目前是从 `standard` 复制来的，升级 DSH 时需要手工对齐（后续可改生成）。

## preset 的工具清单是生成的

`cordis.patch.yml` 里两个 preset 的 `config.plugins` 由 `scripts/gen-preset-tools.mjs` 从**安装目录**
`app.asar` 里的 `dsh-web-app/presets/standard.patch.yml` 生成。**不要手改**：下一轮生成会覆盖，
而且 pre-commit 会拿 standard 做 `--check`，漂移即拒绝提交。

团队只声明这些差异：`persona`（自己的系统提示）、`tool-agent-team-leader` / `-worker`（团队工具）、
移除 `tool-plugin-manager` / `tool-plugin-market`（不该自己装卸插件）、`agent-instructions`（不注入 AGENTS.md，
省 3.7k tokens/请求）、`tool-schedule` / `command-goal` / `tool-goal`（排期与目标工具与团队任务无关）。
两个 preset 22 → 18 项。升级 DSH 之后跑
`node scripts/gen-preset-tools.mjs --write` 同步，再重新安装 bundle。

**preset 清单是策展白名单**（1.8.0 起）：`scripts/gen-preset-tools.mjs` 的 `CURATED` 列出团队会话要的插件，
条目正文取自 shipped `standard`（config 跟版本走），`persona` / `delegation` 用我们自己的版本，末尾追加 `tool-agent-team-*`。
白名单 id 在 standard 里缺失 → `--check` 报错（那是上游改名/删除，必须人改清单）；standard 新增项不会自动进来。

**归档对账**（1.5.0 起）：`reconcileArchived()` 读 `workspaceRegistry.archivedSessionIds`，把 store 里还写着 `active` 的会话改成 `archived`；leader 若在其中就卸任（`state.leader = null` + `leaderHistory {reason:'leader-archived'}` + 通知活着成员）。
触发点：`/agent-team/*` 的所有 GET、`leaderState()`、`claimLeader()`、`setArchived()` 结束处。
**卸任 ≠ 提拔**：接任必须由一个用户新建的 leader 会话惰性认领，Host 不做自动上位。

**上下文用量**（1.3.0 起）：`contextBand({used, window, suggestAt, requireAt})` 是纯函数；
`contextReport(sessionId)` 从会话事件里取最后一条带 `usage` 的 `assistant/message`，
`used = inputTokens + cacheReadTokens`，除窗口得比例，分 `keep-working` / `suggest-handoff` / `handoff-now`。
没跑过模型轮返回 `available:false`。`requestHandoff` 会把这一行写进交接单，并通过 `team_context` 暴露给模型。

**广播收件人**（`resolveRecipients`，1.2.0 起）：`archived` / `replaced` 的会话不算成员——
`all` 与 `role:` 跳过它们，显式发给它们报错 `收件人已归档`。
