# 变更记录

版本号遵循语义化版本；本项目是 DSH 的插件 bundle（`agent-team/`），打包出来的 tarball 只有
代码 + patch + locale + 图标 + 详述 + LICENSE（10 个文件）。

---

## 1.10.0 — 2026-11-22

**主题：会话状态能力 + 投递可见性 —— 把"对方现在在不在跑、前面还堵着几条"变成查得到的事实。**

### 问题

- 发件人只看到 `delivered` 就以为对方马上处理，于是继续连发；收件人看不到积压，继续回。
  队列越排越长，恶性循环。三种投递方式的命运完全不同，但回执长得一模一样：
  `followup`（下一轮 + 唤醒）、`steer`（当前轮下一步 + 唤醒）、
  `inject`（当前轮下一步 + **不唤醒** —— 打到空闲会话会一直停在 inbox）。
- 没有任何工具能查自己/别人的积压，也没有任何地方记"投递时对方是 idle 还是 running"。

### 做法

- **`deliveryVerdict()` / `readQueue()`（纯函数，导出）**：`readQueue(agent)` 只读 live agent 的
  `status` 与 `inbox.nextTurn/nextStep`，同步、不查日志、不唤醒；`deliveryVerdict()` 把
  投递方式 × 目标状态翻成 `woken-now` / `queued-turn` / `steered-step` / `injected-step` /
  `parked-no-wake` / `held` / `failed` / `pending-delivery`。
- **`deliver()` 发送前后各读一次队列**：slot 增加 `outcome` / `targetStatus` /
  `queueBefore` / `queueAfter` / `ahead`（旧字段 `session` / `state` / `mode` / `at` / `error` 保持不变）。
  `held`、`failed`、重入（`pending-delivery`）三条分支都写得出判定。
- **回执 `hint`（`deliveryHint()`，纯函数）**：工具层原样透传，模型不用自己解释 outcome ——
  「对方正在跑，前面已有 2 条排队（最久 95 秒）；你这条排在它下一轮。先等回执，别连发。」
- **团队消息 `source` 补 `from` / `teamKind` / `ts`**（`kind` 仍是 `'agent-team'`，上闩守卫判据不变），
  收件人据此知道自己欠了谁的什么、等了多久（`waitMs`）。
- **新工具 `team_status`（leader / worker 都注册）**：默认查自己，`session` 查队友；
  返回 `status` / `latched` / `inbox`（最多 20 条团队消息 + 人类消息只计数）/
  `delivery { pending, held, failed }` / `activity` / `context` / `hint`。
  **只走 `ctx.agents.get`，绝不 `resolveAgent`** —— 归档会话只报 `archived`，未挂载报 `not-live`，
  看一眼不会把冷会话拉起来（测试断言 `resolveAgent` 调用次数为 0）。
  权限沿用既有口径：团队外抛错；别人的上下文用量只有 leader 能看（worker 查别人为 `null`）。
- **`activity()` 增加 `queues`**：每个在职成员此刻的队列深度（归档/已替换成员不出现、不拉起）。
  面板不改，下次刷新即可见。
- `inject` 增加 `'agents'` 依赖（只读）。
- **persona 教会模型用这套数据**（`agent-team/cordis.patch.yml`）：leader ——「发之前先 `team_status`
  收件人；发之后读 `delivery[].outcome`，`queued-turn` 就别重发同一条」；worker ——「汇报/提问前先
  `team_status` 自己（`inbox.total>0` 先清账），也看 leader 的 `inbox.teamTurn`，排队长就把要说的
  合并成一条汇报」。顺带把「worker 有哪些工具」的过时说法改成按角色列全（共享 4 / worker 专属 2 /
  leader 专属 5）。
