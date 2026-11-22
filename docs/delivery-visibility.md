# 会话状态能力 + 投递可见性（1.10.0）

> 规格冻结：2026-11-22。用户提议：**给会话增加「访问其他会话状态、以及自身状态」的能力，用状态综合判断动作。**
> 本文件同时是实现规格与验收清单。

---

## 0. 一句话

把「对方现在在不在跑、前面还堵着几条、我自己还欠着几条、我该不该现在发」变成**模型查得到的事实**，而不是靠猜。

## 1. 问题（用户实测）

- 各会话不知道互相之间的状态：发出去的消息是**排队阻塞**，还是**能直接处理**？
- 会话也不知道自己的状态：有多少消息阻塞？有没有消息排队？
- 于是：发件人看到 `delivered` 以为对方马上处理 → 继续连发；收件人看不到积压 → 继续回。队列越排越长，恶性循环。

## 2. 底层事实（0.2.2-rc.5 源码，已核对）

`@deepseek-ai/dsh-agent-loop`：

| 方法 | 落点 | 唤醒 | 语义 |
|---|---|---|---|
| `followup(msg)` | inbox `next-turn` 队尾 | 是 | 「下一轮」；对方在跑时**再排一轮** |
| `steer(msg)` | inbox `next-step` 队尾 | 是 | 「当前轮的下一步」；对方在跑时插进当前轮 |
| `inject(msg)` | inbox `next-step` 队尾 | **否** | 旁听；对方空闲时**不会自己醒**，一直停在 inbox |

`Agent` 公共接口已暴露 `inbox`（`nextTurn` / `nextStep`）与 `status`（`idle` / `running`）：
`dsh-api-session-controller/lib/typert.host.js` 的 `interface Agent` / `interface Inbox`。
**排队深度本来就是可查的**，插件只是从来没查、也没回给模型。

当前实现的三处缺口（`agent-team/index.js`）：

1. `deliver()` 只写 `slot.state='delivered'|'injected'`，不记目标当时 idle/running，也不记队列；
2. `team_post` / `team_report` 把 delivery 原样回给模型，无法区分「已唤醒」和「排在第 3 轮后面」；
3. 没有任何工具能查自己/别人的积压；`inject` 打到空闲会话会无限期停住，这个事实也看不到。

## 3. 原则（与既有决定一致，不破例）

- **只给事实，不做配额、不拒发、不自动熔断**（`reusable-solutions.md` §6.7：判断归 leader）。
- 先存储、后投递不变；失败只标记该收件人，不回滚。
- **读状态不唤醒任何会话**：只读 `ctx.agents.get(sessionId)`（live agent）；查不到就报 `not-live`。绝不为了看一眼而 `resolveAgent` 把归档/冷会话拉起来。
- 既有工具签名不变；新能力用新工具 `team_status`；回执只增字段（`state` / `mode` / `delivery[].session` 兼容）。

---

## 4. 新工具：`team_status`

两种角色都注册（与 `team_directory` 同级）。默认查自己，`session` 参数查队友。

### 4.1 参数

```
team_status({ session? })     // 省略 = 自己；leader / worker 都可查在职队友
```

### 4.2 返回（只列有值的字段）

```json
{
  "session": "at-w-1",
  "self": false,
  "role": "worker",
  "job": "w-1",
  "title": "接口实现",
  "archived": false,
  "live": true,
  "status": "running",            // running | idle | not-live | archived
  "latched": false,               // 交接上闩：true 时消息暂扣，别发任务
  "inbox": {
    "turn": 2, "step": 1, "total": 3,
    "teamTurn": 2, "teamStep": 1,
    "humanTurn": 0, "humanStep": 0,
    "oldestWaitMs": 95000,
    "messages": [
      { "messageId": "m-000865", "from": "leader", "kind": "task",
        "mode": "queue", "target": "next-turn", "waitMs": 95000, "summary": "…" }
    ],
    "truncated": false
  },
  "delivery": { "pending": 0, "held": 0, "failed": 0 },   // store 里发给这个会话、尚未落地的条数
  "activity": { "sent": 12, "received": 9, "lastSentAt": "…", "lastReceivedAt": "…" },
  "context": { "available": true, "used": 48000, "window": 1048576, "percent": 5, "band": "keep-working" },
  "hint": "…"
}
```

规则：

