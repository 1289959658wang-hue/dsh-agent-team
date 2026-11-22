<a id="zh"></a>

# Agent Team 前端面板草案（v0.2）

> 中文 ｜ [English](#en)
>
> 状态：讨论稿（2026-11-20），第一版已实装（2026-11-21，见 §9）
> 范围：两个用户面板——「团队待办」与「群组消息」。只写界面契约与数据来源，不含实现细节。
> 原则：面板是**观察与控制**工具，不是第三个聊天窗口；消息只读，待办才可操作。

---

## 0. 两个面板，两种职责

| 面板 | 用户能做什么 | 数据性质 |
|---|---|---|
| **团队待办** | 批准 / 拒绝 / 要求补充挂起的交接与派发申请 | 可操作，会改变团队状态 |
| **群组消息** | 查看会话之间的全部通信、筛选、搜索、看投递状态 | 只读审计，不改变任何会话 |

两者共享同一个入口：侧边栏底部的 **Agent Team** 按钮，打开一个覆盖层，顶部两个标签页。

```
┌ Agent Team ──────────────────────────────── [×] ┐
│  [ 待办 3 ]   [ 消息 ]                            │
├──────────────────────────────────────────────────┤
│                                                  │
│   （面板内容）                                    │
│                                                  │
└──────────────────────────────────────────────────┘
```

- 入口用 `sidebar.footer.action`；面板用 `shell.overlay` 承载；若宿主提供面板列表入口，优先用正式的 panel slot（实现前用 Slot 检查确认）。
- 入口按钮在有待办时显示角标数字；消息页不显示角标，只显示"有新活动"的小圆点。
- 面板可随时手动打开，不打断任何会话；关闭不改变状态。

---

## 1. 团队待办面板

### 1.1 列表

每行字段：

| 字段 | 来源 | 说明 |
|---|---|---|
| 岗位 | 岗位表 | 当前岗位名 |
| 旧会话 → 新会话 | `handoff-request` | 新会话可能只是占位 id |
| 原因 | 申请正文 | 模型写的，可能很短，需要时可展开 |
| 交接单 | 文件/存储 | 点击在新标签打开只读预览 |
| 申请时间 / 等待时长 | 服务端 | 超过阈值只做**视觉强调**，不自动处置 |
| 状态 | 服务端 | 待批 / 已批 / 已拒 / 需补充 / 已过期 |

### 1.2 操作

| 操作 | 结果 | 回执 |
|---|---|---|
| 批准 | 系统建新会话、更新岗位表、启动新会话 | 申请方收到 `handoff-approval`；写日志 |
| 拒绝 | 不建会话，旧会话继续工作 | 申请方收到拒绝原因；写日志 |
| 要求补充 | 申请**保持挂起**，通知申请方补交接单；**解除它的上闩**好让它能补 | 申请方收到 `question`（写清缺什么）；补齐后重新提交**更新同一张单子**（同 id、`revisions+1`、重新上闩），不新建 |

> 「要求补充」2026-11-21 已实装：leader 用 `team_handoff_more_info`，面板走 `POST /agent-team/more-info`（`note` 必填）。卡片上会显示「已要求补充（HH:MM）：…」。

- 操作前二次确认（批准除外，批准是主路径）。
- **批准后不自动切换或打开新会话**；新会话建好后由用户在侧边栏自行进入。
- 同一申请只能被处理一次；并发点击以后到者失败并刷新列表。
- 批准后列表行进入"已完成"折叠区，保留 24 小时可回溯。

### 1.3 通知与空态

- 有待办时：角标数字始终显示；**桌面通知默认关闭**（该功能已放弃）。
- 空态：`暂无待批申请`，附一句"leader 在线时通常不需要你代批"。
- 错误态：`读取失败` + 重试；不隐藏已缓存的列表。

### 1.4 降级

- leader 恢复后：待办列表仍保留，leader 可查看并补记决定。
- 面板不可用（前端未加载）：申请仍挂起，leader 恢复后处理；不自动通过。

### 1.5 leader 卡片与移交（2026-11-21 实装）

leader 归档/宕机后团队会挂在旧会话上：交接还能由用户代批，但没人派发、也没人接 worker 的交接申请。待办页顶部因此有一张「leader」卡片，提供「移交…」。

| 项 | 契约 |
|---|---|
| 数据来源 | `GET /agent-team/state` 的 `leaderStatus.{id,available,reason}` 与 `leaderHistory[]` |
| 候选 | 岗位表里 `status` 为 active 的会话，点一下填进输入框；也允许手填会话 id |
| 提交 | `POST /agent-team/admin/promote-leader`，**必须带 `confirm: "PROMOTE"`**（少它返回 400） |
| 原子性 | 卸任与任命在同一次写盘内完成：旧 leader 记 `status: replaced` + `replacedBy`，`state.leader` 同时换人 —— **不存在两个 leader 并存的中间态** |
| 留痕 | 每次移交写 `store.leaderHistory`（`at/by/from/to/reason`）；对活着的成员发一条 `roster-update`（`inject`，不唤醒） |
| 拒绝 | 已归档 → `目标会话已归档`；不存在 → `会话不存在`；本来就是它 → `changed:false`（幂等，不写盘） |
| 权限 | 只有面板/本机 HTTP 能动；**模型没有任何工具能调到它**（`claimLeader` 依旧拒绝自动接手） |

换错预设会有警告：目标是普通会话时它只有审批权、没有派发工具（那些工具只装配在 `agent-team` 作用域里）。

---

## 2. 群组消息面板

### 2.1 布局

三栏：筛选栏 / 消息列表 / 详情。

### 2.2 列表

- 默认倒序（最新在上），首批 100 条，向上加载更多。

**已实装（2026-11-21）**：`/state` 带 `totalMessages`，`/messages` 支持 `before` **id 游标**；列表底部「加载更早（还有 N 条）」按游标往前翻、按 id 去重。没用 offset —— 消息只追加，offset 在"翻页期间来了新消息"时会漏条或重条。虚拟滚动还没做（一页最多 100 条，够用）。

- **默认展示全部消息**，不提供"只看发给我的"视角（用户不是收件人；需要收窄时用筛选）。
- 每行：时间、`from → to_expr`、类型、一行摘要、状态点（投递失败/未投递为标记）。
- 点击行在右侧显示详情，不跳页。
- 多选收件人时显示 `→ all` 或 `→ N 个会话`，展开看 id。

### 2.3 筛选与搜索

| 筛选 | 取值 |
|---|---|
| 会话 | 任一 `sessionId`（作为发送者或收件人） |
| 类型 | task / question / answer / report / notice / handoff-* / roster-update |
| 时间 | 最近 1 小时 / 今天 / 自定义范围 |
| 收件人 | `all` / 指定会话 / 岗位组 |
| 状态 | 有投递失败 / 有未投递 / 已投递 / 已旁听 |
| 搜索 | 摘要与正文全文（正文按需读取） |

- 筛选组合可叠加；清空按钮复位。
- 搜索结果显示命中片段，点击跳到该消息详情。

**已实装（2026-11-21）**：类型 / 收件人 / 时间（最近 1 小时、最近 24 小时、今天）/ 投递状态四个下拉 + 摘要·id·会话搜索；任一筛选生效时出现「清空」，右侧始终显示 `命中 / 总数`。时间窗只按消息时间戳算；状态是逐收件人的，一条消息只要有一个收件人命中就算命中。

**下拉是自己画的，不是原生 `<select>`**：原生 select 的**弹出列表由系统绘制**，`color-scheme` 管不到它的白底 —— 深色模式下面板里会突兀地出现一块白。现在的控件是「按钮 + 绝对定位列表」：按钮沿用面板的边框/文字色，列表底色用 `color-mix(...)` 做出抬高感，选中项用 `--dsw-alias-interactive-bg-active`，悬停用 `--dsw-alias-interactive-bg-hover`。点外面或按 Esc 收起。

### 2.4 详情

| 区块 | 内容 |
|---|---|
| 信封 | id、时间、发送方、收件人表达式、解析后的收件人、类型、优先级、摘要 |
| 投递状态 | 每个收件人：未投递 / 已投递 / 已旁听 / **上闩暂扣** / 失败 |
| 正文 | 默认折叠，点击加载；超长时提供"在新标签打开"；代码块做语法高亮 |
| 关联 | 所属岗位、工单/任务、交接单（如有） |
| 操作 | 复制 id |

- 面板**不提供**编辑、删除、撤回、代发消息，也**不提供导出**。用户要说话，走 leader 会话。

### 2.5 实时与性能

- 订阅 Host 事件流（SSE）：新消息插入列表顶部，详情不自动跳转。
- 用户向上滚动时**暂停自动滚动**，显示"有 N 条新消息"提示条，点击回顶。
- 前端只持有列表摘要；正文不预载，按需拉取。
- 只读面板不改变任何会话的已读游标。

**已实装（2026-11-21）**：`GET /agent-team/events`（`text/event-stream`）只推「store 变了」这一个事实（`event: team`，带递增 `seq`），不推内容 —— 面板收到就重拉 `/state`，所以推送和审计读的是同一份投影。连接建立时先发 `event: ready`；25 秒一次注释帧做心跳；`save()` 侧按 120ms 合并。

SSE 连上就**停掉轮询**；断流（`onerror`）立刻退回 3 秒轮询，浏览器按 `retry: 3000` 自己重连，重连成功后再次停轮询。抽屉标题栏有一个小圆点显示当前是**实时**还是**轮询**——降级是看得见的。

### 2.6 空态与错误

- 空态：`团队还没有消息`（新团队）。
- 加载失败：保留已加载内容 + 顶部错误条 + 重试。
- 正文加载失败：详情显示错误与重试，不影响列表。

---

## 3. 数据模型

```yaml
message:
  id: m-000128
  seq: 128
  ts: 2026-11-20T19:22:03+08:00
  from: at-lead-1
  to: [at-w-01, at-w-02, at-w-03, at-w-04, at-w-05]
  to_expr: all
  kind: task
  priority: normal
  summary: 开始验证阶段，请各自检查产物
  body_ref: team/messages/20261120/m-000128.md
  body_bytes: 1840
  delivery:
    - { session: at-w-01, state: delivered, at: ... }
    - { session: at-w-04, state: pending, at: ... }
  links: { roster: true, ticket: null, handoff: null }
```

```yaml
pending_handoff:
  id: h-00007
  ts: ...
  from: at-w-02
  job: 后端实现
  from_session: at-w-02
  to_session: at-w-07        # 占位
  reason: 上下文接近上限
  handoff_ref: team/handoffs/20261120/at-w-02.md
  state: pending | approved | rejected | more-info | expired
  decided_by: user | leader
  decided_at: ...
```

---

## 4. 接口草案（实现为 `/agent-team/*`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/agent-team/state` | 面板主数据（快照 + leaderStatus + pending + rows） |
| GET | `/agent-team/events` | 事件流（只推"store 变了"） |
| GET | `/agent-team/workspaces` | 工作区下拉数据（多工作区） |
| GET | `/agent-team/messages?limit&before` | 消息列表（游标分页） |
| GET | `/agent-team/body?id=` | 单条正文（markdown） |
| POST | `/agent-team/approve` / `reject` / `more-info` | 待办操作 |
| POST | `/agent-team/admin/promote-leader` | 移交 leader（必带 `confirm: "PROMOTE"`） |

- 只接受 loopback 来源；只返回标量 JSON，不返回活体对象。
- 分页用 `before` 游标，不用 offset。

---

## 5. 权限与审计

- 面板只对本地用户开放（单机桌面场景）；不做多用户权限。
- 面板的所有操作写日志：谁、什么时候、对哪条申请、结果。
- 消息面板只读；不提供删除，满足"存在过就留痕"。
- 用户的面板浏览状态与会话已读游标**互不影响**。

---

## 6. 主题与无障碍

- 颜色只用 DSH 主题 token（`--dsw-alias-*`），不写死十六进制。
- 支持亮/暗主题；对比度满足正文可读。
- 状态不只靠颜色：未读/失败同时用文字或图标。

---

## 7. 验收判据

| 项 | 判据 |
|---|---|
| 待办可见 | leader 不可用时，挂起申请在面板出现，角标数字正确 |
| 代批生效 | 批准后新会话建立、岗位表更新、旧会话按协议归档 |
| 不误批 | 同一申请并发点击只生效一次 |
| 消息可见 | 组播消息在列表可见，收件人列表与投递状态正确 |
| 正文按需 | 列表不预载正文；点击后才拉取 |
| 筛选搜索 | 按类型/收件人/时间/状态筛选正确 |
| 实时 | 新消息无需刷新出现；滚动时不被打断 |
| 只读 | 面板无法修改或删除消息，无法代发 |
| 持久 | 刷新/重启后列表与待办仍在 |

---

## 8. 已定决策

| # | 问题 | 决定 |
|---|---|---|
| 1 | 消息面板是否提供"只看发给我的"视角 | 不提供；默认全部，用筛选收窄 |
| 2 | 是否导出整段团队记录 | 不做 |
| 3 | 待办批准后是否自动打开新会话 | 不自动；用户自行进入 |
| 4 | 桌面通知默认开关 | **已放弃**（用户 2026-11-21 决定） |
| 5 | 正文代码块语法高亮 | 做 |

## 9. 修订记录

| 日期 | 变更 |
|---|---|
| 2026-11-20 | 初稿：两个面板的布局、数据模型、接口、验收判据 |
| 2026-11-20 | 按用户决定收口五个未决项 |
| 2026-11-21 | **已实现第一版**：`sidebar.footer.action` 入口 + `shell.overlay` 抽屉，两个标签页；代批主路径实测通过。接口前缀实现为 `/agent-team/*` |
| 2026-11-21 | 待办页加「leader」卡片 + `/admin/promote-leader` 移交（§1.5） |
| 2026-11-21 | 消息页四个筛选 + 清空按钮已实装；SSE 已实装，轮询退为兜底（§2.3、§2.5） |
| 2026-11-21 | 下拉改为自绘控件（原生 `<select>` 的弹层在深色主题下不可控） |
| 2026-11-22 | 抽屉头部加工作区下拉（多工作区）；徽章只算当前工作区 |

---

<a id="en"></a>

# Agent Team panel specification (v0.2)

> [中文](#zh) ｜ English
>
> Status: draft (2026-11-20); first version implemented (2026-11-21, see §9).
> Scope: the two user-facing panels — **Team Pending** and **Group Messages**. This document
> specifies the UI contract and data sources, not the implementation.
> Principle: the panel is an **observation and control** tool, not a third chat window. Messages are
> read-only; only pending items are actionable.

---

## 0. Two panels, two responsibilities

| Panel | What the user can do | Nature of the data |
|---|---|---|
| **Team Pending** | Approve / reject / ask for more info on pending handoff and dispatch requests | Actionable; changes team state |
| **Group Messages** | Read all traffic between sessions, filter, search, inspect delivery state | Read-only audit; changes nothing |

Both share one entry point: the **Agent Team** button at the bottom of the sidebar, which opens an
overlay with two tabs at the top.

```
┌ Agent Team ──────────────────────────────── [×] ┐
│  [ Pending 3 ]   [ Messages ]                    │
├──────────────────────────────────────────────────┤
│                (panel content)                   │
└──────────────────────────────────────────────────┘
```

- The entry uses `sidebar.footer.action`; the panel is hosted in `shell.overlay`. If the host offers a
  panel-list entry, prefer the formal panel slot (verify with a slot check before implementing).
- The entry button shows a numeric badge while pending items exist; the messages tab shows no badge.
- The panel can be opened at any time without interrupting a session; closing it changes nothing.

---

## 1. Team pending panel

### 1.1 List

Per-row fields:

| Field | Source | Notes |
|---|---|---|
| Role | roster | Current role name |
| Old session → new session | `handoff-request` | The new session may be a placeholder id |
| Reason | request body | Written by the model, may be terse; expandable |
| Handoff document | file/store | Click to open a read-only preview |
| Requested at / waiting time | server | Over the threshold is only **visually emphasised**; nothing is auto-decided |
| State | server | pending / approved / rejected / more-info / expired |

### 1.2 Actions

| Action | Result | Receipt |
|---|---|---|
| Approve | Creates the successor session, updates the roster, starts it | The requester gets `handoff-approval`; logged |
| Reject | No session created; the old session keeps working | The requester gets the reason; logged |
| Ask for more info | The request **stays pending** and the requester is told what is missing; its **latch is released** so it can comply | The requester gets a `question`; when it resubmits it **updates the same document** (same id, `revisions+1`, latched again) |

> "Ask for more info" shipped on 2026-11-21: the leader calls `team_handoff_more_info`, the panel uses
> `POST /agent-team/more-info` (`note` required). The card shows "more info requested (HH:MM): …".

- Confirm before acting (approval excepted — it is the main path).
- **Approving does not switch to or open the new session**; the user opens it from the sidebar.
- A request can be decided once; concurrent clicks make the later one fail and refresh the list.
- Decided rows move into a collapsed "done" area for 24 hours.

### 1.3 Notifications and empty state

- With pending items the badge is always shown; **desktop notifications are off by default** (feature dropped).
- Empty state: `No pending requests`, plus "when the leader is online it usually approves for you".
- Error state: `Failed to load` + retry; the cached list stays visible.

### 1.4 Degradation

- After the leader recovers, the pending list remains; the leader can review and record decisions.
- If the panel is unavailable (front end not loaded), requests stay pending; nothing auto-approves.

### 1.5 Leader card and transfer (implemented 2026-11-21)

When the leader is archived or dies, the team is stuck on a dead session: the user can still approve
handoffs, but nobody dispatches and nobody accepts worker handoffs. The top of the pending tab
therefore carries a **leader card** with a **Transfer…** action.

| Item | Contract |
|---|---|
| Data | `leaderStatus.{id,available,reason}` and `leaderHistory[]` from `GET /agent-team/state` |
| Candidates | Active sessions from the roster (click to fill in); a raw session id is also accepted |
| Submit | `POST /agent-team/admin/promote-leader`, **must include `confirm: "PROMOTE"`** (400 otherwise) |
| Atomicity | Demotion and appointment happen in one write: the old leader gets `status: replaced` + `replacedBy`, `state.leader` switches at the same time — **there is no intermediate state with two leaders** |
| Audit | Every transfer writes `store.leaderHistory` (`at/by/from/to/reason`) and sends a `roster-update` (`inject`, no wake) to live members |
| Rejections | Already archived → `target session is archived`; unknown → `session does not exist`; already the leader → `changed:false` (idempotent, no write) |
| Authority | Only the panel / loopback HTTP can do it; **no tool exposes it to the model** (`claimLeader` still refuses to take over automatically) |

Picking a session with the wrong preset warns you: a standard session has approval rights but no
dispatch tools (those are only assembled in the `agent-team` scope).

---

## 2. Group messages panel

### 2.1 Layout

Three columns: filters / message list / details.

### 2.2 List

- Newest first, first page of 100, "load earlier" pages backwards.

**Implemented (2026-11-21)**: `/state` carries `totalMessages`, `/messages` accepts a `before` **id
cursor**; the list pages back by cursor and de-duplicates by id. No offset — messages are
append-only, so an offset would skip or repeat rows when new messages arrive mid-paging. Virtual
scrolling is not implemented (100 rows per page is enough).

- **All messages are shown by default**; there is no "only what was sent to me" view (the user is not
  a recipient — narrow with filters instead).
- Each row: time, `from → to_expr`, kind, one-line summary, state marker (failed / not delivered).
- Clicking a row shows details on the right without navigating away.
- Multi-recipient rows show `→ all` or `→ N sessions`, expandable to ids.

### 2.3 Filters and search

| Filter | Values |
|---|---|
| Session | Any `sessionId` (as sender or recipient) |
| Kind | task / question / answer / report / notice / handoff-* / roster-update |
| Time | Last hour / today / custom range |
| Recipient | `all` / a specific session / a role group |
| State | Has failures / not delivered / delivered / injected |
| Search | Summary and body text (bodies are loaded on demand) |

- Filters combine; a Clear button resets them.
- Search results show the matching snippet; clicking jumps to that message's details.

**Implemented (2026-11-21)**: four dropdowns (kind / recipient / time / delivery state) plus search
over summary, id and session; a Clear button appears when anything is active, and `matched / total` is
always shown. Time windows use message timestamps only; state is per recipient, so a message matches if
**any** recipient matches.

**The dropdowns are custom-drawn, not native `<select>`**: a native select's **popup is drawn by the
system**, so `color-scheme` cannot style its white background — in dark mode it shows up as a glaring
white block. The current control is a "button + absolutely positioned list": the button reuses the
panel's border and text colour, the list background uses `color-mix(...)` to lift it (lighter in dark
themes, darker in light ones), the selected row uses `--dsw-alias-interactive-bg-active`, hover uses
`--dsw-alias-interactive-bg-hover`. Click outside or press Esc to close.

### 2.4 Details

| Block | Contents |
|---|---|
| Envelope | id, time, sender, recipient expression, resolved recipients, kind, priority, summary |
| Delivery | Per recipient: pending / delivered / injected / **held (latched)** / failed |
| Body | Collapsed by default, loaded on click; long bodies can open in a new tab; code blocks are highlighted |
| Links | Owning role, ticket/task, handoff document (if any) |
| Actions | Copy id |

- The panel **does not** edit, delete, retract or send messages on your behalf, and **does not export**.
  To speak, use the leader session.

### 2.5 Live updates and performance

- Subscribes to the host event stream (SSE): new messages are inserted at the top; details do not jump.
- While the user scrolls up, **auto-scroll pauses** and a "N new messages" bar appears; click to return to top.
- The front end only holds list summaries; bodies are fetched on demand.
- The read-only panel never touches any session's read cursor.

**Implemented (2026-11-21)**: `GET /agent-team/events` (`text/event-stream`) only announces "the store
changed" (`event: team` with an increasing `seq`) and never content — the panel re-fetches `/state`, so
pushes and audits read the same projection. `event: ready` is sent on connect; a comment frame every 25
seconds is the heartbeat; `save()` coalesces writes over 120 ms.

Once SSE connects, **polling stops**; on `onerror` it falls back to 3-second polling and the browser
reconnects per `retry: 3000`, stopping polling again on success. A small dot in the drawer header shows
whether it is **live** or **polling** — degradation is visible, not silent.

### 2.6 Empty and error states

- Empty: `This team has no messages yet`.
- Load failure: keep what is loaded + an error bar + retry.
- Body failure: the details pane shows the error and a retry; the list is unaffected.

---

## 3. Data model

```yaml
message:
  id: m-000128
  seq: 128
  ts: 2026-11-20T19:22:03+08:00
  from: at-lead-1
  to: [at-w-01, at-w-02, at-w-03, at-w-04, at-w-05]
  to_expr: all
  kind: task
  priority: normal
  summary: start the verification phase, each of you check your artifacts
  body_ref: team/messages/20261120/m-000128.md
  body_bytes: 1840
  delivery:
    - { session: at-w-01, state: delivered, at: ... }
    - { session: at-w-04, state: pending, at: ... }
  links: { roster: true, ticket: null, handoff: null }
```

```yaml
pending_handoff:
  id: h-00007
  ts: ...
  from: at-w-02
  job: backend
  from_session: at-w-02
  to_session: at-w-07        # placeholder
  reason: context nearly full
  handoff_ref: team/handoffs/20261120/at-w-02.md
  state: pending | approved | rejected | more-info | expired
  decided_by: user | leader
  decided_at: ...
```

---

## 4. API sketch (implemented as `/agent-team/*`)

| Method | Path | Notes |
|---|---|---|
| GET | `/agent-team/state` | Main panel payload (snapshot + leaderStatus + pending + rows) |
| GET | `/agent-team/events` | Event stream ("the store changed" only) |
| GET | `/agent-team/workspaces` | Workspace dropdown data (multi-workspace) |
| GET | `/agent-team/messages?limit&before` | Message list (cursor pagination) |
| GET | `/agent-team/body?id=` | One message body (markdown) |
| POST | `/agent-team/approve` / `reject` / `more-info` | Pending-item actions |
| POST | `/agent-team/admin/promote-leader` | Transfer leadership (requires `confirm: "PROMOTE"`) |

- Loopback callers only; scalar JSON only, never live objects.
- Pagination is a `before` cursor, never an offset.

---

## 5. Authority and audit

- The panel is local-user only (single-machine desktop); no multi-user permissions.
- Every panel action is logged: who, when, which request, result.
- The messages panel is read-only; no deletion, so "if it existed, it left a trace".
- The user's browsing state and any session's read cursor **never affect each other**.

---

## 6. Theming and accessibility

- Colours come from DSH theme tokens (`--dsw-alias-*`), never hard-coded hex.
- Light and dark themes are supported; contrast keeps body text readable.
- State is not conveyed by colour alone: failed/pending also use text or icons.

---

## 7. Acceptance criteria

| Item | Criterion |
|---|---|
| Pending visible | When the leader is unavailable, pending requests appear with the right badge count |
| Approval works | Approving creates the session, updates the roster, archives the old session per protocol |
| No double approval | Concurrent clicks on one request take effect only once |
| Messages visible | Multicast messages appear with correct recipients and delivery states |
| Body on demand | The list does not preload bodies; clicking fetches them |
| Filters and search | Filtering by kind / recipient / time / state is correct |
| Live | New messages appear without refresh; scrolling is not interrupted |
| Read-only | The panel cannot edit, delete or send messages |
| Persistent | The list and pending items survive refresh and restart |

---

## 8. Settled decisions

| # | Question | Decision |
|---|---|---|
| 1 | A "only what was sent to me" view | No; show everything and narrow with filters |
| 2 | Exporting the whole team record | No |
| 3 | Auto-open the new session after approval | No; the user opens it |
| 4 | Default for desktop notifications | **Dropped** (user decision, 2026-11-21) |
| 5 | Syntax highlighting for message bodies | Yes |

## 9. Revision history

| Date | Change |
|---|---|
| 2026-11-20 | First draft: layout, data model, API and acceptance criteria for both panels |
| 2026-11-20 | Settled five open questions per the user's decisions |
| 2026-11-21 | **First version implemented**: `sidebar.footer.action` entry + `shell.overlay` drawer, two tabs; the approval path verified on the desktop. API prefix implemented as `/agent-team/*` |
| 2026-11-21 | Leader card added to the pending tab + `/admin/promote-leader` transfer (§1.5) |
| 2026-11-21 | Four message filters + Clear implemented; SSE implemented, polling demoted to fallback (§2.3, §2.5) |
| 2026-11-21 | Dropdowns replaced with a custom control (native `<select>` popups are unstylable in dark themes) |
| 2026-11-22 | Workspace dropdown added to the drawer header (multi-workspace); badges count the current workspace only |