- **收尾修正（复核后）**：`parked-no-wake` 的 hint 原来叫模型"改用 team_post（queue）"——`team_post`
  没有 `mode` 参数，这条建议不可执行；改成「重发 `priority: "urgent"`」或「换成 task/report 这类
  kind（走 queue）」。`statusReport` 对**在职但未挂载**的会话不再读 `context`（那要走
  `sessionController.events`，等于为看一眼去碰会话日志）——现在未挂载/归档一律 `context: null`，
  测试同时断言 `events` 调用次数为 0。`team_status` 的输出 schema 补上 `context`。
- **验证岗复核后的修正（P2，仍属 1.10.0）**：
  - `formatWait(null)` 经 `Number(null)` 变成 0，真机回执里出现过「前面已有 0 条排队（最久 0 秒）」——
    现在 `null` / `undefined` / 非有限数一律空串（不写「最久 …」），亚秒级等待最少说 1 秒。
  - `delivery.failed` 是**历史累计**（failed slot 永不自动清理），以前它独占 hint 优先位，
    "一小时前失败过一条"会一直盖住"现在空闲且队列空"；现在主提示照常出，失败只做后缀
    （没有主提示时才自己当主提示）。`delivery` 仍是 `{pending, held, failed}`，不新增字段。
  - `replaced`（被新 leader 顶替的旧会话）以前被报成 `archived: true`；现在 `archived: false` +
    `replaced: true` + `status: "replaced"`，hint 指向同岗位接任者（队列/context 仍按不在职处理）。
  - 1.10.0 之前写下的 slot 没有 `outcome`：回执按 `outcome: "unknown"` 投影，不留 `undefined`
    （DSH 的工具输出要求 lossless JSON，一个 `undefined` 会让整次输出判非法）。
  - 规格 `docs/delivery-visibility.md` 同步：§4.2（context 只给"自己 / leader 查已挂载队友"、replaced、
    failed 的历史语义）、§4.3（优先级重排 + 失败后缀）、§4.4（自查不算团队外）、§5.3（旧 slot 兼容）、
    §8 补第 11–14 条断言。
- **真机验收发现的 hint 空洞（2026-11-22，仍属 1.10.0）**：`team_status.hint` 有两处会留空串 ——
  **idle + 积压**（对方的 inject 停在 `next-step`，`teamTurn === 0`，5/7/9 三条分支全不命中）与
  **running + 空队列**（空队列不等于"立刻处理"，而是排到下一轮）。两处都补了档位：
  「对方空闲，但 inbox 里有 N 条不唤醒的消息…」与「对方正在跑但队列空：现在发会排到它下一轮，
  不是立刻处理。」；顺序保持 archived > replaced > latched > not-live > self 积压 > idle+积压 >
  running 排队 > running+空队列 > 空闲且队列空，failed 仍只做后缀。补完后三档正好覆盖
  "发出去会怎样"的三种基本态：**立刻处理 / 排队 / 停住不动**。测试补 `[13]`、`[14]`，
  规格 §4.3 增两档、§8 增第 15–16 条。

### 验证

- **`scripts/test-delivery-visibility.mjs`（新增，无第三方依赖）**：`createTeamStore` + 假 Agent
  （`followup`/`steer`/`inject` 按真实语义改 inbox）覆盖 `docs/delivery-visibility.md` §8 的 10 条
  + §5.1 纯函数表 + 验证岗 P2 与真机回归补充的 6 条断言；逐条打印 PASS/FAIL，**15/15 passed，exit 0**。
- `node --check agent-team/index.js` / `node --check agent-team/tools.js` / `node scripts/guard-daily-profile.mjs`
  全部通过（guard：0 error / 1 warning，警告是既有的 desktop 链接提示）。
- **真机 p2-test：124/124（`ok: true`、`errors: []`）**（验证岗跑的，`startedAt 2026-11-21T17:07:51Z`）。
  工具数 `toolCounts`：standard 40 / leader 38 / worker 35；验证岗本轮新增两条 check ——
  `workerHasStatusTool`（`team_status` 真的注册进了 worker 工具表）与 `teamStatusReportsLiveSession`
  （服务层 `statusReport` 在真机会话上返回：自查 running + `delivery {0,0,0}` + `context.available: true`；
  worker 查 leader 时 `context: null`；查团队外抛「会话不在本团队」；执行前后 `sessions` / `archived`
  计数不变，即**读状态不新建、也不拉起会话**）。
  **口径**：这覆盖的是"工具注册 + 服务层返回"，**尚未有模型在真机会话里实际调用过 `team_status`** ——
  文案层面不要写成"模型实调已验证"。