- `messages` 最多 20 条（先 `next-turn` 后 `next-step`，各自保持原顺序），超出 `truncated: true`；`summary` 按 `messageId` 从 store 反查，归档/找不到给 `null`，**不读正文**。
- 非团队来源（人类消息等）只计数（`humanTurn/humanStep`），不列进 `messages`。
- `delivery` 从 store 的 slot 统计：`pending`（还没投出去）、`held`（上闩暂扣）、`failed`（**历史累计**：投递失败过、且从未补投成功的条数 —— slot 不会自动清理，所以它不代表"现在还有在途消息"）。
- `context`：自己 → 总是给；leader 查**已挂载**队友 → 给；其余（worker 查别人、归档、已替换、未挂载）→ `null`（只有 leader 能看别人的上下文用量，沿用 `team_context` 的权限；未挂载不给，是因为算用量要读会话日志，而"读状态不碰日志"是更硬的承诺）。
- 归档会话：`archived: true, live: false, status: "archived"`，队列全 0，不拉起 agent。
- **被交接替换**的会话（`status: 'replaced'`，新 leader 顶替旧 leader 后留下的痕迹）：`archived: false`、`replaced: true`、`status: "replaced"`，队列全 0、`context: null`，hint 指向同岗位的接任者。它和归档是**两种不同的事**，不要合并报。
- 未挂载的在职会话：`live: false, status: "not-live"`，队列全 0，hint 说明「没有在途消息」。
- 查一个不在本团队的会话：抛错（复用 `roster` 口径，leader / worker 一致）。**自己不算团队外**：`team_status()` 自查永远不抛错。

### 4.3 `hint`（把状态翻译成动作）

主提示按优先级从高到低，取第一条命中的：

1. `archived` → 「该会话已归档：不要再发任务；需要人就在 `team_directory` 里找接任者。」
2. `replaced` → 「该会话已被交接替换：不要再发任务；接任者在 `team_directory` 里同岗位的新会话。」
3. `latched` → 「对方正在交接（上闩）：消息会被暂扣；等交接完成再发。」
4. `status='not-live'` → 「未运行，没有在途消息；发消息会把它唤醒。」
5. `自己 && inbox.total > 0` → 「你有 N 条未处理（最久 X 秒，来自 A/B）。先按顺序处理，处理完再发新消息。」
6. `!自己 && inbox.total > 0 && status='idle'` → 「对方空闲，但 inbox 里有 N 条不唤醒的消息（最久 X 秒）：它们会停在队列里，直到有人唤醒它。要它现在处理就重发 priority: "urgent"，或换 task/report 这类 kind。」
7. `inbox.teamTurn > 0 && status='running'` → 「对方正在跑，前面还有 N 条排队（最久 X 秒）。现在再发只会继续排队，先等回执。」
8. `!自己 && status='running' && inbox.total === 0` → 「对方正在跑但队列空：现在发会排到它下一轮，不是立刻处理。」
9. `inbox.total === 0 && status='idle'` → 「空闲且队列空：现在发能立刻处理。」
10. 其余 → 空串。

> 第 6、8 档是 2026-11-22 真机验收补的"空串空洞"：
> inject 停在 **next-step**（`teamTurn === 0`）且对方 idle 时，5/7/9 全不命中，hint 是空串 ——
> 偏偏"不唤醒就会一直停着"最该说出来；而对方 running 但队列空时 hint 也是空串，
> 但那不等于"立刻处理"，而是排到下一轮。补上后这三档正好覆盖"发出去会怎样"的三种基本态：
> **立刻处理（9）/ 排队（7、8）/ 停住不动（6）**。

**投递失败不参与上面的排序，只做后缀/兜底。** 原因：`failed` 是历史累计、slot 永不自动清理，让它独占优先位的话，"一小时前失败过一条"会一直盖住"现在空闲且队列空"这个更要紧的事实。

- 有主提示 → 追加：「另有 N 条历史投递失败（这些消息从未送达，可在 `team_status` 里核对收件人）。」
- 没有主提示 → 它自己就是主提示：「有 N 条历史投递失败（…）。」
- `failed === 0` → 不追加。

「最久 X 秒」只在**算得出等待时长**时才写：`oldestWaitMs` 为 `null`（人类消息没有时间戳 / 队列里没有团队消息）时整段省略，**不会写成「0 秒」**；亚秒级等待至少说 1 秒。

