<a id="zh"></a>

# 团队章程 · 默认草案（v0.1）

> 中文 ｜ [English](#en)
>
> 这是**安装时随插件提供的默认草案**，不是最终章程。
> 安装后由 leader 读取本文件，按当前项目补全，写成 `team/charter.md`，交用户确认；**只有 `status: confirmed` 的章程才能正式启用团队**（建 worker、派活、组播）。
> 所有标 `[可改]` 的条目都是默认建议，leader 与用户可随时修改；框架不强制、不写死。

---

## 0. 元信息（机器可读部分）

```yaml
charter:
  version: 1                    # 每次实质修改 +1
  status: draft                 # draft | confirmed
  confirmed_by: null            # 用户确认后填 user
  confirmed_at: null
  project: ""
  workspace: ""                 # 团队工作区根目录
  leader_session: ""            # 当前 leader 的 sessionId
  leader_assigned_by: ""        # 用户指定时填 user；首个会话自动成为 leader 时填 auto
  generation: 1                 # leader 世代号，交接时 +1
  spawn_authority: ask          # ask（每次申请）| autonomous（用户授权自主）

teams:
  id_prefix:
    leader: "at-lead-"
    worker: "at-w-"

messaging:                      # [可改] 默认投递偏好
  task: queue                   # 派活：唤醒
  question: queue
  report: inject                # 汇报：不唤醒
  notice: inject
  urgent: steer

observation:                    # 风控观察，非配额
  mode: leader_defined          # leader 自定频次；可关闭
  cadence: null                 # null = 由 leader 判断
```

> 机器只读上面这些字段；其余全部是给 leader/worker 读的约定，改文字不需要动代码。

---

## 1. 团队目标与边界

```markdown
目标：
- （这个项目要达成什么，一句话）

不做：
- （明确排除的范围，防止 worker 越界）

完成定义：
- （什么算交付完成：产物、验证、验收人）
```

---

## 2. 岗位与职责

| 岗位 | 职责 | 产物 | 验收方式 | 当前会话 |
|---|---|---|---|---|
| 规划 | 拆任务、定接口、写验收清单 | 任务清单 / 接口约定 | leader 审 | `at-w-01` |
| 实现 | 按岗位范围写代码/文档 | 改动 + 自测 | 验证岗 | `at-w-02` |
| 验证 | 跑测试、核对验收清单 | 验证报告 | leader 审 | `at-w-03` |
| 审查 | 独立复查（不写实现） | 审查意见 | leader 审 | `at-w-04` |
| 集成 | 合并、回归、交付 | 交付包 | 用户 | `at-w-05` |

默认顺序参考：**需求 → 实现 → 验证 → 审查 → 集成**（失败自动回退到实现）。

规则：
- 一岗一会话；换岗开新会话、换新 id。
- 岗位数量与拆分按项目定，不要求固定五岗。
- 岗位表由 leader 独占写；worker 只读。

---

## 3. 会话与身份

- worker id：`at-w-<序号>-<岗位>`；leader id：`at-lead-<世代>`。
- 每个 worker 一个独立目录（子目录或 worktree），不共享写权限。
- 归档：旧会话保留只读记录；新会话接手的依据是**交接单**，不是旧对话。

### 3.1 Leader 身份

- **该模式下的第一个会话默认是 leader**，无需申请。
- **不接受多个 leader 并存**（用户 2026-11-21 确认）：第二个 `agent-team` 会话不会成为 leader，也不得自行接管。团队要做深，靠 worker 下面挂子智能体（一层层往下），而不是再开一个平级 leader 会话。
- 用户可以直接指定另一个会话为 leader（改 `leader_session`，或让当前 leader 执行转移）；`leader_assigned_by` 记为 `user`。
- 换 leader 视为一次世代交接：`generation + 1`，岗位表所有权转移，旧 leader 退役。
- 之后新开的会话默认是 worker 候选，**不会自动成为 leader**。

### 3.2 开新会话的权限（用户下放）

**两种新会话，两套权限，不要混用：**

| 场景 | 定义 | 谁批准 | 谁执行 | 是否需用户批准 |
|---|---|---|---|---|
| **派发** | 为新任务/新岗位开新会话 | 用户（`ask` 档）或 leader（`autonomous` 档） | leader | `ask` 档需要 |
| **交接替换** | 同岗位换一个新会话（旧会话到寿命） | **leader** | leader | **不需要**；leader 事后汇报说明 |

`spawn_authority` 只约束**派发**：

| 档位 | 含义 | 行为 |
|---|---|---|
| `ask`（默认） | 每次派发新会话都要用户批准 | leader 先提交申请：为什么开、开什么岗位、预期产出、由谁承接；用户批准后才能开 |
| `autonomous` | 用户明确授权自主派发（面板「完全权限」开关） | leader 可自行开，但每次创建都写日志，并在下一次风控汇报里说明 |

- **交接替换不受 `spawn_authority` 约束**：worker 只向 leader 申请，leader 批准后自动建新会话、更新岗位表，然后向用户汇报这次替换（说明原因与结果）。
- 权限归用户：可随时切换档位；切换写进章程变更记录。
- 未批准的派发申请不执行；leader 不得先开再补申请。

### 3.3 交接主体责任

| 交接类型 | 谁负责 | 说明 |
|---|---|---|
| worker 会话交接 | **leader** | worker 申请、leader 审批与执行、leader 向用户汇报 |
| leader 会话交接 | **用户** | leader 准备交接材料并汇报，由用户决定并启动继任会话 |
| leader 不可用（异常） | **用户代批** | 待批的交接申请进入团队待办并提示用户；用户批准后由系统执行；leader 恢复后补记 |

> leader 对用户负责且有自带的交接流程，正常情况下不依赖人工代批；代批只是异常兜底，不是常态。

---

## 4. 消息规则

### 4.1 谁能发给谁 `[可改]`

| 发送者 | 允许的收件人 |
|---|---|
| leader | 全体 / 指定多个 / 某岗位组 / 单个 |
| worker | leader、同组同事、被 leader 指定的对象 |
| 任意 | 禁止直接找用户（一律经 leader） |

越权投递由授权层拒绝，并给发送者回执。

### 4.2 消息类型

`task`（派活）、`question`（求助/请示）、`answer`（回答）、`report`（汇报）、`notice`（通知）、`handoff-request`、`handoff-approval`、`roster-update`。

### 4.3 组播约定

- 通知全员 → `to: all`，用 `inject`（不唤醒）。
- 派活给多个 → 明确列出 id，用 `queue`。
- 只给一个人 → 单发，不要用 `all` 图省事。
- worker 的三种通道（2026-11-21 定案）：**单播**（一个会话 id）/ **多播**（显式列出多个 id）/ **同组合播**（`role:<自己的岗位>`，即 §4.1 的"同组同事"）。全体广播 `all` 只给 leader。
- 正文长（日志、大段代码）→ 放 `body_ref`，信封只写摘要。

### 4.4 禁止

- 消息自动转发给第三方。
- 用组播代替点对点（噪音）。
- 绕过 leader 直接向用户提需求。

### 4.5 任务分级与推理强度

派发任务时，leader 必须给任务分级，并在投递前设定该会话的推理强度。

| 分级 | 判定参考 | 默认强度 |
|---|---|---|
| `simple` | 单文件、机械改动、问答、通知、汇报 | `off` |
| `moderate` | 多文件、需调研但路径明确、常规实现 | `high` |
| `complex` | 架构/跨模块、高风险、长时间、需要权衡 | `max` |

- **`max` 只用于 `complex`**，且 leader 在派发说明里写清理由；能用 `high` 解决的不上 `max`。
- 同一会话可随任务切换强度（每次派发前设定），不是建会话时一次定死。
- 交接单记录「建议强度」；新会话按下一项任务重新设定。
- 报告与面板统计 `max` 使用次数，**只展示、不阻断**。
- 映射可改（团队章程或插件配置），不写死。

---

## 5. 风控口径（默认，leader 可改）

- **框架不给阈值，不定义"异常"。** leader 自主判断。
- 观察频次由 leader 自定，可关闭。
- **必须汇报给用户**的两种情形：
  1. leader 判定异常并采取处置（哪怕只发了一条提醒）；
  2. leader 不确定是否异常。
- 汇报内容的最低要求：让用户能**复核并决定下一步**（发生了什么、涉及谁、依据在哪、已做什么、要用户定什么）。**格式不限**，按项目与用户习惯写。
- leader 可暂停单个会话；暂停整个团队需用户确认。
- 正常就不干预：不因"消息多"本身动作。

---

## 6. 交接

### 6.1 触发

- worker 或 leader 自判（参考上下文占用、任务阶段、产出稳定性），**不设硬阈值**。
- 交接必须发生在可持久化的检查点，不在工具执行中途。

### 6.2 交接单字段 `[可改]`

```markdown
- 岗位与目标
- 已完成（可验证的条目）
- 产物路径（文件 / 分支 / 链接）
- 关键决策与理由
- 已知坑与未验证项
- 下一步（可执行的第一条动作）
- 未完成任务（含依赖）
- 子智能体状态（还在跑的要写清）
```

### 6.3 流程（worker，由 leader 负责）

1. worker 写交接单；
2. 向 leader 发 `handoff-request`（旧 id → 新 id 占位、岗位、交接单路径）；
3. leader 审批（**不需要向用户申请**）；
4. leader 更新岗位表，创建新会话，回 `handoff-approval`；
5. 新会话启动并读交接单；
6. 旧会话归档；
7. leader 向用户汇报：哪个岗位换了会话、为什么、结果如何。

### 6.4 流程（leader，由用户负责）

leader 交接**由用户负责**：leader 只准备材料与汇报，不自行启动继任、不自行转移所有权。

1. leader 写交接单 + 继任方案（建议的新 leader 会话、岗位表交接、未完成任务、未读消息）；
2. 向用户汇报（这是通知兼建议，不是申请，也不自行执行）；
3. 用户决定；由用户启动继任会话，或明确指示 leader 代为执行；
4. 岗位表 `generation + 1`，所有权转给新 leader；
5. 旧 leader 退役。

### 6.5 失败处理与降级

任何一步失败：保留原会话、回到交接前状态，并把失败原因告诉发起者；不静默丢弃交接单。

**leader 不可用时的降级**：

- 待批的 worker 交接申请**挂起**，进入团队待办，并向用户提示。
- 由用户**人工代批**；批准后由系统执行建会话与岗位表更新。
- 不自动通过、不静默丢弃、不积压到过期。
- worker 仍不直接找用户：用户看到的是系统提示的待办事项，不是 worker 的消息。
- leader 恢复后补记这次决定（谁批的、为什么、结果）。

#### 待批的形式（人工代批）

- **载体**：插件面板里的「团队待办」清单，不是聊天消息。Host 服务持久化，刷新/重启不丢。（面板规格见 [panels.md](./panels.md)）
- **提示**：面板角标；点开看到：申请方会话、岗位、原因、交接单、建议动作。（桌面通知已放弃）
- **操作**：批准 / 拒绝 / 要求补充；批准后由系统建会话、更新岗位表；结果写日志与团队记录。
- **不用 DSH 自带 approval 做代批**，原因是语义与限制不匹配：
  - `approval.request` 必须在**打开的回合内**调用（空闲会话直接拒绝）；
  - 它绑定 `toolName`，是"工具调用审批"的语义，不是"团队决策"；
  - 它受会话审批策略影响：用户把策略设为"从不询问"时，请求会被自动拒绝，交接会被卡住；
  - 它只有 `allowed-once`，没有"本任务内记住"的语义。
- **可选补充**：leader 在线时，可以用 `ask_user_question` 发一张确认卡作为即时提醒；它不替代待办队列，也不用于 leader 宕机场景。

---

## 7. 子智能体 `[可改]`

- 允许所有会话开子智能体；默认深度 1。
- 子智能体只做被指派的子任务，结果回给父会话。
- 父会话交接时，子智能体状态写进交接单；仍在跑的先打断或明确移交。
- 子智能体不开自己的组播，不直接找用户。

---

## 8. 人类介入

- 只有"必须人决定"的事才问：授权、风险、取舍、验收。
- 不问：代码在哪、怎么实现、常规偏好。
- 提问格式自由；同一问题不重复问。
- 用户未回复前，不擅自推进被询问的那一步。

---

## 9. 变更与版本

- 谁能改：leader 提议、用户确认；用户可直接改。
- 每次实质修改 `version + 1`，写变更记录。
- 生效范围：**新会话**按新章程；已开会话保持启动时的版本，除非用户要求重载。
- 章程本身也是审计对象：改了什么、谁改的、什么时候。

```markdown
变更记录：
- v1（2026-11-20）：初版，由默认草案补全
```

---

## 10. 确认检查清单

**leader 自检（提交用户前）：**

- [ ] 每条规则都能被 worker 执行（不是口号）
- [ ] 新 worker 只读章程就知道自己做什么、不做什么
- [ ] 新 leader 只读章程 + 岗位表就能接管
- [ ] 没有写死的阈值/配额/模板
- [ ] 交接单字段覆盖了"接手就能干活"的最小信息

**用户确认（决定是否正式启用）：**

- [ ] 目标与边界同意
- [ ] 岗位拆分同意
- [ ] 消息规则同意（谁能找谁）
- [ ] 风控汇报要求同意
- [ ] 交接流程同意
- [ ] leader 身份规则同意（首个会话默认为 leader，用户可改）
- [ ] 派发权限档位同意（`ask` / `autonomous`）
- [ ] 任务分级与推理强度映射同意（simple→off / moderate→high / complex→max）
- [ ] 交接主体责任同意（worker 交接归 leader，leader 交接归用户，leader 不可用由用户代批）

确认方式：把 `status` 改为 `confirmed`，填 `confirmed_by` 与 `confirmed_at`。

---

## 11. 未确认 / 未授权时的行为

- `status: draft`：leader 可以起草、讨论、写章程；**不得建 worker、不得派活、不得组播**。
- `status: confirmed` + `spawn_authority: ask`：可派活，但**每次派发新会话**都要用户批准；**交接替换不需要**。
- `status: confirmed` + `spawn_authority: autonomous`：leader 可自行派发，但每次创建都写日志，并在下一次风控汇报里说明。
- worker 交接：leader 审批即生效，leader 事后汇报。
- leader 交接：用户负责；用户未启动继任前，当前 leader 继续履职，不得自行交接。
- 章程损坏或缺失：团队停止派活，leader 先向用户报告并重建。
- 身份冲突（两个会话都声称是 leader）：以 `leader_session` + `generation` 为准，另一个降为 worker；无法判定时上报用户。

---

<a id="en"></a>

# Team charter · default draft (v0.1)

> [中文](#zh) ｜ English
>
> This is the **default draft shipped with the plugin at install time**, not the final charter.
> After installation the leader reads this file, fills it in for the current project, writes it to
> `team/charter.md` and submits it to the user for confirmation. **Only a charter with
> `status: confirmed` may activate the team** (create workers, dispatch work, multicast).
> Everything marked `[editable]` is a default suggestion; the leader and the user may change it at any
> time. The framework neither enforces nor hard-codes it.

---

## 0. Metadata (machine-readable part)

```yaml
charter:
  version: 1                    # +1 on every substantive change
  status: draft                 # draft | confirmed
  confirmed_by: null            # set to user once confirmed
  confirmed_at: null
  project: ""
  workspace: ""                 # team workspace root
  leader_session: ""            # sessionId of the current leader
  leader_assigned_by: ""        # user when the user assigned it; auto when the first session became leader
  generation: 1                 # leader generation, +1 on handoff
  spawn_authority: ask          # ask (approve every time) | autonomous (user delegated)

teams:
  id_prefix:
    leader: "at-lead-"
    worker: "at-w-"

messaging:                      # [editable] default delivery preference
  task: queue                   # dispatch: wake
  question: queue
  report: inject                # report: no wake
  notice: inject
  urgent: steer

observation:                    # risk observation, not a quota
  mode: leader_defined          # the leader chooses cadence; can be disabled
  cadence: null                 # null = the leader decides
```

> Machines read only the fields above; everything else is an agreement for leaders/workers to read, so
> changing the prose never requires changing code.

---

## 1. Team goals and boundaries

```markdown
Goal:
- (what this project must achieve, in one sentence)

Not doing:
- (explicitly out of scope, so workers do not wander)

Definition of done:
- (what counts as delivered: artifacts, verification, who signs off)
```

---

## 2. Roles and responsibilities

| Role | Responsibility | Artifact | Acceptance | Current session |
|---|---|---|---|---|
| Planning | Break down tasks, define interfaces, write the acceptance list | Task list / interface contract | Leader review | `at-w-01` |
| Implementation | Write code/docs within the role's scope | Changes + self-test | Verification role | `at-w-02` |
| Verification | Run tests, check the acceptance list | Verification report | Leader review | `at-w-03` |
| Review | Independent review (no implementation) | Review comments | Leader review | `at-w-04` |
| Integration | Merge, regression, delivery | Delivery bundle | User | `at-w-05` |

Default order: **requirements → implementation → verification → review → integration** (failures fall
back to implementation).

Rules:
- One session per role; changing roles means a new session with a new id.
- The number and split of roles follows the project; five roles are not mandatory.
- The leader is the sole writer of the roster; workers read it.

---

## 3. Sessions and identity

- Worker id: `at-w-<seq>-<role>`; leader id: `at-lead-<generation>`.
- Each worker gets its own directory (subdirectory or worktree) and does not share write access.
- Archiving: old sessions keep a read-only record; a successor works from the **handoff document**, not
  from the old conversation.

### 3.1 Leader identity

- **The first session in this mode is the leader by default**, no application needed.
- **Multiple concurrent leaders are not accepted** (user confirmed 2026-11-21): a second `agent-team`
  session never becomes leader and must not take over on its own. To scale, attach sub-agents under
  workers (level by level) rather than opening another peer leader session.
- The user may assign another session as leader directly (change `leader_session`, or have the current
  leader perform the transfer); `leader_assigned_by` is recorded as `user`.
- Changing the leader is a generation handoff: `generation + 1`, roster ownership moves, the old leader
  retires.
- Sessions opened afterwards are worker candidates and **never become leader automatically**.

### 3.2 Authority to open new sessions (delegated by the user)

**Two kinds of new session, two different authorities — do not mix them up:**

| Case | Definition | Who approves | Who executes | User approval needed |
|---|---|---|---|---|
| **Dispatch** | Open a session for a new task/role | User (`ask`) or leader (`autonomous`) | Leader | Yes under `ask` |
| **Handoff replacement** | Replace a session in the same role (old one is worn out) | **Leader** | Leader | **No**; the leader reports afterwards |

`spawn_authority` constrains **dispatch only**:

| Level | Meaning | Behaviour |
|---|---|---|
| `ask` (default) | Every dispatch needs user approval | The leader files a request first: why, which role, expected output, who takes it; only after approval may it open the session |
| `autonomous` | The user explicitly delegated dispatch (panel "full authority" switch) | The leader may open sessions itself, but logs each creation and explains it in the next risk report |

- **Handoff replacement is not constrained by `spawn_authority`**: the worker asks the leader; the leader
  approves, creates the successor, updates the roster, and then reports the replacement (why and what
  happened) to the user.
- Authority belongs to the user: the level can be switched at any time and each switch is written into
  the charter change log.
- Unapproved dispatch requests are not executed; the leader may not open first and file later.

### 3.3 Who owns each handoff

| Handoff | Owner | Notes |
|---|---|---|
| Worker session handoff | **Leader** | Worker asks, leader approves and executes, leader reports to the user |
| Leader session handoff | **User** | The leader prepares material and reports; the user decides and starts the successor |
| Leader unavailable (incident) | **User approves on the leader's behalf** | Pending requests go to the team pending list and the user is notified; after approval the system executes; the leader records it afterwards |

> The leader is accountable to the user and has its own handoff flow, so it does not normally rely on
> manual approval; manual approval is a fallback for incidents, not the norm.

---

## 4. Messaging rules

### 4.1 Who may message whom `[editable]`

| Sender | Allowed recipients |
|---|---|
| Leader | Everyone / several named / a role group / one |
| Worker | The leader, peers in the same group, targets the leader designates |
| Anyone | Direct contact with the user is forbidden (always through the leader) |

Out-of-policy delivery is rejected by the authority layer and the sender gets a receipt.

### 4.2 Message kinds

`task` (dispatch), `question` (help/ask), `answer`, `report`, `notice`, `handoff-request`,
`handoff-approval`, `roster-update`.

### 4.3 Multicast conventions

- Notifying everyone → `to: all` with `inject` (no wake).
- Dispatching to several → list the ids explicitly, use `queue`.
- One recipient → send to that one; do not use `all` for convenience.
- A worker's three channels (settled 2026-11-21): **unicast** (one session id) / **multicast** (several
  explicit ids) / **same-role multicast** (`role:<own role>`, i.e. "peers" in §4.1). Broadcast `all` is
  leader-only.
- Long bodies (logs, large code) → put them in `body_ref`; the envelope carries only the summary.

### 4.4 Forbidden

- Auto-forwarding a message to a third party.
- Using multicast where point-to-point is meant (noise).
- Bypassing the leader to ask the user for something.

### 4.5 Task tiering and reasoning effort

When dispatching, the leader must tier the task and set the session's reasoning effort before delivery.

| Tier | Rough criterion | Default effort |
|---|---|---|
| `simple` | One file, mechanical change, Q&A, notice, report | `off` |
| `moderate` | Several files, research needed but the path is clear, routine work | `high` |
| `complex` | Architecture or cross-module, high risk, long running, real trade-offs | `max` |

- **`max` is only for `complex`**, and the leader must state the reason in the dispatch note; if `high`
  is enough, do not use `max`.
- Effort may change per task within a session (set before each dispatch), not frozen at creation.
- The handoff document records a suggested effort; the successor sets effort again for its next task.
- Reports and the panel count `max` usage, **display only, never block**.
- The mapping is configurable (charter or plugin config), never hard-coded.

---

## 5. Risk-control stance (default; the leader may change it)

- **The framework sets no thresholds and does not define "anomaly".** The leader judges.
- Observation cadence is the leader's call and can be disabled.
- **Two cases that must be reported to the user**:
  1. the leader judged something anomalous and acted (even if it only sent a reminder);
  2. the leader is unsure whether it is anomalous.
- Minimum content of a report: enough for the user to **review and decide the next step** (what
  happened, who is involved, where the evidence is, what was done, what the user must decide). **Format
  is free** — follow the project and the user's habits.
- The leader may pause a single session; pausing the whole team needs user confirmation.
- When things are normal, do not intervene: "many messages" alone is not a reason to act.

---

## 6. Handoff

### 6.1 Trigger

- The worker or leader decides (considering context usage, task stage, output stability); **no hard
  thresholds**.
- A handoff must happen at a persistable checkpoint, never in the middle of a tool call.

### 6.2 Handoff document fields `[editable]`

```markdown
- Role and goal
- Done (verifiable items)
- Artifact paths (files / branches / links)
- Key decisions and reasons
- Known traps and unverified items
- Next step (the first executable action)
- Unfinished tasks (with dependencies)
- Sub-agent state (say clearly what is still running)
```

### 6.3 Flow (worker; the leader owns it)

1. the worker writes the handoff document;
2. sends `handoff-request` to the leader (old id → placeholder new id, role, document path);
3. the leader approves (**no user application needed**);
4. the leader updates the roster, creates the successor, replies `handoff-approval`;
5. the successor starts and reads the handoff;
6. the old session is archived;
7. the leader reports to the user: which role changed sessions, why, and how it went.

### 6.4 Flow (leader; the user owns it)

A leader handoff **belongs to the user**: the leader only prepares material and reports; it does not
start its own successor and does not transfer ownership itself.

1. the leader writes the handoff document + succession plan (suggested new leader session, roster
   handover, unfinished tasks, unread messages);
2. reports to the user (this is a notice plus recommendation, not an application, and it is not
   self-executed);
3. the user decides; the user starts the successor, or explicitly instructs the leader to act;
4. the roster `generation + 1`; ownership moves to the new leader;
5. the old leader retires.

### 6.5 Failure handling and degradation

If any step fails: keep the original session, return to the pre-handoff state, and tell the initiator
why; never silently drop the handoff document.

**Degradation when the leader is unavailable:**

- Pending worker handoff requests **stay pending**, enter the team pending list, and the user is
  notified.
- The user **approves manually**; once approved the system creates the session and updates the roster.
- No auto-approval, no silent drop, no letting them expire.
- Workers still never contact the user directly: the user sees a system pending item, not a worker
  message.
- After the leader recovers it records the decision (who approved, why, result).

#### Form of the pending item (manual approval)

- **Carrier**: the "team pending" list in the plugin panel, not a chat message. The host service
  persists it, so it survives refresh and restart. (Panel spec: [panels.md](./panels.md))
- **Signal**: the panel badge; opening it shows the requesting session, role, reason, handoff document
  and suggested action. (Desktop notifications were dropped.)
- **Actions**: approve / reject / ask for more info; on approval the system creates the session and
  updates the roster; the result is logged and recorded in the team record.
- **DSH's built-in approval is deliberately not used** for this, because its semantics and limits do not
  match:
  - `approval.request` must be called **inside an open turn** (idle sessions reject it outright);
  - it is bound to a `toolName` — it means "approve a tool call", not "decide a team matter";
  - it is subject to the session's approval policy: if the user sets "never ask", the request is
    auto-rejected and the handoff gets stuck;
  - it only offers `allowed-once`; there is no "remember for this task" semantics.
- **Optional extra**: while the leader is online it may send a confirmation card via `ask_user_question`
  as an immediate nudge; that neither replaces the pending queue nor covers the leader-down case.

---

## 7. Sub-agents `[editable]`

- Every session may spawn sub-agents; default depth 1.
- A sub-agent only does the assigned sub-task and returns the result to the parent.
- When the parent hands off, sub-agent state goes into the handoff document; anything still running is
  first interrupted or explicitly handed over.
- Sub-agents do not run their own multicast and never contact the user.

---

## 8. Human involvement

- Ask only about things a human must decide: authority, risk, trade-offs, acceptance.
- Do not ask: where the code is, how to implement something, ordinary preferences.
- Question format is free; never ask the same question twice.
- Until the user answers, do not push the step that was asked about.

---

## 9. Change and versioning

- Who may change it: the leader proposes and the user confirms; the user may edit directly.
- Every substantive change bumps `version` and is recorded.
- Scope: **new sessions** follow the new charter; already-open sessions keep the version they started
  with unless the user asks them to reload.
- The charter itself is audited: what changed, by whom, when.

```markdown
Change log:
- v1 (2026-11-20): initial version, completed from the default draft
```

---

## 10. Confirmation checklist

**Leader self-check (before submitting to the user):**

- [ ] Every rule is executable by a worker (not a slogan)
- [ ] A new worker reading only the charter knows what to do and what not to do
- [ ] A new leader can take over by reading the charter plus the roster
- [ ] No hard-coded thresholds, quotas or templates
- [ ] The handoff fields cover the minimum needed to "take over and work"

**User confirmation (whether to activate the team):**

- [ ] Goals and boundaries agreed
- [ ] Role split agreed
- [ ] Messaging rules agreed (who may contact whom)
- [ ] Risk-reporting requirements agreed
- [ ] Handoff flow agreed
- [ ] Leader identity rules agreed (first session is leader; the user may change it)
- [ ] Dispatch authority level agreed (`ask` / `autonomous`)
- [ ] Task tiering and effort mapping agreed (simple→off / moderate→high / complex→max)
- [ ] Handoff ownership agreed (worker handoffs → leader, leader handoffs → user, leader down → user approves)

To confirm: set `status` to `confirmed` and fill in `confirmed_by` and `confirmed_at`.

---

## 11. Behaviour when unconfirmed or unauthorised

- `status: draft`: the leader may draft, discuss and write the charter; it **must not create workers,
  dispatch work or multicast**.
- `status: confirmed` + `spawn_authority: ask`: dispatch is allowed, but **every new session** needs user
  approval; **handoff replacement does not**.
- `status: confirmed` + `spawn_authority: autonomous`: the leader may dispatch itself, logging each
  creation and explaining it in the next risk report.
- Worker handoff: the leader's approval takes effect; the leader reports afterwards.
- Leader handoff: owned by the user; until the user starts a successor the current leader keeps working
  and must not hand off on its own.
- Charter damaged or missing: the team stops dispatching; the leader reports to the user and rebuilds it.
- Identity conflict (two sessions both claim to be leader): `leader_session` + `generation` decide; the
  other is demoted to worker. If it cannot be decided, escalate to the user.