- P2-1 与三类 gate 的"可重跑性"问题修在 `spike-p2`（验证基础设施，不是 1.10.0 的功能回归）。
- **未做**：面板 UI（本版只备数据）、队列上限/拒发/自动熔断（既有决定：判断归 leader）。

---

## 1.9.1 — 2026-11-21

### 修复

- **会话 id 跨工作区撞号（1.9.0 的回归）**：`nextWorkerId` 用的是 `state.nextWorkerSeq`，
  而 1.9.0 把 store 拆成"一个工作区一份"之后，这个计数器变成了**每个工作区各数各的** ——
  两个团队若用同名岗位（`worker-a/b/c`），各自从 `01` 发号，就会发出**同一个会话 id**。
  DSH 的会话 id 是全局键，于是拒绝：`session "at-w-03-worker-3" belongs to "…\ws-c", not "…\ws-b"`。
  现在发号前查「本 store 岗位表 / 注册表归档集 / 每个工作区的 `sessionIds`」，撞号就换下一个；
  DSH 仍报冲突则换号重试（≤5 次）。
- **批准失败会把申请永久卡死**：`approveSpawn` 原来先写 `status='approved'` 再建会话，
  建会话一抛错，申请就永远停在 approved —— 不在待办里、也不会重试（用户看到的是"批准了但没建出来，
  也无法再批"）。现在**先建会话、成功才算批准**；失败退回 `pending` 并记 `spawnError`，可再点一次。
- **面板错误不可读**：`操作失败：{"error":"…"}` 的转义 JSON 改成取 `error` 字段，并提示"已退回待批"。
- **`workspace()` 的工作区判定**：优先用「本 store 岗位表里已有会话实际所在的工作区」，
  其次按 `pathKey` 精确匹配路径，最后才注册（不再单纯依赖 `resolveByPath` 的 realpath 回落）。

### 变更

- **验收工作区搬到仓库外**：仓库外的验收工作区（此前是仓库里的 `.p2-sandbox`，
  会被当成"仓库内工作区"，盘上攒了 289 个测试会话与 4 条工作区注册）。`sandbox.patch.yml`
  与 harness 默认值同步改；文档里的路径一并更新。

### 验证

- **用户手工实测通过**（2026-11-21 17:0x）：两个工作区各建一个 leader + 三个同名 worker
  （`worker-a/b/c`），互不串台；
- 盘上核对（本轮实测）：
  - 两个团队用**完全相同的岗位名**，拿到**不同会话 id** —— `at-w-01/02/03-worker-a/b/c`（AT-Sandbox）
    vs `at-w-10/11/12-worker-a/b/c`（AgentWorkTeam）；
  - 会话文件实际落在各自工作区的目录里；176 个会话 id **无一重复**；
  - 两个团队的 store 岗位表**零交集**；消息的收发方全部在本团队内（`at-system` 除外，是系统发送方）；
  - 6 条批准申请全部 `approved` 且都有 `sessionId`，无 `spawnError`。
- **自动化验收未重跑**：本轮修复后没有完整跑 harness（用户改为手工测试），
  `.p2/report.json` 仍是 1.9.0 的 121/121，**不代表 1.9.1 的自动化结果**。

---

## 1.9.0 — 2026-11-21

**主题：多工作区 —— 一个工作区一个团队。**

1.8.0 及以前是"一个 profile 一个团队"：Host 是单例闭包，只认配置里那一个 `workspaceRoot`，
在项目 B 里建 `Agent Team · Leader` 读写的仍是项目 A 的 `.team/`。1.9.0 把它改成按工作区分片。

### 新增