### 4.4 权限

| 查看者 | 自己 | 在职队友 | 归档队友 | 已替换队友 | 团队外 |
|---|---|---|---|---|---|
| leader | ✅ | ✅（含 context） | ✅（只读，不拉起） | ✅（只读） | ❌ 抛错 |
| worker | ✅ | ✅（context 为 null） | ✅（只读） | ✅（只读） | ❌ 抛错 |

> 自己不算"团队外"：即使还没进岗位表（例如刚开、第一次调工具的 leader 会话），`team_status()` 自查也不抛错。

---

## 5. 发件人回执：`team_post` / `team_report` 的 delivery

### 5.1 判定（纯函数）

```js
export function deliveryVerdict({ mode, status, latched = false, reentrant = false, failed = false })
```

| 条件 | `outcome` | 含义 |
|---|---|---|
| `latched` | `held` | 上闩暂扣，解闩补投 |
| `failed` | `failed` | 抛错，带 `error` |
| `reentrant` | `pending-delivery` | 投递循环忙，留 `pending`，稍后补投 |
| `queue` + `idle` | `woken-now` | 已唤醒，马上开新一轮 |
| `queue` + `running` | `queued-turn` | 排在它下一轮（前面 `ahead` 条） |
| `steer` + `running` | `steered-step` | 插到当前轮下一个 step |
| `steer` + `idle` | `woken-now` | 唤醒后第一步读到 |
| `inject` + `running` | `injected-step` | 当前轮下一个 step 读到 |
| `inject` + `idle` | `parked-no-wake` | **停在 inbox，直到有人唤醒它** |

### 5.2 队列快照（同步、只读）

```js
export function readQueue(agent) // {
//   status, turn, step, teamTurn, teamStep, humanTurn, humanStep, oldestWaitMs
// }
```

`ahead`：queue 取发送前 `turn`；steer/inject 取发送前 `step`。

`oldestWaitMs` 只对**带 `source.ts` 的团队消息**可算（人类消息没有时间戳）：算不出时给 `null`，hint 里就整段省略，不会写成「0 秒」。

### 5.3 store slot（旧字段保持）

```js
{ session, state, mode, at, error?, outcome, targetStatus, queueBefore, queueAfter, ahead }
```

**历史数据兼容**：1.10.0 之前写下的 slot 没有 `outcome`。这类 slot 在回执里按 `outcome: "unknown"` 投影、`hint` 为空串 —— 不删键、不抛错（DSH 的工具输出要求 lossless JSON，`undefined` 会让整次输出被判非法）。

### 5.4 工具返回

```json
{
  "id": "m-000867",
  "to": ["at-w-1"],
  "delivery": [{
    "session": "at-w-1",
    "state": "delivered",
    "mode": "queue",
    "outcome": "queued-turn",
    "targetStatus": "running",
    "ahead": 2,
    "queue": { "turn": 2, "step": 0, "teamTurn": 2, "teamStep": 0, "oldestWaitMs": 95000 },
    "hint": "对方正在跑，前面已有 2 条排队（最久 95 秒）；你这条排在它下一轮。先等回执，别连发。"
  }]
}
```

`hint` 由 Host 生成、工具透传。`team_post` / `team_report` 的 description 各加一句：
「返回里的 `outcome` 告诉你对方是立刻处理（woken-now）还是排队（queued-turn）还是根本不会醒（parked-no-wake）。」

---

## 6. `activity()` 增加 `queues`

`team_roster` 的 activity 里加同步字段（只列在职成员，不拉起归档）：

```js
queues: {
  "at-w-1": { status: "running", turn: 2, step: 1, teamTurn: 2, teamStep: 1, oldestWaitMs: 95000, latched: false },
  "at-w-2": { status: "not-live", turn: 0, step: 0, teamTurn: 0, teamStep: 0, oldestWaitMs: null, latched: false }
}
```

面板不用改；`activity()` 是同一份投影，面板下次刷新即可见（本版不做 UI）。

---

## 7. 实现落点

`agent-team/index.js`