- **按工作区的 store**：`createTeamStore(root)` 工厂 + `apply()` 里的 `Map<pathKey, store>` 缓存；
  已有团队零迁移（它本来就在自己的工作区里），新工作区第一次用到时自动建空 store。
- **工具按调用方会话找团队**：`ctx.agentTeam.forSession(sessionId)`（`workspaceRegistry.list()` 的
  `sessionIds` 是权威账本），`tools.js` 里 13 处绑定。**工具签名一个没动**。
- **面板工作区下拉**：`GET /agent-team/workspaces`；抽屉头部下拉 = 注册表里的工作区，
  徽章口径**只算当前工作区**，别的团队只在选项上带 `●N`；选择存 localStorage。
  所有面板请求带 `?workspace=`（不带 = 默认工作区，单工作区行为与 1.8.0 一致；未知路径 400）。
- **跨区守卫**：跨工作区 `team_post` 直接拒绝（`收件人不在本团队: <id>（…）`）。
- **只读 peek**：下拉里别的团队的 `●N` 只读扫 `<ws>/.team/store.json`（按 mtime+size 缓存），
  不会为了画一个圆点就在别人的项目里建 `.team/`。
- **诊断开关**：面板 URL 加 `&diag=1`（或 `localStorage['dsh.agent-team.diag']='1'`）后，
  页面每次点击都 POST 到 `/agent-team/diag`，落 `.team/client-diag.jsonl` —— 默认关。

### 修复

- **桌面端点工作区下拉没反应**（用户实测）：原生 `<select>` 的弹层在 Electron 里不开/被吞。
  换成自绘下拉 + 列表 `position: fixed` 锚点 + 抽屉 `WebkitAppRegion: no-drag`
  （Electron 的拖拽区会优先当窗口拖动、吃掉点击）。原因与排查过程见 `docs/verification-frontend.md` §8.4。

### 验证

- 全量验收 **121/121**（1.8.0 是 115；新增 6 条：两工作区隔离 / 面板 `?workspace=` /
  旧配置回落默认 / `/workspaces` 列表 / 徽章数与 `pendingActions` 一致 / peek 不建目录）；
- 面板真鼠标探针 `spike-p2/panel-probe.mjs` **15/15**（CDP `Input.dispatchMouseEvent`）；
- 桌面端实测可用（用户确认）；
- 改造分四站提交，回退点：`mw-step1-store` → `mw-step2-resolve` → `mw-step3-panel` → `v1.9.0`；
  整条线放弃用 `pre-multi-workspace`（= `v1.8.0` = `5d5d501`）。

---

## 1.8.0 — 2026-11-21

### 改变（迁移友好）

- **preset 工具清单从"抄 standard"改成"策展白名单"**：`scripts/gen-preset-tools.mjs` 里 `CURATED` 明确列出 16 个插件，
  条目正文仍从 shipped `standard` 取（config 跟着 DSH 版本走），`persona` / `delegation` 用我们自己的版本，末尾追加 `tool-agent-team-*`。
  - 白名单里的 id 在新版 standard 中**不存在** → `--check` 直接报错并提示改 `CURATED`（上游改名/删除时立刻暴露，而不是启动才炸）；
  - standard **新增**插件不会自动进来（要就加一行）。
- 结果：换 DSH 版本时 `install` + 重启即可用，不再必须先重生成清单；工具表也稳定了。
- 清单内容与 1.7.1 **逐字节一致**（18 项、顺序不变），`--write` 报"0 个 slot 有变化"。

### 验证

115/115（生成器改动不涉及运行时行为；`--check` exit 0、`--write` 无变化）。

---

## 1.7.1 — 2026-11-21

### 修复

- **归档安全阀过严**：`setArchived` 原来只要 agent 被实例化过就跳过（`!== undefined`），于是"刚跑过、现在空闲"的会话永远归档不掉（清场时 3 个空闲会话全被跳过，最终由用户在界面手动归档）。判据改成 `agent.status === 'running'`：只跳过真正在跑的回合。

> 说明：这条改动只有两行，按用户要求没有再跑一遍全量验收；下一次全量跑会自然覆盖。

---

## 1.7.0 — 2026-11-21

### 修复（两处实测问题）

**1. leader 卡在 `wait_agent`，团队消息排在队列里**

`wait_agent` / `list_agents` / `send_message` 来自 `dsh-tool-subagent-control`（子智能体通道），被 team preset 从 standard 原样继承。leader 拿它"等 worker 回复"，`timeout_ms: 180000` 超时后再调一次，整轮结束不了——而团队消息只在**新一轮开始时**才被取走，于是全排在队列里（实测积压 19 次 splice、约 6 分钟）。

- 两个 team preset 的 `delegation` 组去掉 `tool-subagent-control`（`subagent` / `subagent_fork` / `workflow` 保留）；
- 生成器把 `delegation` 列为 `override`，`--check` / `--write` 不会把它加回来；
- persona：「团队协作是异步的：发完消息就**结束这一轮**，回复会在你下一轮开始时到达；不要阻塞等待」。

**2. 没有 leader 时 `team_directory` 直接报错**

`directory()` 返回 `leader: state.leader`（null），撞上工具输出 schema 的 `type: 'string'` → `returned invalid output: "value.leader" must be a string`。改为 `leader: state.leader ?? ''` + 新增 `hasLeader: boolean`。

### 验证

115/115（新增 `teamPresetHasNoSubagentControlTools`、`directoryHandlesNoLeader`）。

---

## 1.6.1 — 2026-11-21

### 修复（实测事故）

leader 用自己的工具表当全集，推断"`team_directory` 这个工具不存在"，命令 worker 把产物里的工具名改成 `team_roster`——而 **worker 根本没有 `team_roster`**，它那次用的就是 `team_directory`。两代之后继任者读文件自证"是 team_roster，无误"，假陈述自我强化。

- `team_directory` 改成**两种角色都有**（只读通讯录）。
- leader persona：不要从自己的工具表推断某工具不存在；不要要求 worker 改写已记录的事实；要核对就调 `team_directory` 或让它贴出真实工具返回。
- worker persona：产物里"哪个工具产出了它"照实写；别人的"改正"与自己的历史冲突时，先说清楚并引用自己的调用记录。
- 把 `probe-b.md` 第 6 行改回 `team_directory`。

### 验证

113/113（新增 `leaderHasDirectoryAndRoster`）。

---

## 1.6.0 — 2026-11-21

### 新增

- **leader 可以给自己提继任申请**（用户实测报的缺口：leader 只会"建议开新会话"，交接仍是手动的）。
  - 新工具 `team_request_successor`（leader 侧，参数与 `team_handoff_request` 一致）。
  - **只能由用户批准**：`leader 不能批准自己的继任`。
  - 批准后建 `agent-team` 预设的 `at-lead-NN` 新会话、交接单投给它、`state.leader` 切换、旧 leader 归档、`leaderHistory` 记 `reason:'leader-handoff'`。
  - 等待期间旧 leader 上闩，并收到一条 inject 回执（"申请已登记，不要重复提交"）。
- leader persona 的上下文纪律改为：到 suggest 档就**提交继任申请**（不再只是"口头建议用户"）；到 handoff-now 立刻提交。

### 修复

- leader 提申请时不再 `post({to:'leader'})`（会撞"leader 不能发给自己"）；改为给自己一条 inject 回执。

### 验证

112/112（新增 4 条：leader 能提 / 不能自批 / 用户批准后移交 / 继任预设确实是 leader）。

---

## 1.5.0 — 2026-11-21

### 修复（用户实测报的两个真问题）

1. **leader 被归档后标记不更新**，团队卡在死会话上，只能人工移交。
2. **面板的团队列表仍显示已归档的会话**，得点开才发现不对。

根因：归档走的是工作区注册表，我方 store 收不到通知。

### 改法