1. `export deliveryVerdict(...)`、`export readQueue(agent)`（纯函数，容错：字段缺失按 0）。
2. `teamMessage()` 的 `source` 增加 `from`、`teamKind`、`ts`；`kind` 仍是 `'agent-team'`（上闩守卫判据不变）。
3. `deliver()`：发送前后各 `readQueue`；写 slot 的 `outcome/targetStatus/queueBefore/queueAfter/ahead`；`held`、`failed`、reentrant 分别处理。
4. `api.statusReport(sessionId, { viewer })`（异步，含 context 权限）+ `api.queueSnapshot(sessionId)`（同步，给 activity）。
5. `api.activity()` 增加 `queues`。
6. `inject` 列表加 `'agents'`（只读 `ctx.agents.get`）。
7. 投递回执的 `hint` 生成函数（纯函数，可单测）。

`agent-team/tools.js`

8. `team_post` / `team_report`：回执透传 + description 更新。
9. 新增 `team_status`（两种角色），参数与权限按 §4。
10. 不动 `team_context` / `team_directory` / 交接 / 上闩逻辑。

`agent-team/package.json` → `1.10.0`；`CHANGELOG.md` 加 1.10.0 节；`docs/GUIDE.md` 的工具表加 `team_status` 一行（只做点状编辑，不重写）。

---

## 8. 验收（`scripts/test-delivery-visibility.mjs`，exit 0）

用 `createTeamStore(tmpdir, { ctx, config })` + 假 Agent（`status`、`inbox.nextTurn/nextStep`、`followup/steer/inject` 按真实语义实现），断言：

1. idle + queue → `woken-now`，`ahead: 0`，发送后 `status: running`；
2. running + 已有 2 条 next-turn + queue → `queued-turn`，`ahead: 2`，目标 nextTurn 变 3；
3. running + steer → `steered-step`，落在 `nextStep`；
4. idle + inject → `parked-no-wake`，status 仍 idle，nextStep 有 1 条；
5. 上闩 → `held` / `error:"latched"`，`redeliverHeld` 后变 `delivered`；
6. `statusReport(self)`：`inbox.total`、`messages[].from/kind/waitMs`、`delivery` 计数正确；
7. `team_status` 工具：worker 查自己 200；worker 带 `session` 查队友 200 且 `context === null`；leader 查队友有 context；查团队外抛错；
8. `activity().queues` 只含在职成员；
9. 旧字段兼容：回执仍有 `session`/`state`/`mode`；
10. 查未挂载会话 → `available`/`not-live` 正确，且假 `resolveAgent` 调用次数为 0（证明读状态不拉起会话）。

**验证岗复核后补充的断言**（P2 修正，并进同一份脚本，编号接在后面）：

11. `formatWait(null)` / `undefined` / `NaN` → 空串；`deliveryHint` 的 `queue.oldestWaitMs === null` 时不出现「最久 …」（真机出现过「前面已有 0 条排队（最久 0 秒）」）；
12. 历史失败 + 目标空闲且队列空 → 主提示仍是「空闲且队列空：现在发能立刻处理。」，失败只作后缀；没有主提示时失败自己就是主提示；
13. `status: 'replaced'` 的会话 → `archived: false` / `replaced: true` / `status: "replaced"`，队列 0、`context: null`，hint 指向同岗位接任者；
14. 没有 `outcome` 的旧 slot → 回执 `outcome: "unknown"`（不产生 `undefined`，不炸 lossless 校验）。

**真机验收后补充的断言**（2026-11-22，同一条脚本，编号继续）：

15. 对方 `idle` + `next-step` 积压（`total:1, teamStep:1, teamTurn:0`，inject 停住）→ hint 含「不唤醒」「1 条」与可执行的改法；`total:0` 时仍是「空闲且队列空」；`oldestWaitMs:null` 时不写「最久」；
16. 对方 `running` + 队列空 → hint 含「排到它下一轮」；同一输入 `self:true` 仍为空串；`running` + 有积压时走「排队」档而不是这一档。

命令门槛：

```
node --check agent-team/index.js
node --check agent-team/tools.js
node scripts/test-delivery-visibility.mjs     # exit 0，打印逐条 PASS
node scripts/guard-daily-profile.mjs          # exit 0
```

---

## 9. 非目标

- 不做队列上限 / 拒发 / 自动熔断（§6.7 的既有决定）。
- 不做消息合并 / 去重。
- 不改面板 UI（数据已备好，后续接）。
- 不改 `inject` 不唤醒的语义 —— 只把「会停住」说出来。