- 新增 `reconcileArchived()`：把 registry 里已归档、而 store 还写着 `active` 的会话改成 `archived`；**leader 若在其中就卸任**（`state.leader = null`），写 `leaderHistory {by:'system', reason:'leader-archived'}`，并给活着的成员发 `roster-update`（inject 不唤醒）。
- 触发点：所有 `/agent-team/*` GET（面板每次刷新都会对账）、`leaderState()`、`claimLeader()`、`setArchived()` 结束处。
- **不自动提拔**：卸任 ≠ 提拔。用户新开一个 `Agent Team · Leader` 会话、它第一次调工具时按既有规则惰性认领——不需要再手动移交。
- `setArchived()` 归档/恢复成功后立刻同步岗位表状态，并在返回值里带 `reconciled`。
- `/state` 多回 `leaderReleased`（最近一次 `to: null` 的移交记录）。
- 面板：①侧边栏按钮除了待办红角标，新增**琥珀色小点**（leader 没了 / 有投递异常时不点开也看得见）；②团队卡片只列活跃会话，另起一行"N 个已归档/已替换"；③leader 卡片写明"原 leader X 在 HH:MM 被归档，席位已空出，新开一个 leader 会话会自动接任"。

### 验证

108/108（新增 5 条：归档 leader 后卸任 / 留痕 / 岗位表标记 / 新会话接任 / `/state` 反映）。

---

## 1.4.1 — 2026-11-21

### 修复

- **清场后 id 复用**：`resetTeam()` 会把 `nextWorkerSeq` / `nextMessageId` 一起归零，但归档的会话（`at-w-01-frontend` 等）与旧消息的 `bodies/m-000001.md` 还在盘上——清场后新建的 worker 会撞到同一个会话 id，新消息会覆盖旧正文（这正是 1.0.x 里 `m-000001` 正文错配的根因之一）。现在计数器**不归零**，`generation` 加一用来区分"第几次重开"。

### 验证

103/103（新增 2 条：清场后岗位表为空且 generation 递增；清场后两个 id 计数器不变）。

---

## 1.4.0 — 2026-11-21

### 改变（worker 的通信通道定案）

| 能力 | leader | worker |
|---|---|---|
| 单播（一个 id） | ✓ | ✓ |
| 多播（显式多个 id） | ✓ | ✓（必须逐个写 id） |
| 岗位组广播 `role:<岗位>` | ✓ 任意岗位 | ✓ **只能自己岗位**（章程 §4.1"同组同事"，之前一律拒绝——实现比章程严） |
| 全体广播 `all` | ✓ | ✗ `只有 leader 可以发给全体` |

- **修掉一个会骗模型的文案**：`team_post` 的描述原来两种角色共用，写着"可发 `all` / `role:<岗位>`"，worker 照着试只会拿到权限错误。现在描述按角色生成。
- `workerCannotGroupByRole` 的报错文案改成 `worker 只能发 role:<自己的岗位>（你的岗位是 …）`。

### 验证

101/101（新增 2 条：worker 多播到两个显式 id、worker 同组合播只发给同岗位同事且不含自己）。

---

## 1.3.0 — 2026-11-21

### 新增

- **`team_context` 工具**：看自己（leader 可看任意成员）的上下文用量 `{used, window, ratio, band, hint}`，`used = inputTokens + cacheReadTokens`，分档 `keep-working`(<45%) / `suggest-handoff`(45–55%) / `handoff-now`(≥55%)（阈值可配）。
- 交接单新增 `- 上下文：used / window（percent%，band）`；`team_handoff_request` 返回值多带 `context`。
- 配置：`contextWindow`（默认 1048576）、`handoffSuggestAt`（0.45）、`handoffRequireAt`（0.55）。

### 为什么

用户指出：交接应该**由数据触发**，而不是凭"感觉快满了"（实测里 worker 在 12% 就报了"接近上限"，虽然那次是用户让它说的，但它确实**看不到**自己的用量）。窗口约 1M，社区实测约 500k 之后质量下降——所以交接点是**质量拐点**，不是 token 拐点。

### persona 纪律（不改代码）

- worker：交接前先 `team_context`；`keep-working` 不得因"感觉快满了"交接；`suggest-handoff` 做完里程碑再交；`handoff-now` 立刻交。
- leader：批准交接**不做二次核对**；`team_handoff_more_info` 只用于结构性缺口；自己的用量到 suggest 档就主动建议用户开新会话并给数字。

### 验证

99/99（新增 6 条：交接单带上下文档位、分档三档、无用量时 unknown、工具形状、worker 不能查别人）。

---

## 1.2.0 — 2026-11-21

### 改变（成本与纪律）

- **团队 preset 去掉 4 个挂件**：`agent-instructions`（不再给团队会话注入 AGENTS.md，14.6k 字符 ≈ 3.7k tokens 每次请求）、`tool-schedule`、`command-goal`、`tool-goal`。两个 preset 22 → 18 项。团队会话的规则来自 persona + 交接单。
- **广播排除归档会话**：`resolveRecipients` 不再把 `archived` / `replaced` 算进 `all` 与 `role:`；显式发给归档会话报错「收件人已归档」。

### 数据（实测，非估算）

团队会话一次请求的构成：工具 schema 16.4k（其中 19 个工具来自桌面 bundle，preset 管不到）、system 3.3k、AGENTS.md 3.7k、**历史消息 71k（56%）**。

裁剪后：新会话首次请求 31.6k → 约 26.3k（−17%）；长会话 126k → 约 120.7k（−4%）。

> 更正：上一轮说「裁剪能省 60–70%」是错的——大头是历史，不是工具与 AGENTS.md。

### 验证

93/93（新增 4 条：广播排除归档、显式归档收件人报错、schedule/goal 工具已移除、AGENTS.md 不再注入）。

---

## 1.1.0 — 2026-11-21

### 新增

- **worker 通讯录 `team_directory`**（只读）：返回团队里还有谁、各自岗位、谁是 leader、哪条是自己。只有"谁是谁"，不含活动指标与待批申请（那些仍是 leader 的 `team_roster`）。worker 之前只能从收到的信封 `from=<会话 id>` 里猜同事是谁。

### 改变（行为）

- **上闩变成真隔离，两层**：
  1. **不投递**：目标会话已上闩时，消息不投递，slot 记为 `held`（面板显示「上闩暂扣」）；`unlatch` 后自动补投。
  2. **守卫否决**：`queue`/`steer`/`inject` 现在都由我们自己造消息（`agent.followup/steer/inject`），带 `source.kind: 'agent-team'`。以前走 `sessionController.prompt(...)`，消息被标成 `'user'`，正好命中守卫的"人类消息放行"分支——守卫那一层从来没拦过团队消息。
- 面板：消息页显示「上闩暂扣」；详情里的投递状态改成中文（未投递 / 已投递 / 已旁听 / 上闩暂扣 / 失败）。

### 验证

89/89（新增 6 条：通讯录 3 条 + 暂扣 1 条 + 解闩补投 1 条 + 守卫否决集成 1 条）。守卫的否决分支**第一次被集成验证**——以前因为"prompt 恒为 user"只能单测。

---

## 1.0.0 — 2026-11-21

**首个可用版本。** 功能面按 [`docs/charter-default.md`](./docs/charter-default.md) 收口，
验收 75/75（沙箱 profile `p2-test` + 真实浏览器渲染），桌面端实测通过。

### 模式与隔离

- 两个 preset：`Agent Team · Leader`（`agent-team`）/ `Agent Team · Worker`（`agent-team-worker`）。
- 工具只装配在各自 preset 的作用域里：`standard` 等其它模式的工具表里**没有** `team_*`（不是 `when` 隐藏，而是根本不在作用域里）。
- 上闩守卫（`agent/pre-step`）只注册在 worker preset 里，非否决分支一律 `return next()`。

### 团队与身份

- **单 leader**，惰性认领（第一个用 leader 工具的会话）；第二个会话调 leader 工具直接报错。
- leader 归档后由用户在面板**移交**：一次写盘内先卸任再任命，记 `leaderHistory`；模型没有这条路径。
- 派发两档：`ask`（写申请，面板批准才建会话）/ `autonomous`（完全权限，逐次写 `spawnLog`，可随时切回并写 `authorityLog`）。

### 消息

- 收件人：`leader` / `all` / `role:<岗位>` / 会话 id 列表；worker 只能发 leader 或团队成员，越权**抛错**不静默。
- 投递方式按 `kind` + `priority` 选：`queue`（下一轮 + 唤醒）/ `steer`（当前步 + 唤醒）/ `inject`（下一步，**不唤醒**）。
- 先入库后投递：投递失败只标记该收件人，不丢消息。
- 面板消息页：类型 / 收件人 / 时间 / 投递状态四个筛选 + 搜索 + 一键清空 + 按 id 游标往前翻页 + 正文按需加载；`/agent-team/events` SSE 实时，断流退回 3 秒轮询。

### 交接

- 四条路径：申请 → **批准 / 拒绝 / 要求补充**；批准后建继任会话、更新岗位表、投递交接单、归档旧会话。
- 要求补充：申请保持挂起、**解除申请方上闩**（否则它连补单子的一步都跑不了）、写清缺什么；补齐后重新提交**更新同一张单子**。
- 交接单自包含落盘（`.team/handoffs/`），新会话看不到旧对话。

### 运维

- **store 保留策略**：活跃消息超过 `maxMessages`（默认 5000）就把最旧的**归档**到 `.team/archive/messages/`，降到 `retainMessages`（默认 2000）。归档不是删除：先写归档 → 回读校验 → 才从 store 摘除；还有 `pending` 投递的不归档。
- **preset 工具清单从 `standard` 生成**（`scripts/gen-preset-tools.mjs`，事实源是安装目录 `app.asar` 里的 `standard.patch.yml`），`--check` 接进 pre-commit，DSH 升级导致的漂移会在提交时被抓到。团队只声明三处差异：`persona`、`tool-agent-team-*`、移除 `tool-plugin-manager` / `tool-plugin-market`。
- 打包：`npm pack` → 10 个文件，**含 LICENSE**（MIT）。

### 有意不做

- **桌面通知**（用户 2026-11-21 决定放弃）。
- **导出 / 编辑 / 删除 / 撤回 / 代发**：面板是只读审计 + 操作留痕。
- **已读回执**：会话里跑的是 agent，没有"已读"事件可观测。投递状态只有 `pending / delivered / injected / failed`，`panels.md` 里的"已读"应读作"已投递"。
- 24 小时"已完成"折叠区、虚拟滚动、正文代码高亮。

### 已知边界

- **多个 worker 同时汇报 = 逐条排队、一条一轮**（FIFO，不合并）：3 个 worker 汇报 → leader 跑 3 轮。DSH 的 `next-turn` inbox 每次只取 1 条（`dsh-agent-loop:103-105`）。
- `urgent` 不是插队：只在 leader 正在跑时打进当前这一步，空闲时同样等下一轮。
- `inject`（旁听/状态）不排队，躺在 `next-step` 等 leader 下次开跑时搭车。
- 队列没有上限；leader 归档后是投递失败（`failed`），不静默丢。
- 归档里的消息面板看不到（`/body` 只查活跃 store），要看历史直接读归档 json。
- 并发双击审批没有压测（非 `pending` 再批会报"申请不是待批状态"）。
- `steer` 在 `priority: urgent` 时直接选，没有先判对方是否正在跑。
- **worker ↔ worker 可以按会话 id 互发**（1.1.0 起还有 `team_directory` 可以查同事，见上）。
- **上闩的残余窗口**：已被对方 inbox 取走、随后才被守卫否决的消息不会回到队列（"投出去后同一瞬间才上闩"的极窄窗口）；正常流程是先上闩再发消息，不会发生。
