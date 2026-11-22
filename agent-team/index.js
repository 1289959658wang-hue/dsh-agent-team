// Agent Team (P2) — Host 侧共享状态。
//
// 这个插件**不注册任何工具**。它只做三件事：
//   1. 拥有团队状态的唯一写者（岗位表、组播消息、派发申请），落盘到**会话所属工作区**的
//      `<workspace>/.team/`（一个工作区一份 store，见 createTeamStore）；
//   2. 通过 `agentTeam` 服务把这份状态交给 preset 作用域里的工具使用；
//   3. 通过同源 HTTP 路由把状态交给面板（P3 前端用，模型用不到）。
//
// 为什么工具不在这里：工具必须只在 `agent-team` / `agent-team-worker` 两个模式下可见。
// DSH 的 preset 是一个独立 scope，选该 preset 的 agent 的 scope 以它为父，所以注册在
// preset 插件里的工具只被该 preset 的会话继承；注册在 Host 里的工具则是全局的。
//
// 证据（0.2.2-rc.5）：dsh-agent-preset-registry/lib/index.js:513,686（preset scope 与
// bindScopeParent）、dsh-scope/lib/index.js:296（createScope）、dsh-tools/lib/index.js:477
// （view 沿 scope 链继承）。
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-agent-team'
// `agents` 是只读依赖：查会话状态只走 `ctx.agents.get(sessionId)`（live agent），
// **绝不** `resolveAgent` —— 为了看一眼就把归档/冷会话拉起来，等于让"观察"产生副作用。
export const inject = ['sessionController', 'workspaceRegistry', 'agentDefaultModel', 'agents']

const EFFORT_POLICY = { simple: 'off', moderate: 'high', complex: 'max' }

const KINDS = ['task', 'question', 'answer', 'report', 'notice', 'handoff-request', 'handoff-approval', 'roster-update']

/**
 * 待办条数：挂起的派发申请 + 挂起的交接申请。
 *
 * 面板徽章、下拉里的小圆点、「待办」标签上的数字**必须是同一个口径**，
 * 否则会出现"侧边栏 2 条、点进去只有 1 行"这种没人信的界面。
 */
function pendingCountOf(store) {
  const spawns = Object.values(store?.spawnRequests ?? {}).filter((request) => request?.status === 'pending').length
  const handoffs = Object.values(store?.handoffs ?? {}).filter((request) => request?.status === 'pending').length
  return spawns + handoffs
}

/** 系统消息的发送方。审批结果这类"不是成员说出来的话"由它发，避免伪造某个会话的发言。 */
const SYSTEM_SENDER = 'at-system'

/**
 * 投递方式（reusable-solutions §6.4）。0.2.2-rc.5 没有 `{inject: label}` 这个 mode，
 * 等价机制是 Agent 自己的三种方法（dsh-agent-loop/lib/index.js:579-587）：
 *   followup = 下一轮 + 唤醒       → 派活、要求对方行动
 *   steer    = 下一步 + 唤醒       → 紧急纠正（只在对方正在跑时用）
 *   inject   = 下一步 + **不唤醒** → 通知、状态、旁听
 */
function deliveryModeOf({ kind, priority }) {
  if (priority === 'urgent') return 'steer'
  if (kind === 'notice' || kind === 'roster-update') return 'inject'
  return 'queue'
}

/**
 * 投递判定（纯函数，单测用）：把"怎么投的"翻译成"对方会怎么处理"。
 *
 * 底层事实（0.2.2-rc.5 `dsh-agent-loop`）：`followup` = 下一轮 + 唤醒；
 * `steer` = 当前轮下一步 + 唤醒；`inject` = 当前轮下一步 + **不唤醒**。
 * 于是同一个 `state:'delivered'` 背后有三种完全不同的命运：
 * 立刻处理、排在别人后面、以及**永远不会醒**（parked-no-wake）。
 *
 * 判定顺序不能换：上闩/失败/重入是"没投出去"的三种原因，优先于投递方式。
 *
 * @param {{ mode?: string, status?: string, latched?: boolean, reentrant?: boolean, failed?: boolean }} input
 * @returns {'held'|'failed'|'pending-delivery'|'woken-now'|'queued-turn'|'steered-step'|'injected-step'|'parked-no-wake'|'unknown'}
 */
export function deliveryVerdict({ mode, status, latched = false, reentrant = false, failed = false } = {}) {
  if (latched) return 'held'
  if (failed) return 'failed'
  if (reentrant) return 'pending-delivery'
  if (mode === 'inject') {
    if (status === 'running') return 'injected-step'
    if (status === 'idle') return 'parked-no-wake'
    return 'unknown'
  }
  if (mode === 'steer') {
    if (status === 'running') return 'steered-step'
    if (status === 'idle') return 'woken-now'
    return 'unknown'
  }
  // queue 是默认方式（deliveryModeOf 的兜底），mode 缺失时也按它算。
  if (status === 'idle') return 'woken-now'
  if (status === 'running') return 'queued-turn'
  return 'unknown'
}

/** 消息里能拿到的入队时间（我们自己的团队消息带 `source.ts`；人类消息没有）→ 已等毫秒数。 */
function messageWaitMs(message, now = Date.now()) {
  const ts = message?.source?.ts
  const at = typeof ts === 'number' ? ts : typeof ts === 'string' ? Date.parse(ts) : Number.NaN
  if (!Number.isFinite(at)) return null
  return Math.max(0, now - at)
}

/**
 * 等多久 → 人话（给 hint 用）。
 *
 * `null` / `undefined` / 非有限数一律返回空串：以前用 `Number(ms)` 归一，`Number(null) === 0`
 * 于是"没有等待数据"被写成「最久 0 秒」（真机回执里出现过「前面已有 0 条排队（最久 0 秒）」）。
 * 亚秒级等待也不写 0：最少说 1 秒（"最久"本来就表示上界）。
 */
export function formatWait(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
  return `${Math.max(1, Math.round(ms / 1000))} 秒`
}

const isTeamMessage = (message) => message?.source?.kind === 'agent-team'

/** 读一条 pending 列表（容错：字段缺失、getter 抛错都按空列表算）。 */
function inboxList(agent, key) {
  try {
    const value = agent?.inbox?.[key]
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

/**
 * 队列快照（纯函数、同步、只读）：inbox 里现在堵着什么。
 *
 * 不查会话日志、不调任何异步接口 —— 它只读 live agent 自己暴露的
 * `status` 与 `inbox.nextTurn/nextStep`（`dsh-api-session-controller` 的
 * `interface Agent` / `interface Inbox`），所以**读状态不会唤醒任何人**。
 *
 * 团队消息与非团队消息（人类消息等）分开数：前者能按 `messageId` 反查摘要，
 * 后者只计数（§4.2：不列进 messages）。
 *
 * @param {{ status?: string, inbox?: { nextTurn?: unknown[], nextStep?: unknown[] } } | undefined} agent
 * @returns {{ status: string, turn: number, step: number, teamTurn: number, teamStep: number,
 *   humanTurn: number, humanStep: number, oldestWaitMs: number | null }}
 */
export function readQueue(agent) {
  const turnList = inboxList(agent, 'nextTurn')
  const stepList = inboxList(agent, 'nextStep')
  const now = Date.now()
  const waits = [...turnList, ...stepList]
    .map((message) => messageWaitMs(message, now))
    .filter((value) => value !== null)
  const count = (list, team) => list.filter((message) => isTeamMessage(message) === team).length
  return {
    status: agent === undefined || agent === null ? 'not-live' : agent.status === 'running' ? 'running' : 'idle',
    turn: turnList.length,
    step: stepList.length,
    teamTurn: count(turnList, true),
    teamStep: count(stepList, true),
    humanTurn: count(turnList, false),
    humanStep: count(stepList, false),
    oldestWaitMs: waits.length > 0 ? Math.min(...waits) : null,
  }
}

/** 发送前"前面还堵着几条"：queue 看下一轮队列，steer/inject 看下一步队列（§5.2）。 */
function aheadCount(mode, queue) {
  if (mode === 'queue' || mode === undefined || mode === null) return Number(queue?.turn ?? 0)
  if (mode === 'steer' || mode === 'inject') return Number(queue?.step ?? 0)
  return 0
}

/** 队列快照的对外投影（§5.4 的 `delivery[].queue`：只给发件人判断要的那几个数）。 */
function projectQueue(queue) {
  return {
    turn: Number(queue?.turn ?? 0),
    step: Number(queue?.step ?? 0),
    teamTurn: Number(queue?.teamTurn ?? 0),
    teamStep: Number(queue?.teamStep ?? 0),
    oldestWaitMs: queue?.oldestWaitMs ?? null,
  }
}

/**
 * 一条投递回执（纯函数）：把 store 里的 slot 投影成给发件人看的样子。
 *
 * 旧字段（session / state / mode / at / error）原样保留，新字段只增不改；
 * `queueBefore` / `queueAfter` 是审记用的原始快照，不进回执（模型只需要 `ahead` + `queue`）。
 */
export function deliveryReceipt(slot) {
  const view = {
    session: slot.session,
    state: slot.state,
    mode: slot.mode,
    ...(slot.at === undefined ? {} : { at: slot.at }),
    ...(slot.error === undefined ? {} : { error: slot.error }),
    // 1.10.0 之前写下的 slot 没有 outcome（历史数据）：回执必须仍是无 undefined 的 lossless JSON，
    // 否则 DSH 的 `snapshotToolValue` 会把整次工具输出判成非法。
    outcome: slot.outcome ?? 'unknown',
    ...(slot.targetStatus === undefined ? {} : { targetStatus: slot.targetStatus }),
    ...(slot.ahead === undefined ? {} : { ahead: slot.ahead }),
    ...(slot.queueBefore === undefined ? {} : { queue: projectQueue(slot.queueBefore) }),
  }
  view.hint = deliveryHint(view)
  return view
}

/**
 * 投递回执的 `hint`（纯函数，单测用）：把 outcome 翻译成"现在该做什么"。
 * @param {{ outcome?: string, targetStatus?: string, ahead?: number, queue?: object, error?: string }} slot
 */
export function deliveryHint(slot = {}) {
  const ahead = Number(slot.ahead ?? 0)
  const wait = formatWait(slot.queue?.oldestWaitMs)
  const queueClause = `前面已有 ${ahead} 条排队${wait === '' ? '' : `（最久 ${wait}）`}`
  switch (slot.outcome) {
    case 'held':
      return '对方正在交接（上闩）：这条被暂扣（held），解闩后自动补投。'
    case 'failed':
      return `投递失败${slot.error === undefined ? '' : `（${slot.error}）`}：核对收件人是否还在职/已归档。`
    case 'pending-delivery':
      return '投递循环正忙：这条留在 pending，稍后自动补投。'
    case 'woken-now':
      return '对方空闲，已唤醒：这条会被立刻处理。'
    case 'queued-turn':
      return `对方正在跑，${queueClause}；你这条排在它下一轮。先等回执，别连发。`
    case 'steered-step':
      return '对方正在跑：这条插到当前轮的下一步，马上能读到。'
    case 'injected-step':
      return '对方正在跑：这条进了当前轮的下一步（inject，不额外唤醒）。'
    case 'parked-no-wake':
      // 文案必须可执行：`team_post` 没有 mode 参数，能改命的是 priority（→ steer，唤醒）
      // 与 kind（task/report/answer/question 走 queue）。别再叫模型"改用 team_post"。
      return '对方空闲且 inject 不唤醒：这条会停在 inbox，直到有人唤醒它 —— 要它现在处理就重发 priority: "urgent"，或换成 task/report 这类 kind（走 queue）。'
    default:
      return ''
  }
}

/**
 * `team_status` 的 `hint`（纯函数，单测用）。
 *
 * 主提示按 §4.3 的优先级取第一条命中的（archived > replaced > latched > not-live >
 * 自己的积压 > 对方 idle 但有积压 > 对方排队 > 对方在跑但队列空 > 空闲且队列空）；
 * **投递失败不参与这个排序**，只做后缀/兜底 ——
 * `failed` slot 是历史累计、永不自动清理，让它独占优先位的话，"一小时前失败过一条"
 * 会一直盖住"现在空闲且队列空"这个更要紧的事实。
 *
 * 两档"空串空洞"都是 2026-11-22 真机验收补的：
 *   - inject 停在 **next-step**（`teamTurn === 0`）且对方 idle 时，原来的分支全不命中；
 *   - 对方 running 但队列空时，hint 也是空串 —— 但那不等于"立刻处理"，而是排到下一轮。
 * 补上后，hint 才覆盖"发出去会怎样"的三种基本态：立刻处理 / 排队 / 停住不动。
 *
 * @param {{ archived?: boolean, replaced?: boolean, latched?: boolean, delivery?: object, status?: string,
 *   self?: boolean, inbox?: object, senders?: string[] }} input
 */
export function statusHint({ archived = false, replaced = false, latched = false, delivery = {}, status = 'not-live', self = false, inbox = {}, senders = [] } = {}) {
  const failed = Number(delivery?.failed ?? 0)
  const total = Number(inbox?.total ?? 0)
  const wait = formatWait(inbox?.oldestWaitMs)
  const from = (senders ?? []).filter((value) => typeof value === 'string' && value.length > 0)
  let main = ''
  if (archived) main = '该会话已归档：不要再发任务；需要人就在 team_directory 里找接任者。'
  else if (replaced) main = self
    ? '你已被交接替换：不要再接新任务；接任者是 team_directory 里同岗位的新会话。'
    : '该会话已被交接替换：不要再发任务；接任者在 team_directory 里同岗位的新会话。'
  else if (latched) main = self
    ? '你正在交接（上闩）：消息会被暂扣；等交接完成再发。'
    : '对方正在交接（上闩）：消息会被暂扣；等交接完成再发。'
  else if (status === 'not-live') main = '未运行，没有在途消息；发消息会把它唤醒。'
  else if (self && total > 0) {
    const detail = [wait === '' ? '' : `最久 ${wait}`, from.length === 0 ? '' : `来自 ${from.join('/')}`].filter(Boolean).join('，')
    main = `你有 ${total} 条未处理${detail === '' ? '' : `（${detail}）`}。先按顺序处理，处理完再发新消息。`
  } else if (!self && total > 0 && status === 'idle') {
    // 对方空闲、但 inbox 里有东西：这些是 inject 之类**不唤醒**的消息，会一直停着等人来叫。
    main = `对方空闲，但 inbox 里有 ${total} 条不唤醒的消息${wait === '' ? '' : `（最久 ${wait}）`}：它们会停在队列里，直到有人唤醒它。要它现在处理就重发 priority: "urgent"，或换 task/report 这类 kind。`
  } else if (Number(inbox?.teamTurn ?? 0) > 0 && status === 'running') {
    main = `对方正在跑，前面还有 ${total} 条排队${wait === '' ? '' : `（最久 ${wait}）`}。现在再发只会继续排队，先等回执。`
  } else if (!self && status === 'running' && total === 0) {
    // 在跑但队列空 ≠ 立刻处理：消息会排到它下一轮。留空串会让模型误判成"没排队 = 马上能看"。
    main = '对方正在跑但队列空：现在发会排到它下一轮，不是立刻处理。'
  } else if (total === 0 && status === 'idle') {
    main = '空闲且队列空：现在发能立刻处理。'
  }

  if (failed === 0) return main
  const note = `${failed} 条历史投递失败（这些消息从未送达，可在 team_status 里核对收件人）`
  return main === '' ? `有 ${note}。` : `${main}另有 ${note}。`
}

function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * 保留策略的**决策**（纯函数，单测用）。
 *
 * 消息不是缓存，是审计记录：所以过了上限也不删，只是**从活跃 store 挪到归档文件**
 * （`.team/archive/messages/*.json`，回读校验通过才挪）。这里只算"要不要动手"。
 *
 * @param {{ count: number, keep: number, ceiling: number }} input
 * @returns {null | { drop: number, keep: number }} null = 没到上限，别动
 */
export function pruneDecision({ count = 0, keep = 2000, ceiling = 5000 } = {}) {
  if (!Number.isFinite(count) || !Number.isFinite(keep) || !Number.isFinite(ceiling)) return null
  if (count <= ceiling) return null
  const drop = Math.floor(count - keep)
  return drop > 0 ? { drop, keep } : null
}

/**
 * 上下文用量的分档（纯函数，单测用）。
 *
 * 为什么需要：会话**看不到自己用了多少上下文**（DSH 的 runtime context 里没有这个数），
 * 于是"该不该交接"只能靠感觉猜 —— 2026-11-21 那轮 worker 在 126k / 1,048,576（12%）就报了
 * "上下文接近上限"。有了真实数字，交接才由数据和质量拐点决定，而不是由错觉决定。
 *
 * @param {{ used: number, window?: number, suggestAt?: number, requireAt?: number }} input
 *   used = 上一次请求的 inputToken + cacheReadToken（= 真实上下文大小）
 * @returns {{ available: boolean, band: 'keep-working'|'suggest-handoff'|'handoff-now'|'unknown', ratio?: number }}
 */
export function contextBand({ used = 0, window = 1048576, suggestAt = 0.45, requireAt = 0.55 } = {}) {
  if (!Number.isFinite(used) || used <= 0) return { available: false, band: 'unknown' }
  if (!Number.isFinite(window) || window <= 0) return { available: false, band: 'unknown' }
  const ratio = used / window
  const band = ratio >= requireAt ? 'handoff-now' : ratio >= suggestAt ? 'suggest-handoff' : 'keep-working'
  return { available: true, band, ratio: Number(ratio.toFixed(4)) }
}

function freshState() {
  return {
    version: 1,
    generation: 1,
    leader: null,
    nextWorkerSeq: 1,
    nextMessageId: 1,
    sessions: {},
    messages: [],
    spawnRequests: {},
    handoffs: {},
    leaderHistory: [],
    pruneLog: [],
    latched: {},
    preStep: {},
    updatedAt: new Date().toISOString(),
  }
}

/**
 * 配置里写了 `workspaceRoot` 就用它（绝对路径）；没写返回 `null`，由调用方决定默认落到哪。
 *
 * 为什么不内置一个默认路径：这个插件是给别人装的，任何写死的绝对路径在别人机器上都不存在。
 * 没配的时候 `apply()` 会退回**注册表里的第一个工作区**（通常就是应用的默认工作区），
 * 再没有才退回进程 cwd —— 见 `apply()` 里那段注释。
 */
export function resolveDefaultRoot(config = {}) {
  const configured = config.workspaceRoot
  return typeof configured === 'string' && configured.trim() !== '' ? path.resolve(configured) : null
}

/**
 * 路径的归一化键：同一个目录只能对应一份 store。
 *
 * Windows 下 `C:/a` 与 `c:\a` 是同一个目录 —— 大小写、分隔符都要抹平，
 * 否则 `?workspace=` 的两种写法会各建一份 store，两个写者抢同一批文件。
 */
function pathKey(target) {
  const resolved = path.resolve(String(target))
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * 会话属于哪个工作区（第 2 步的解析入口）。
 *
 * 权威账本是 `workspaceRegistry.list()` 每个 entity 的 `sessionIds`
 * （`dsh-workspace/lib/index.js:102` 的 getter，按会话 header 的 cwd 过滤）。
 * `sessionController.create({ workspaceId })` 会 `attachSession`，所以本插件建出来的
 * worker/继任会话一定在里面；查不到（会话没挂工作区）就由调用方回落默认 root。
 *
 * @param {object} ctx Host 上下文
 * @param {string} sessionId 会话 id
 * @returns {{ id: string, path: string, title: string } | undefined}
 */
function owningWorkspace(ctx, sessionId) {
  if (!sessionId) return undefined
  for (const workspace of ctx.workspaceRegistry.list()) {
    if (workspace.sessionIds.includes(sessionId)) return workspace
  }
  return undefined
}

/**
 * 建一个**团队 store**：一个工作区一份，状态落在 `<root>/.team/`。
 *
 * 为什么是工厂而不是模块级单例：团队是**按工作区**划分的（用户定的「模型 ①」）。
 * 第 1 步只做了结构搬运（行为零变化）；第 2 步起 `teamFor(root)` 会真的为第二个工作区
 * 开出第二份 store —— 工具按调用方会话反查工作区（`forSession`），面板按 `?workspace=` 取。
 *
 * 返回 `{ root, api, state, findMessage, panelState, reconcileArchived }`：
 *   - `api`      = 交给 `ctx.provide('agentTeam')` 的那组方法（工具层读它）；
 *   - `state`    = 只读取当前内存态（面板查正文用，别拿它改东西）；
 *   - `panelState()` = 面板 `/state` 的响应投影；
 *   - `onChange` = 注入的"store 写盘了"通知（由 apply 接到 SSE）。
 */
export function createTeamStore(root, { ctx, config = {}, onChange = () => {} } = {}) {
  // root 由调用方 resolve 好（apply 里 path.resolve；第 2 步起 = 工作区绝对路径）。
  const home = path.join(root, '.team')
  const bodyDir = path.join(home, 'bodies')
  const archiveDir = path.join(home, 'archive', 'messages')
  const storeFile = path.join(home, 'store.json')
  fs.mkdirSync(bodyDir, { recursive: true })

  const charter = {
    // 派发权限的默认档位。运行时可切换，真实档位存在 state.authority 里。
    defaultAuthority: config.spawnAuthority ?? 'ask', // ask | autonomous（完全权限）
    effortPolicy: { ...EFFORT_POLICY, ...(config.effortPolicy ?? {}) },
  }

  // 保留策略：活跃 store 里的消息超过 ceiling 就归档掉最旧的，把活跃量降回 keep。
  // 归档 ≠ 删除：正文与信封都留在 .team/archive/messages/ 下，且回读校验通过才动 store。
  const retention = {
    keep: Math.max(1, Number(config.retainMessages ?? 2000)),
    ceiling: Math.max(2, Number(config.maxMessages ?? 5000)),
  }
  if (retention.keep >= retention.ceiling) retention.ceiling = retention.keep * 2

  // 上下文与交接触发：窗口大小、以及"建议交接 / 必须交接"的两道比例线。
  // 数字来自用户：窗口 1,048,576，社区实测约 500k（≈48%）之后质量开始下降。
  const contextPolicy = {
    window: Math.max(1, Number(config.contextWindow ?? 1048576)),
    suggestAt: Number(config.handoffSuggestAt ?? 0.45),
    requireAt: Number(config.handoffRequireAt ?? 0.55),
  }

  const state = load()
  let delivering = false

  if (state.authority === undefined) state.authority = charter.defaultAuthority
  if (state.authorityLog === undefined) state.authorityLog = []
  if (state.spawnLog === undefined) state.spawnLog = []
  if (state.leaderHistory === undefined) state.leaderHistory = []
  if (state.pruneLog === undefined) state.pruneLog = []

  /** 当前派发权限：ask = 需要用户批准；autonomous = 完全权限，leader 自己派。 */
  const authority = () => (state.authority === 'autonomous' ? 'autonomous' : 'ask')

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
      return { ...freshState(), ...parsed, sessions: parsed.sessions ?? {}, messages: parsed.messages ?? [], spawnRequests: parsed.spawnRequests ?? {}, handoffs: parsed.handoffs ?? {}, latched: parsed.latched ?? {} }
    } catch {
      return freshState()
    }
  }

  function save() {
    state.updatedAt = new Date().toISOString()
    atomicWrite(storeFile, JSON.stringify(state, null, 2))
    onChange()
  }

  /**
   * 切换派发权限（「完全权限」开关）。归用户所有（charter §3.2），
   * 任何切换都写进 state.authorityLog，模型改不了它——只有面板/HTTP 能调。
   */
  function setAuthority(value, by = 'user') {
    if (value !== 'ask' && value !== 'autonomous') throw new Error(`未知派发权限: ${value}（只允许 ask | autonomous）`)
    state.authority = value
    state.authorityLog.push({ at: new Date().toISOString(), by, value })
    save()
    return snapshotAuthority()
  }

  function snapshotAuthority() {
    return {
      authority: authority(),
      label: authority() === 'autonomous' ? '完全权限' : '需要你批准',
      history: clone(state.authorityLog).slice(-10),
    }
  }

  /**
   * 清空团队：岗位表、消息、申请、上闩、日志全部归零，派发权限保留当前档位。
   * 开发/演练后清场用；只从本机接口调用，模型没有工具能碰它。
   */
  function resetTeam() {
    const keepAuthority = authority()
    const next = freshState()
    next.authority = keepAuthority
    next.authorityLog = []
    next.spawnLog = []
    next.preStep = {}
    next.rejects = {}
    // **计数器不归零**：归档的会话（`at-w-01-…`）、旧消息 id（`m-000001`）和它们的正文都还在，
    // 归零就会复用 —— 2026-11-21 实测过一次：reset 之后新的 m-000001 把旧会话的正文覆盖了。
    next.nextWorkerSeq = state.nextWorkerSeq ?? 1
    next.nextMessageId = state.nextMessageId ?? 1
    // 换一代：`generation` 用来区分"同一个团队的第几次重开"。
    next.generation = (state.generation ?? 1) + 1
    for (const key of Object.keys(state)) delete state[key]
    Object.assign(state, next)
    save()
    for (const dir of [bodyDir, path.join(home, 'handoffs')]) {
      try {
        for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { force: true })
      } catch { /* 目录不存在就算了 */ }
    }
    return snapshot()
  }

  const clone = (value) => JSON.parse(JSON.stringify(value))

  // ---- 状态查询 -------------------------------------------------------------

  const teamSessions = () => Object.keys(state.sessions)

  function roleOf(sessionId) {
    return state.sessions[sessionId]?.role
  }

  function snapshot() {
    return clone({
      generation: state.generation,
      leader: state.leader,
      charter: { spawnAuthority: authority() },
      authority: snapshotAuthority(),
      sessions: state.sessions,
      spawnRequests: state.spawnRequests,
      updatedAt: state.updatedAt,
    })
  }

  function roster() {
    return clone({
      generation: state.generation,
      leader: state.leader,
      members: Object.entries(state.sessions).map(([id, info]) => ({ session: id, ...info })),
      spawnRequests: Object.values(state.spawnRequests).filter((r) => r.status === 'pending'),
    })
  }

  /**
   * 通讯录：团队里还有谁、各自什么岗位。
   *
   * worker 没有 `team_roster`（那是 leader 的判读工具，带活动指标与待批申请），
   * 但协作需要知道同事的会话 id —— 只给"谁是谁"，不给任何判读数据。
   */
  function directory({ role = 'all', viewer } = {}) {
    const members = Object.entries(state.sessions)
      .filter(([, info]) => info.status !== 'archived' && info.status !== 'replaced')
      .filter(([, info]) => role === 'all' || info.role === role)
      .map(([id, info]) => ({
        session: id,
        job: info.job,
        role: info.role,
        title: info.title ?? info.job,
        isLeader: state.leader === id,
        self: viewer !== undefined && id === viewer,
      }))
    // `leader` 必须是字符串：没有 leader 时给空串 + `hasLeader: false`。
    // 1.6.1 之前这里直接返回 `state.leader`（null），撞上工具输出 schema 的 `type: 'string'`，
    // 导致"还没有 leader 的团队里 team_directory 直接报 invalid output"（2026-11-21 实测）。
    return { leader: state.leader ?? '', hasLeader: state.leader !== null, members, total: members.length }
  }

  /**
   * 读消息。分页用**消息 id 游标**，不用 offset：
   *   since  —— 只要比这个 id 新的（增量刷新）
   *   before —— 只要比这个 id 旧的（往上翻页）
   * 两种都返回"时间正序"的尾部 limit 条。
   */
  function messages({ limit = 50, since, before } = {}) {    const number = (id) => Number(String(id).slice(2))
    let all = state.messages
    if (since !== undefined && since !== null && since !== '') {
      const cut = number(since)
      if (Number.isFinite(cut)) all = all.filter((message) => number(message.id) > cut)
    }
    if (before !== undefined && before !== null && before !== '') {
      const cut = number(before)
      if (Number.isFinite(cut)) all = all.filter((message) => number(message.id) < cut)
    }
    return clone(all.slice(-limit))
  }

  /** leader 判读用的原始指标：只给数字与指针，不给全文（reusable-solutions §6.7）。 */
  function activity() {
    const perSession = {}
    for (const id of teamSessions()) perSession[id] = { sent: 0, received: 0 }
    for (const message of state.messages) {
      if (perSession[message.from]) perSession[message.from].sent += 1
      for (const target of message.to) if (perSession[target]) perSession[target].received += 1
    }
    return {
      totalMessages: state.messages.length,
      // 挪进归档的那些（活跃 store 里已经看不到，但没丢）
      archivedMessages: (state.pruneLog ?? []).reduce((sum, entry) => sum + (entry.count ?? 0), 0),
      perSession,
      longestSummary: state.messages.reduce((max, m) => Math.max(max, m.summary.length), 0),
      pendingSpawns: Object.values(state.spawnRequests).filter((r) => r.status === 'pending').length,
      sessions: teamSessions().length,
      // 完全权限下 leader 自主派发了几次（charter §3.2 要求可在风控汇报里说明）
      fullAuthoritySpawns: state.spawnLog.filter((entry) => entry.authority === 'autonomous').length,
      // 每个在职成员此刻的队列深度（同步只读；不拉起归档，也不唤醒任何会话）。
      // 面板不用改：activity() 是同一份投影，下次刷新就能看到（1.10.0 不做 UI）。
      queues: Object.fromEntries(
        Object.entries(state.sessions)
          .filter(([, info]) => info.status !== 'archived' && info.status !== 'replaced')
          .map(([id]) => [id, queueSnapshot(id)]),
      ),
    }
  }

  // ---- 会话状态（读状态绝不允许唤醒会话） ------------------------------------

  /**
   * 读 live agent：**只走 `ctx.agents.get`**。
   *
   * 这里刻意不用 `sessionController.resolveAgent`：那个会把归档/冷会话拉起来
   * （建 agent、进内存、可能要读盘），于是"看一眼"变成了一次副作用。
   * 拿不到就返回 undefined，由调用方报 `not-live`。
   */
  function liveAgent(sessionId) {
    try {
      const registry = ctx.agents ?? ctx.get?.('agents')
      return registry?.get?.(sessionId)
    } catch {
      return undefined
    }
  }

  /**
   * 某个会话此刻的队列快照（同步、只读，给 `activity()` 用）。
   * 归档/已被替换的会话不再有队列：全 0，且绝不尝试拉起。
   */
  function queueSnapshot(sessionId) {
    const info = state.sessions[sessionId]
    const latched = isLatched(sessionId)
    const empty = (status) => ({ status, turn: 0, step: 0, teamTurn: 0, teamStep: 0, oldestWaitMs: null, latched })
    if (info === undefined) return empty('not-live')
    if (info.status === 'archived') return empty('archived')
    if (info.status === 'replaced') return empty('replaced')
    const queue = readQueue(liveAgent(sessionId))
    return {
      status: queue.status,
      turn: queue.turn,
      step: queue.step,
      teamTurn: queue.teamTurn,
      teamStep: queue.teamStep,
      oldestWaitMs: queue.oldestWaitMs,
      latched,
    }
  }

  /** store 里"发给这个会话、还没落地"的条数（pending / held / failed）。 */
  function deliveryStats(sessionId) {
    const stats = { pending: 0, held: 0, failed: 0 }
    for (const message of state.messages) {
      for (const slot of message.delivery ?? []) {
        if (slot.session !== sessionId) continue
        if (slot.state === 'pending') stats.pending += 1
        else if (slot.state === 'held') stats.held += 1
        else if (slot.state === 'failed') stats.failed += 1
      }
    }
    return stats
  }

  /** 某个会话收发过几条、最后一次是什么时候（没有的字段不写）。 */
  function memberActivity(sessionId) {
    const stats = { sent: 0, received: 0 }
    for (const message of state.messages) {
      if (message.from === sessionId) {
        stats.sent += 1
        stats.lastSentAt = message.ts
      }
      if (message.to.includes(sessionId)) {
        stats.received += 1
        stats.lastReceivedAt = message.ts
      }
    }
    return stats
  }

  /**
   * 收件箱里的团队消息（先 next-turn 后 next-step，各自保持原顺序）。
   * 摘要按 `messageId` 从 store 反查 —— **不读正文**；归档/找不到给 null。
   */
  function inboxEntries(agent) {
    const now = Date.now()
    const entries = []
    const lists = [
      ['next-turn', inboxList(agent, 'nextTurn')],
      ['next-step', inboxList(agent, 'nextStep')],
    ]
    for (const [target, items] of lists) {
      for (const message of items) {
        if (!isTeamMessage(message)) continue
        const messageId = message?.source?.messageId ?? null
        const stored = messageId === null ? undefined : state.messages.find((item) => item.id === messageId)
        entries.push({
          messageId,
          from: message?.source?.from ?? null,
          kind: message?.source?.teamKind ?? null,
          mode: message?.source?.mode ?? null,
          target,
          waitMs: messageWaitMs(message, now),
          summary: stored?.summary ?? null,
        })
      }
    }
    return entries
  }

  const INBOX_MESSAGE_LIMIT = 20

  /**
   * 会话状态报告（`team_status` 的数据源）。
   *
   * 两件事必须守住：
   *   1. **读状态不唤醒会话** —— 只走 `liveAgent()`（`ctx.agents.get`），从不 `resolveAgent`；
   *   2. 权限沿用既有口径 —— 团队外抛错；别人的上下文用量只有 leader 能看。
   *
   * @param {string} sessionId 要查的会话（空 = 查 viewer 自己）
   * @param {{ viewer?: string }} options viewer = 调用方会话 id
   */
  async function statusReport(sessionId, { viewer } = {}) {
    const target = String(sessionId ?? '').trim() || String(viewer ?? '').trim()
    if (target === '') throw new Error('需要 sessionId（或调用方会话 id）')
    const self = viewer === target
    const info = state.sessions[target]
    if (info === undefined && !self) {
      // 与 resolveRecipients 同一个口径：跨团队与"根本不是成员"分开报，排查时不用猜。
      const owner = owningWorkspace(ctx, target)
      if (owner !== undefined && pathKey(owner.path) !== pathKey(root)) {
        throw new Error(`会话不在本团队: ${target}（它属于工作区 ${owner.path} 的团队）`)
      }
      throw new Error(`会话不在本团队: ${target}`)
    }
    // archived 与 replaced 是**两种不同的事**，不能合并报：
    //   archived = 真正归档（工作区注册表的归档集 / store 已标记）；
    //   replaced = 被新 leader 顶替的旧会话（promoteLeader 留下的痕迹，见 directory() 同口径）。
    // 注册表归档集也要看：store 里的 status 可能还没对账（对账会写盘/发通知，读状态不该有副作用）。
    const archivedIds = new Set(ctx.workspaceRegistry.archivedSessionIds ?? [])
    const archived = info !== undefined && (info.status === 'archived' || archivedIds.has(target))
    const replaced = info !== undefined && info.status === 'replaced'
    const outOfService = archived || replaced
    const agent = outOfService ? undefined : liveAgent(target)
    const queue = outOfService
      ? { status: 'archived', turn: 0, step: 0, teamTurn: 0, teamStep: 0, oldestWaitMs: null, humanTurn: 0, humanStep: 0 }
      : readQueue(agent)
    const entries = outOfService ? [] : inboxEntries(agent)
    const inbox = {
      turn: queue.turn,
      step: queue.step,
      total: queue.turn + queue.step,
      teamTurn: queue.teamTurn,
      teamStep: queue.teamStep,
      humanTurn: queue.humanTurn,
      humanStep: queue.humanStep,
      oldestWaitMs: queue.oldestWaitMs,
      messages: entries.slice(0, INBOX_MESSAGE_LIMIT),
      truncated: entries.length > INBOX_MESSAGE_LIMIT,
    }
    const report = {
      session: target,
      self,
      ...(info?.role === undefined ? {} : { role: info.role }),
      ...(info?.job === undefined ? {} : { job: info.job }),
      ...(info?.title === undefined && info?.job === undefined ? {} : { title: info?.title ?? info?.job }),
      archived,
      ...(replaced ? { replaced: true } : {}),
      live: agent !== undefined,
      status: archived ? 'archived' : replaced ? 'replaced' : queue.status,
      latched: isLatched(target),
      inbox,
      delivery: deliveryStats(target),
      activity: memberActivity(target),
    }
    // 上下文用量：自己总是给；leader 查**已挂载**队友也给；worker 查别人、以及归档/已替换/未挂载的会话一律 null。
    // 未挂载会话不给 context 是有意的：算用量要读 `sessionController.events`（碰会话日志），
    // 而"读状态不拉起会话"这条承诺不该被一个顺手的 context 破掉。
    report.context = (outOfService || (!self && state.leader !== viewer) || (!self && agent === undefined))
      ? null
      : await contextReport(target)
    report.hint = statusHint({
      archived,
      replaced,
      latched: report.latched,
      delivery: report.delivery,
      status: report.status,
      self,
      inbox,
      senders: [...new Set(entries.map((entry) => entry.from).filter((value) => value !== null))],
    })
    return report
  }

  // ---- 上下文用量（给"该不该交接"提供数据） --------------------------------

  /**
   * 读某个会话最近一次请求的真实上下文用量。
   *
   * `inputTokens` 只是新处理的部分，真正的上下文大小是 `inputTokens + cacheReadTokens`。
   * 从会话事件里取最后一条带 usage 的 `assistant/message`（不依赖模型自己报数）。
   */
  async function readContextUsage(sessionId) {
    try {
      const page = await ctx.sessionController.events(
        { address: { kind: 'session', sessionId }, maxMessages: 40 },
        new AbortController().signal,
      )
      const records = page?.records ?? []
      for (let index = records.length - 1; index >= 0; index -= 1) {
        const event = records[index]?.event
        if (event?.type !== 'assistant/message') continue
        const usage = event.data?.usage
        if (usage === undefined) continue
        const used = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0)
        if (used <= 0) continue
        return { used, outputTokens: usage.outputTokens ?? 0, turn: event.data?.turn ?? null, at: event.time ?? null }
      }
      return null
    } catch (error) {
      return { error: String(error && error.message ? error.message : error) }
    }
  }

  /** 汇总：真实用量 + 窗口 + 分档 + 建议动作。 */
  async function contextReport(sessionId) {
    const usage = await readContextUsage(sessionId)
    const window = contextPolicy.window
    if (usage === null) {
      return {
        session: sessionId,
        available: false,
        reason: 'no-usage',
        window,
        suggestAt: contextPolicy.suggestAt,
        requireAt: contextPolicy.requireAt,
        note: '这个会话还没跑过模型轮（或日志里没有 usage），算不出比例。',
      }
    }
    if (usage.error !== undefined) {
      return { session: sessionId, available: false, reason: 'read-error', error: usage.error, window }
    }
    const band = contextBand({ used: usage.used, window, suggestAt: contextPolicy.suggestAt, requireAt: contextPolicy.requireAt })
    return {
      session: sessionId,
      available: band.available,
      used: usage.used,
      window,
      ratio: band.ratio,
      percent: band.available ? Math.round(band.ratio * 100) : null,
      band: band.band,
      turn: usage.turn,
      suggestAt: contextPolicy.suggestAt,
      requireAt: contextPolicy.requireAt,
      hint: band.band === 'handoff-now'
        ? `已用 ${Math.round(band.ratio * 100)}%：现在就申请交接（team_handoff_request），并在 summary 里写明 used/window。`
        : band.band === 'suggest-handoff'
          ? `已用 ${Math.round(band.ratio * 100)}%：完成当前里程碑后就交接；还没到一个可交接的点可以继续，但不要再开大任务。`
          : `已用 ${Math.round(band.ratio * 100)}%：够用，不要因为"感觉快满了"交接。`,
    }
  }

  // ---- 保留策略 -------------------------------------------------------------

  /**
   * 把最旧的消息**挪进归档**，不删除。默认干跑（`dryRun: true`），
   * 真跑要做三件事，顺序不能换：写归档 → 回读校验 → 才从 store 里摘除。
   * 校验不过就抛错，宁可 store 继续涨，也不丢审计记录。
   */
  function pruneMessages({ keep = retention.keep, dryRun = true } = {}) {
    const size = state.messages.length
    const target = Math.max(0, Math.floor(Number(keep)))
    const dropCount = Math.max(0, size - target)
    // 还有未投递成功的消息不能进归档：它们还要被重投。
    const removable = state.messages.filter((message) => (message.delivery ?? []).every((slot) => slot.state !== 'pending'))
    const batch = removable.slice(0, Math.min(dropCount, removable.length))
    const plan = {
      dryRun,
      size,
      keep: target,
      drop: batch.length,
      range: batch.length === 0 ? null : `${batch[0].id}..${batch[batch.length - 1].id}`,
      archive: null,
      archived: false,
    }
    if (batch.length === 0) return plan
    plan.archive = path.join(archiveDir, `${batch[0].id}..${batch[batch.length - 1].id}.json`)
    if (dryRun) return plan
    fs.mkdirSync(archiveDir, { recursive: true })
    atomicWrite(plan.archive, JSON.stringify({
      archivedAt: new Date().toISOString(),
      count: batch.length,
      range: plan.range,
      keep: target,
      messages: batch,
    }, null, 2))
    const back = JSON.parse(fs.readFileSync(plan.archive, 'utf8'))
    if (back.count !== batch.length || (back.messages ?? []).length !== batch.length) {
      throw new Error(`归档校验失败（条数不一致），store 未改动：${plan.archive}`)
    }
    const ids = new Set(batch.map((message) => message.id))
    // 就地摘除：`deliver()` 可能正握着 state.messages 这个数组的引用。
    for (let index = state.messages.length - 1; index >= 0; index -= 1) {
      if (ids.has(state.messages[index].id)) state.messages.splice(index, 1)
    }
    if (state.pruneLog === undefined) state.pruneLog = []
    state.pruneLog.push({ at: new Date().toISOString(), count: batch.length, range: plan.range, archive: plan.archive })
    if (state.pruneLog.length > 50) state.pruneLog = state.pruneLog.slice(-50)
    save()
    plan.archived = true
    return plan
  }

  /** 超过 ceiling 才动手（`post()` 尾部调用）。出问题只记一笔，不能让发消息失败。 */
  function maybePrune() {
    const plan = pruneDecision({ count: state.messages.length, keep: retention.keep, ceiling: retention.ceiling })
    if (plan === null) return null
    try {
      return pruneMessages({ keep: plan.keep, dryRun: false })
    } catch (error) {
      state.retentionError = String(error && error.message ? error.message : error)
      save()
      return null
    }
  }

  // ---- 身份与岗位 -----------------------------------------------------------

  /**
   * leader 是否可用。**不接受多个 leader 并存**（用户 2026-11-21 决定）：
   * 一个团队只有一个 leader，宕机时不自动提拔，改由用户接管审批。
   */
  /**
   * 对账：把"宿主里已经归档、我方 store 还以为活着"的会话补正。
   *
   * 为什么必须有：归档是走**工作区注册表**的（面板/管理接口），我方 store 收不到通知。
   * 结果就是 2026-11-21 遇到的那个真问题——leader 会话被归档了，`state.leader` 还指着它，
   * 面板上一直显示"leader 已归档"，而要让团队继续只能由人手动移交。
   *
   * 处理方式（不违反"单 leader"）：**leader 归档就卸任，席位空出来**；
   * 之后用户新开一个 `Agent Team · Leader` 会话、它第一次调工具时按既有规则惰性认领。
   * 这里不做"自动提拔"——没有人的新会话，谁也不能自己上位。
   */
  function reconcileArchived() {
    const archivedIds = new Set(ctx.workspaceRegistry.archivedSessionIds ?? [])
    if (archivedIds.size === 0) return null
    const at = new Date().toISOString()
    const marked = []
    for (const [id, info] of Object.entries(state.sessions)) {
      if (archivedIds.has(id) && info.status === 'active') {
        state.sessions[id] = { ...info, status: 'archived', archivedAt: at }
        marked.push(id)
      }
    }
    let released = null
    if (state.leader !== null && archivedIds.has(state.leader)) {
      const previous = state.leader
      state.leader = null
      state.leaderHistory.push({ at, by: 'system', from: previous, to: null, reason: 'leader-archived' })
      if (state.leaderHistory.length > 50) state.leaderHistory = state.leaderHistory.slice(-50)
      released = previous
    }
    if (marked.length === 0 && released === null) return null
    save()
    if (released !== null) {
      // 通知还活着的成员（inject，不唤醒）；失败只记一笔，不影响对账。
      const others = Object.entries(state.sessions)
        .filter(([id, info]) => id !== released && info.status === 'active')
        .map(([id]) => id)
      if (others.length > 0) {
        void postSystem({
          to: others,
          kind: 'roster-update',
          summary: `leader 已归档，席位空出：${released}`,
          body: '原来的 leader 会话被归档，团队现在没有 leader。用户新开一个 Agent Team · Leader 会话即可接任（第一次调工具时自动认领）。在有人接任之前，派发与交接审批由用户在面板代批。',
        }).catch(() => {})
      }
    }
    return { marked, released }
  }

  /** 当前 leader 的状态（会先对账一次，保证"归档了就不会还报 active"）。 */
  function leaderStatus() {
    reconcileArchived()
    if (state.leader === null) return { id: null, available: false, reason: 'no-leader' }
    const entry = state.sessions[state.leader]
    if (entry?.status === 'archived') return { id: state.leader, available: false, reason: 'archived' }
    return { id: state.leader, available: true, reason: 'active' }
  }

  function leaderState() {
    return leaderStatus()
  }

  /** 该模式下第一个会话默认是 leader（charter §3.1）；已有 leader 就不再产生第二个。 */
  function claimLeader(sessionId, { preset } = {}) {
    // 先对账：原 leader 已被归档时，席位要先空出来，新会话才能接任（否则永远卡在死会话上）。
    reconcileArchived()
    if (state.leader === null) {
      state.leader = sessionId
      state.sessions[sessionId] = {
        role: 'leader',
        job: 'leader',
        title: '团队 leader',
        preset,
        status: 'active',
        generation: state.generation,
        createdAt: new Date().toISOString(),
        createdBy: 'user',
      }
      save()
    }
    return state.leader === sessionId
  }

  /**
   * 手动移交 leader（**只开给面板/HTTP，没有任何工具能调到它**）。
   *
   * leader 归档/宕机后团队会挂在旧会话上：`claimLeader` 不肯再认，于是派发和交接
   * 都没人批。用户 2026-11-21 的两条决定在这里都必须守住：
   *   1. 一个团队只允许一个 leader —— 卸任与任命在同一次写盘里完成，
   *      不存在两个 leader 并存的中间态；
   *   2. leader 宕机后由**人工**接管 —— 所以模型没有这条路径，只有用户点面板。
   *
   * 幂等：目标已经是 leader 时返回 `changed:false`，不写盘、不发通知。
   */
  async function promoteLeader({ sessionId, reason = '', by = 'panel' } = {}) {
    const target = String(sessionId ?? '').trim()
    if (!target) throw new Error('sessionId 必填：要交给哪个会话')
    if (state.leader === target) return { changed: false, leader: target, reason: 'already-leader' }

    // 归档/不存在的会话不能当 leader：它收不到消息，也开不了步骤。
    if ((ctx.workspaceRegistry.archivedSessionIds ?? []).includes(target)) {
      throw new Error(`目标会话已归档：${target}（先在会话列表里恢复它，或换一个会话）`)
    }
    const targetEntry = state.sessions[target]
    if (targetEntry?.status === 'archived') throw new Error(`目标会话已归档：${target}（先在会话列表里恢复它，或换一个会话）`)
    // 「这个会话是否存在」要看三处：岗位表、工作区的 sessionIds 索引、以及会话控制器能否解析它。
    // 只看 sessionIds 是不够的：会话的 header 落盘前它不在索引里（`dsh-workspace:102`）。
    let known = targetEntry !== undefined
      || (ctx.workspaceRegistry.list?.() ?? []).some((workspace) => (workspace.sessionIds ?? []).includes(target))
    if (!known) {
      try {
        const resolved = await ctx.sessionController.resolveAgent(target)
        known = resolved !== undefined && !('error' in resolved)
      } catch {
        known = false
      }
    }
    if (!known) throw new Error(`会话不存在：${target}（本工作区里找不到它）`)

    const previous = state.leader
    const at = new Date().toISOString()
    // 卸任旧 leader：留档不删 —— 事后要能解释"为什么现在这个人是 leader"。
    if (previous !== null && state.sessions[previous] !== undefined) {
      state.sessions[previous] = {
        ...state.sessions[previous],
        status: state.sessions[previous].status === 'archived' ? 'archived' : 'replaced',
        replacedBy: target,
        replacedAt: at,
      }
    }
    // 任命：岗位表里没有它（例如用户新开的会话）就补一条；本来是 worker 的保留原岗位。
    const wasWorker = targetEntry?.role === 'worker'
    state.sessions[target] = {
      ...(targetEntry ?? { createdAt: at, createdBy: by, generation: state.generation }),
      role: 'leader',
      job: 'leader',
      title: '团队 leader',
      status: 'active',
      ...(wasWorker ? { previousJob: targetEntry.job } : {}),
      promotedAt: at,
      promotedBy: by,
    }
    state.leader = target
    state.leaderHistory.push({ at, by, from: previous, to: target, reason })
    if (state.leaderHistory.length > 50) state.leaderHistory = state.leaderHistory.slice(-50)
    save()

    const result = { changed: true, leader: target, previous, notified: [], at }
    // 通知活着的成员（inject：只进下一步上下文，不唤醒算力）。旧 leader 本身不通知。
    const others = Object.entries(state.sessions)
      .filter(([id, info]) => id !== target && id !== previous && info.status !== 'archived' && info.status !== 'replaced')
      .map(([id]) => id)
    if (others.length > 0) {
      try {
        const message = await postSystem({
          to: others,
          summary: `leader 已移交：${previous ?? '（无）'} → ${target}`,
          body:
            `用户在面板里把 leader 换成了 ${target}。${reason ? `原因：${reason}\n` : ''}` +
            '从现在起：派发申请由它审批，worker 的交接申请也发给它；' +
            `${previous ?? '原来的 leader'} 不再有派发与审批权限。这只是通知，不需要回复。`,
        })
        result.notified = message.to
      } catch (error) {
        result.warning = String(error && error.message ? error.message : error)
        state.leaderHistory[state.leaderHistory.length - 1].notifyError = result.warning
        save()
      }
    }
    // 诚实提示：派发工具只装配在 Agent Team · Leader 会话里，换错预设就只有审批权、没有派发权。
    const preset = state.sessions[target]?.preset
    if (preset !== undefined && preset !== 'agent-team') {
      result.warning = `目标会话用的是 ${preset} 预设：它可以代批交接单，但没有派发工具（那些工具只装配在 Agent Team · Leader 会话里）。`
    }
    return result
  }

  function registerWorker({ sessionId, job, title, preset, createdBy, requestId }) {
    state.sessions[sessionId] = {
      role: 'worker',
      job,
      title: title ?? job,
      preset,
      status: 'active',
      generation: state.generation,
      createdAt: new Date().toISOString(),
      createdBy,
      ...(requestId === undefined ? {} : { requestId }),
    }
    save()
  }

  // ---- 组播 ----------------------------------------------------------------

  /**
   * 收件人解析（charter §4.1 / reusable-solutions §6.3）。
   * 越权一律抛错：不静默丢弃，也不放宽成广播。
   */
  function resolveRecipients(from, expr) {
    const role = roleOf(from)
    if (role === undefined) throw new Error(`发送者不在团队岗位表里: ${from}`)
    // 归档 / 已被交接替换的会话不再是活成员：广播不能把它们算进去
    // （2026-11-21 实测：交接后 role:qa 的两条 notice 仍投给了已归档的旧会话，白烧一轮）。
    const live = (id) => {
      const info = state.sessions[id]
      return info !== undefined && info.status !== 'archived' && info.status !== 'replaced'
    }

    if (expr === 'all') {
      if (role !== 'leader') throw new Error('只有 leader 可以发给全体')
      const targets = teamSessions().filter((id) => id !== from && live(id))
      if (targets.length === 0) throw new Error('团队里还没有其他成员')
      return targets
    }

    if (expr === 'leader') {
      if (state.leader === null) throw new Error('团队还没有 leader')
      if (state.leader === from) throw new Error('leader 不能发给自己')
      return [state.leader]
    }

    if (typeof expr === 'string' && expr.startsWith('role:')) {
      const job = expr.slice('role:'.length)
      // worker 可以按**自己的**岗位群发（章程 §4.1 的"同组同事"），别的岗位仍然只有 leader 能发。
      if (role !== 'leader' && state.sessions[from]?.job !== job) {
        throw new Error(`只有 leader 可以按岗位群发；worker 只能发 role:<自己的岗位>（你的岗位是 ${state.sessions[from]?.job ?? '未知'}）`)
      }
      const targets = teamSessions().filter((id) => id !== from && live(id) && state.sessions[id].job === job)
      if (targets.length === 0) throw new Error(`没有岗位为 ${job} 的成员`)
      return targets
    }

    const ids = (Array.isArray(expr) ? expr : String(expr).split(',')).map((s) => s.trim()).filter(Boolean)
    if (ids.length === 0) throw new Error('没有解析出收件人')
    for (const id of ids) {
      if (state.sessions[id] === undefined) {
        // 第 2 步的跨区守卫（用户 2026-11-21 定的口径：直接拒绝，不允许跨团队点对点）。
        // 别人的会话在**自己的** store 里，本 store 的岗位表里查不到它 —— 这里把"另一个团队"
        // 和"根本不是团队成员"分开报，否则排查时只能猜。
        const owner = owningWorkspace(ctx, id)
        if (owner !== undefined && pathKey(owner.path) !== pathKey(root)) {
          throw new Error(`收件人不在本团队: ${id}（它属于工作区 ${owner.path} 的团队；跨团队投递不支持）`)
        }
        throw new Error(`收件人不是团队成员: ${id}`)
      }
      if (!live(id)) throw new Error(`收件人已归档: ${id}（它已被交接替换或归档，请发给现任会话）`)
    }
    const targets = ids.filter((id) => id !== from)
    if (targets.length === 0) throw new Error('收件人只有发送者自己')
    return targets
  }

  function writeBody(message) {
    const file = path.join(bodyDir, `${message.id}.md`)
    const lines = [
      `# ${message.id}`,
      '',
      `- from: ${message.from}`,
      `- to: ${message.to.join(', ')}`,
      `- to_expr: ${JSON.stringify(message.toExpr)}`,
      `- kind: ${message.kind}`,
      `- priority: ${message.priority}`,
      `- ts: ${message.ts}`,
      '',
      `## ${message.summary}`,
      '',
      message.body ?? '',
      '',
    ]
    fs.writeFileSync(file, lines.join('\n'), 'utf8')
    return file
  }

  function envelope(message) {
    return [
      `[Agent Team ${message.id}] from=${message.from} kind=${message.kind} priority=${message.priority}`,
      `summary: ${message.summary}`,
      `body: ${message.bodyPath}`,
      '',
      '这是团队消息。处理后按岗位职责回复（worker 用 team_report，leader 用 team_post）。',
    ].join('\n')
  }

  /**
   * 先存储、后投递（reusable-solutions §3.4）：消息一旦入库就一定留下痕迹，
   * 投递失败只标记该收件人，不回滚、不静默丢弃。
   */
  async function post({ from, to, kind = 'notice', priority = 'normal', summary, body, system = false, mode: overrideMode }) {
    if (!KINDS.includes(kind)) throw new Error(`未知消息类型: ${kind}（允许：${KINDS.join(', ')}）`)
    if (!summary || summary.length > 500) throw new Error('summary 必填且不超过 500 字')
    // system = true 是审批结果一类的系统消息：不经成员权限校验，收件人必须是团队成员。
    const to_ = system
      ? (Array.isArray(to) ? to : [to]).filter((id) => state.sessions[id] !== undefined)
      : resolveRecipients(from, to)
    if (to_.length === 0) throw new Error('没有有效收件人')
    const id = `m-${String(state.nextMessageId++).padStart(6, '0')}`
    const mode = overrideMode ?? deliveryModeOf({ kind, priority })
    const message = {
      id,
      ts: new Date().toISOString(),
      from,
      toExpr: to,
      to: to_,
      kind,
      priority,
      mode,
      summary,
      body: body ?? '',
      bodyPath: '',
      delivery: to_.map((session) => ({ session, state: 'pending', mode })),
    }
    message.bodyPath = writeBody(message)
    state.messages.push(message)
    save()
    await deliver(message)
    // 超过 ceiling 才归档（默认 5000 → 2000），挪走的是已经投递完的最旧那批。
    maybePrune()
    // 回执的 `outcome` / `queue` / `hint` 由 Host 生成（纯函数投影），工具层原样透传：
    // 模型不用自己解释「delivered」到底意味着"马上处理"还是"排在第 3 轮后面"。
    const receipt = clone(message)
    receipt.delivery = receipt.delivery.map(deliveryReceipt)
    return receipt
  }

  /**
   * 先存储、后投递。三种投递方式见文件顶部的 `deliveryModeOf`：
   * `inject` 用 `agent.inject()`（不唤醒），`steer`/`queue` 走 `sessionController.prompt`。
   */
  /** 系统消息：审批结果、派发结果这类通知，由 `at-system` 发出。 */
  function postSystem({ to, kind = 'roster-update', summary, body = '', priority = 'normal', mode = 'queue' }) {
    return post({ from: SYSTEM_SENDER, to, kind, summary, body, priority, system: true, mode })
  }

  /**
   * 一条团队消息在"对方上下文里"的样子。
   *
   * `source.kind: 'agent-team'` 是**上闩守卫能分辨来源的唯一依据**：以前走
   * `sessionController.prompt(...)`，它造出来的消息 source 恒为 `'user'`，
   * 于是上闩的"人类消息放行"分支对所有团队消息都成立 —— 上闩等于没有。
   * 现在 `queue`/`steer` 也像 `inject` 一样自己造消息（带我们的 source），
   * 守卫才真的能拒绝"别人发来的消息"。
   */
  function teamMessage(message_, slot) {
    return Object.freeze({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: envelope(message_) }],
      // `from` / `teamKind` / `ts` 只给"读状态"用（收件人据此知道自己欠了谁的什么、等了多久）。
      // `kind` 仍必须是 `'agent-team'` —— 上闩守卫判据只看它（见 guardDecision）。
      source: {
        kind: 'agent-team',
        messageId: message_.id,
        mode: slot.mode,
        from: message_.from,
        teamKind: message_.kind,
        ts: message_.ts,
      },
    })
  }

  async function deliver(message) {
    if (delivering) {
      // 单写者：重入时把消息留在 pending，由当前投递循环之后补投。
      // 回执要如实说"还没投"（pending-delivery），否则发件人会以为对方已经收到了。
      if (message !== undefined) {
        for (const slot of message.delivery ?? []) {
          if (slot.state !== 'pending') continue
          slot.outcome = deliveryVerdict({ mode: slot.mode, reentrant: true })
        }
        save()
      }
      return
    }
    delivering = true
    try {
      let progressed = true
      while (progressed) {
        progressed = false
        for (const message_ of state.messages) {
          for (const slot of message_.delivery) {
            if (slot.state !== 'pending') continue
            progressed = true
            try {
              const resolved = await ctx.sessionController.resolveAgent(slot.session)
              if ('error' in resolved) throw new Error(resolved.error.code)
              const agent = resolved.agent
              // 上闩的会话**不投递**：暂扣（held），解闩时补投。
              // 只靠守卫拦是不够的 —— 拦下来时消息已经被 inbox 取走，等于静默丢弃。
              if (isLatched(slot.session)) {
                const queue = readQueue(agent)
                slot.state = 'held'
                slot.error = 'latched'
                slot.heldAt = new Date().toISOString()
                slot.outcome = deliveryVerdict({ mode: slot.mode, status: queue.status, latched: true })
                slot.targetStatus = queue.status
                slot.queueBefore = queue
                slot.queueAfter = queue
                slot.ahead = aheadCount(slot.mode, queue)
              } else {
                // 发送前先读队列：`ahead` 与 `targetStatus` 说的都是"我这条发出去之前"的样子。
                const queueBefore = readQueue(agent)
                if (slot.mode === 'inject') {
                  // 旁听：只进对方的下一步上下文，算力上不唤醒它。
                  agent.inject(teamMessage(message_, slot))
                  slot.state = 'injected'
                } else if (slot.mode === 'steer') {
                  agent.steer(teamMessage(message_, slot))
                  slot.state = 'delivered'
                } else {
                  agent.followup(teamMessage(message_, slot))
                  slot.state = 'delivered'
                }
                const queueAfter = readQueue(agent)
                slot.outcome = deliveryVerdict({ mode: slot.mode, status: queueBefore.status })
                slot.targetStatus = queueBefore.status
                slot.queueBefore = queueBefore
                slot.queueAfter = queueAfter
                slot.ahead = aheadCount(slot.mode, queueBefore)
              }
              slot.at = new Date().toISOString()
            } catch (error) {
              slot.state = 'failed'
              slot.error = String(error && error.message ? error.message : error)
              slot.outcome = deliveryVerdict({ mode: slot.mode, failed: true })
            }
            save()
          }
        }
      }
    } finally {
      delivering = false
    }
  }

  /** 解闩后把上闩期间暂扣的消息补投出去（失败只标记该 slot）。 */
  async function redeliverHeld(sessionId) {
    const touched = []
    for (const message of state.messages) {
      for (const slot of message.delivery) {
        if (slot.session === sessionId && slot.state === 'held') {
          slot.state = 'pending'
          delete slot.error
          delete slot.heldAt
          touched.push(message.id)
        }
      }
    }
    if (touched.length === 0) return []
    save()
    try {
      await deliver()
    } catch (error) {
      state.redeliverError = String(error && error.message ? error.message : error)
      save()
    }
    return touched
  }

  // ---- 派发（charter §3.2） -------------------------------------------------

  /**
   * 本团队真的落在哪个工作区（1.9.1 修复）。
   *
   * 以前这里是 `resolveByPath(root) ?? create(...)`：目录**存在**就返回它的工作区。
   * `resolveByPath` 按 realpath 匹配，注册表里有指向同一物理目录的多个条目时，返回的是
   * 先命中的那个 —— 不一定是"我这个 store 自己"的路径。
   *
   * 注意：2026-11-21 那次"ws-b 的批准被 ws-c 拒掉"，**真正的原因是会话 id 撞号**
   * （见下面 `sessionIdTaken`），不是这里。这处硬化是顺带的：让"这个团队属于哪个工作区"
   * 不再依赖一次可能被 realpath 命中的回落。
   *
   * 现在的顺序：
   *   1. 本 store 的岗位表里已有会话 → 用**那些会话实际所在**的工作区（最硬的证据）；
   *   2. 否则按路径精确匹配注册表（`pathKey` 比较，不做 realpath）；
   *   3. 都找不到才注册一个（只会在目录真的没有对应工作区时发生）。
   */
  async function workspace() {
    for (const sessionId of Object.keys(state.sessions)) {
      const owner = owningWorkspace(ctx, sessionId)
      if (owner !== undefined) return owner
    }
    const listed = ctx.workspaceRegistry.list()
    const key = pathKey(root)
    for (const candidate of listed) {
      if (pathKey(candidate.path) === key) return candidate
    }
    // 标题只在**新建**工作区时用；默认工作区的 basename 就是 'AgentWorkTeam'，与 1.8.0 一致。
    const canonical = await realpathOrSelf(root)
    for (const candidate of listed) {
      if (pathKey(candidate.path) === pathKey(canonical)) return candidate
    }
    return ctx.workspaceRegistry.create(root, path.basename(root))
  }

  /** realpath 读不到时退回原路径（目录可能还没建，交给 create() 报错）。 */
  async function realpathOrSelf(target) {
    try {
      return await fs.promises.realpath(target)
    } catch {
      return target
    }
  }

  /**
   * 会话 id 是 **DSH 全局唯一**的键，不是每个工作区一套（1.9.1 修复）。
   *
   * 1.9.0 把 store 拆成"一个工作区一份"之后，`state.nextWorkerSeq` 也跟着变成每个工作区各数各的 ——
   * 于是两个工作区的团队各自从 01 开始数，**同一个岗位名就会撞出同一个 id**。
   * 2026-11-21 用户实测：沙箱 B 批三条 `worker-1/2/3`，生成的 `at-w-01..03-worker-1..3`
   * 与沙箱 C 团队早就建好的会话 id 一字不差，DSH 直接拒绝：
   * `session "at-w-03-worker-3" belongs to "…\ws-c", not "…\ws-b"`。
   *
   * 所以 id 必须**先查全局没人用**再发。查的地方按硬度排序：
   * 本 store 的岗位表 / 注册表的归档集 / 注册表里每个工作区的 `sessionIds`。
   */
  async function sessionIdTaken(sessionId) {
    if (state.sessions[sessionId] !== undefined) return true
    if ((ctx.workspaceRegistry.archivedSessionIds ?? []).includes(sessionId)) return true
    for (const workspace of ctx.workspaceRegistry.list()) {
      if (workspace.sessionIds.includes(sessionId)) return true
    }
    return false
  }

  /** 反复取候选 id 直到全局没人用（候选由 `make` 生成，它自己会推进计数器）。 */
  async function allocateSessionId(make) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = make()
      if (!(await sessionIdTaken(candidate))) return candidate
    }
    throw new Error('分配会话 id 失败：连续 100 个候选都已被占用')
  }

  /**
   * 建会话；id 撞了就换一个再试（注册表可能看不到某些会话，所以还要兜一层 DSH 自己的冲突错误）。
   * 只对"id 已被占用"这类错误重试 —— 工作区不存在、preset 缺失重试也没用，直接抛。
   */
  async function createSessionWithUniqueId({ workspaceId, agentPreset, make }) {
    let lastError
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const sessionId = await allocateSessionId(make)
      try {
        await ctx.sessionController.create({ sessionId, workspaceId, agentPreset })
        return sessionId
      } catch (error) {
        lastError = error
        const text = String(error && error.message ? error.message : error)
        if (!/belongs to|already|conflict|exists|占用/i.test(text)) throw error
      }
    }
    throw lastError
  }

  function nextWorkerId(job) {
    const seq = String(state.nextWorkerSeq++).padStart(2, '0')
    return `at-w-${seq}-${job}`
  }

  /** leader 继任会话的 id：共用序号计数器，前缀 `at-lead-` 让面板显示成 "leader NN"。 */
  function nextLeaderId() {
    const seq = String(state.nextWorkerSeq++).padStart(2, '0')
    return `at-lead-${seq}`
  }

  async function applyEffort(sessionId, complexity = 'moderate') {
    const effort = charter.effortPolicy[complexity] ?? charter.effortPolicy.moderate
    if (!effort) return null
    const base = ctx.agentDefaultModel.currentSelection()
    const applied = await ctx.sessionController.selectModel({ sessionId, provider: base.provider, model: base.model, reasoningEffort: effort })
    const resolved = applied?.selected?.reasoningEffort ?? effort
    if (state.sessions[sessionId]) {
      state.sessions[sessionId].effort = resolved
      save()
    }
    return resolved
  }

  /**
   * 真建 worker 会话。只在 autonomous 档，或用户通过面板批准了申请时调用。
   * `createdBy` 区分 `leader`（自主派发）与 `user`（代批）。
   */
  /**
   * 给新会话起名并**钉住**它。
   *
   * 为什么必须在投递第一条消息之前：DSH 的 `session-title-first-prompt-llm` 会用
   * 会话收到的第一条 human 消息生成标题；我们的第一条消息是 `[Agent Team m-000001] from=…`
   * 这种内部信封，不先钉住标题，侧边栏里就全是这种噪音。`rename` 写入的标题
   * source.kind 是 `user`，会 pin 住并取消在途的自动生成（dsh-session-title:292-311）。
   */
  async function nameSession(sessionId, title) {
    try {
      await ctx.sessionController.rename({ sessionId, title: title.slice(0, 40) })
      return null
    } catch (error) {
      return String(error && error.message ? error.message : error)
    }
  }

  function sessionTitleFor(job, task) {
    const brief = String(task ?? '').replace(/\s+/g, ' ').trim().slice(0, 24)
    return `${job}${brief ? ` · ${brief}` : ''}`
  }

  async function spawnWorker({ job, title, task, complexity = 'moderate', requestedBy, requestId, approvedBy }) {
    if (!job || !/^[a-z0-9-]{2,32}$/.test(job)) throw new Error('job 必须是 2–32 位小写字母、数字或连字符')
    if (!task) throw new Error('task 必填：这是新会话收到的第一条指令')
    const workspace_ = await workspace()
    const sessionId = await createSessionWithUniqueId({
      workspaceId: workspace_.id,
      agentPreset: 'agent-team-worker',
      make: () => nextWorkerId(job),
    })
    // 先起名、再投递：顺序反了标题就会被信封定死。
    const renameError = await nameSession(sessionId, sessionTitleFor(job, title ?? task))
    const createdBy = approvedBy ? 'user' : requestedBy
    registerWorker({ sessionId, job, title, preset: 'agent-team-worker', createdBy, requestId })
    if (state.sessions[sessionId] !== undefined && renameError !== null) state.sessions[sessionId].renameError = renameError
    if (state.sessions[sessionId] !== undefined) {
      state.sessions[sessionId].authority = authority()
      state.sessions[sessionId].approval = approvedBy ? 'user-approved' : authority() === 'autonomous' ? 'full-authority' : 'leader'
    }
    // 自主派发逐次留痕（charter §3.2：开了零审批也要能在事后复盘）
    state.spawnLog.push({
      at: new Date().toISOString(),
      session: sessionId,
      job,
      requestedBy,
      approvedBy: approvedBy ?? null,
      authority: authority(),
      requestId: requestId ?? null,
    })
    save()
    let effort = null
    try {
      effort = await applyEffort(sessionId, complexity)
    } catch (error) {
      if (state.sessions[sessionId]) {
        state.sessions[sessionId].effortError = String(error && error.message ? error.message : error)
        save()
      }
    }
    const message = await post({ from: state.leader, to: sessionId, kind: 'task', summary: `派发：${title ?? job}`, body: task })
    return { sessionId, preset: 'agent-team-worker', effort, messageId: message.id }
  }

  /** ask 档：不建会话，只落一条待用户批准的申请。 */
  function requestSpawn({ job, title, task, complexity = 'moderate', requestedBy }) {
    const id = `s-${Date.now().toString(36)}`
    state.spawnRequests[id] = {
      id,
      job,
      title: title ?? job,
      task,
      complexity,
      requestedBy,
      requestedAt: new Date().toISOString(),
      status: 'pending',
    }
    save()
    return clone(state.spawnRequests[id])
  }

  async function rejectSpawn(requestId, reason) {
    const request = state.spawnRequests[requestId]
    if (request === undefined) throw new Error(`未知派发申请: ${requestId}`)
    if (request.status !== 'pending') throw new Error(`申请不是待批状态: ${request.status}`)
    request.status = 'rejected'
    request.rejectedAt = new Date().toISOString()
    if (reason !== undefined) request.reason = reason
    save()
    try {
      await postSystem({
        to: request.requestedBy,
        kind: 'roster-update',
        summary: `派发被拒绝：${request.job}`,
        body: reason ? `原因：${reason}` : '用户没有给原因。不要重复提交同一条申请，除非情况变了。',
      })
    } catch (error) {
      request.notifyError = String(error && error.message ? error.message : error)
      save()
    }
    return clone(request)
  }

  /** 面板「待办」的唯一数据源：把各类挂起申请抹平成一种形状，并标出该由谁批。 */
  function pendingActions() {
    const leader = leaderState()
    const spawns = Object.values(state.spawnRequests)
      .filter((request) => request.status === 'pending')
      .map((request) => ({
        id: request.id,
        type: 'spawn',
        job: request.job,
        title: request.title,
        summary: request.task,
        from: request.requestedBy,
        at: request.requestedAt,
        status: request.status,
        // 派发：只有 leader 直接向用户提交申请
        awaiting: 'user',
        awaitingReason: 'leader 申请派发新会话',
      }))
    const handoffs = Object.values(state.handoffs ?? {})
      .filter((request) => request.status === 'pending')
      .map((request) => ({
        id: request.id,
        type: 'handoff',
        job: request.job,
        title: request.job,
        summary: request.summary + (request.reason ? `\n原因：${request.reason}` : ''),
        from: request.from,
        at: request.requestedAt,
        status: request.status,
        docPath: request.docPath,
        // 「要求补充」过但还没补回来：面板要能看出来在等谁
        infoRequested: request.infoRequested ?? null,
        // 交接：worker 交给 leader 批；leader 的继任申请只能用户批；
        // leader 宕机时 worker 的申请也由用户代批。
        awaiting: request.from === state.leader ? 'user' : leader.available ? 'leader' : 'user',
        awaitingReason: request.from === state.leader
          ? 'leader 提交的继任申请：只能由你批准（leader 不能批准自己的继任）'
          : leader.available ? 'leader 在线' : `leader 不可用（${leader.reason}），需要你代批`,
      }))
    return [...spawns, ...handoffs].sort((a, b) => a.at.localeCompare(b.at))
  }

  async function approveSpawn(requestId, approvedBy = 'user') {
    const request = state.spawnRequests[requestId]
    if (request === undefined) throw new Error(`未知派发申请: ${requestId}`)
    if (request.status !== 'pending') {
      // 1.9.0 的一个坑：以前先把状态写成 approved 再建会话，建会话一抛错，
      // 申请就永远停在 approved —— 既不在待办里，也没人重试，用户看到的是"批准了但没建出来"。
      const note = request.spawnError ? `（上次失败：${request.spawnError}）` : ''
      throw new Error(`申请不是待批状态: ${request.status}${note}`)
    }
    // **先建会话、成功了才算批准**：失败时状态原样回到 pending，用户可以在面板重试。
    request.approvedBy = approvedBy
    request.approvedAt = new Date().toISOString()
    let spawned
    try {
      spawned = await spawnWorker({ ...request, requestedBy: request.requestedBy, requestId, approvedBy })
    } catch (error) {
      request.status = 'pending'
      request.spawnError = String(error && error.message ? error.message : error)
      save()
      throw error
    }
    request.status = 'approved'
    delete request.spawnError
    request.sessionId = spawned.sessionId
    save()
    // 批准之后必须告诉 leader：否则它一直等着，不知道自己的申请已经落地。
    try {
      await postSystem({
        to: request.requestedBy,
        kind: 'roster-update',
        summary: `已批准派发：${request.job} → ${spawned.sessionId}`,
        body: `岗位 ${request.job}；新会话 ${spawned.sessionId}；任务：${request.task}\n由 ${approvedBy} 批准，任务已投递。这只是系统回执：不需要回复，也不需要重新派发，等它用 team_report 回报即可。`,
      })
    } catch (error) {
      request.notifyError = String(error && error.message ? error.message : error)
      save()
    }
    return spawned
  }

  // ---- 交接（charter §6） ----------------------------------------------------

  /**
   * 上闩：交接申请发出后，旧会话不许再开新步骤（由 preset 作用域里的
   * `agent/pre-step` 监听器执行，见 tools.js）。人类消息永远放行。
   */
  function latch(sessionId, reason) {
    state.latched[sessionId] = { at: new Date().toISOString(), reason: reason ?? 'handoff-request' }
    save()
  }

  function unlatch(sessionId) {
    if (state.latched[sessionId] === undefined) return
    delete state.latched[sessionId]
    save()
    // 上闩期间暂扣的团队消息现在补投（异步；只影响这一会话的 held slot）。
    void redeliverHeld(sessionId).catch((error) => {
      state.redeliverError = String(error && error.message ? error.message : error)
      save()
    })
  }

  /** 守卫监听器每被调用一次记一笔——用来判断它到底看得到哪些会话。 */
  function notePreStep(sessionId) {
    if (!sessionId) return
    if (state.preStep === undefined) state.preStep = {}
    state.preStep[sessionId] = (state.preStep[sessionId] ?? 0) + 1
  }

  const preStepCounts = () => clone(state.preStep ?? {})

  /** 守卫真的否决了一次（而不只是被调用）。 */
  function noteReject(sessionId) {
    if (!sessionId) return
    if (state.rejects === undefined) state.rejects = {}
    state.rejects[sessionId] = (state.rejects[sessionId] ?? 0) + 1
    save()
  }

  const rejectCounts = () => clone(state.rejects ?? {})

  const isLatched = (sessionId) => state.latched[sessionId] !== undefined

  function writeHandoffDoc(request) {
    const dir = path.join(home, 'handoffs')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${request.id}.md`)
    const lines = [
      `# 交接单 · ${request.job}`,
      '',
      `- 申请：${request.id}`,
      `- 旧会话：${request.from}`,
      `- 新会话：待批准`,
      `- 岗位：${request.job}`,
      `- 目标：${request.summary}`,
      `- 原因：${request.reason || '（未填写）'}`,
      `- 已完成：${(request.completed ?? []).join('；') || '完成当前回合'}`,
      `- 产物路径：${(request.artifacts ?? []).join('；') || '（未填写）'}`,
      `- 下一步：${(request.next ?? []).join('；') || '继续任务'}`,
      `- 建议强度：${request.effort}`,
      `- 上下文：${request.contextLine ?? '（未取到：会话还没跑过模型轮）'}`,
      '',
      '> 交接单必须自包含：新会话看不到旧对话。',
      '',
    ]
    fs.writeFileSync(file, lines.join('\n'), 'utf8')
    return file
  }

  async function requestHandoff({ from, job, summary, completed = [], artifacts = [], next = [], effort = 'high', reason }) {
    const role = roleOf(from)
    // worker 交接岗位；leader 也能给**自己**提继任申请（否则它只能"建议用户"，交接永远是手动的）。
    const isLeader = from === state.leader && role === 'leader'
    if (role !== 'worker' && !isLeader) throw new Error('只有 worker（或 leader 给自己）能发起交接申请')
    if (!summary) throw new Error('summary 必填：一句话说明为什么交接')
    if (state.handoffs === undefined) state.handoffs = {}
    // 同一会话已经有挂起的交接单 → **更新它**，不新建。
    // 否则"要求补充"之后再交一次会变成两张单子，leader 还得猜哪张是新的。
    const existing = Object.values(state.handoffs).find((item) => item.from === from && item.status === 'pending')
    const request = existing ?? {
      id: `h-${Date.now().toString(36)}`,
      from,
      status: 'pending',
      requestedAt: new Date().toISOString(),
      revisions: [],
    }
    Object.assign(request, {
      job: isLeader ? 'leader' : job ?? state.sessions[from]?.job ?? 'worker',
      summary,
      reason: reason ?? '',
      effort,
      completed,
      artifacts,
      next,
    })
    if (existing !== undefined) {
      request.revisions.push({ at: new Date().toISOString(), summary })
      if (request.revisions.length > 20) request.revisions = request.revisions.slice(-20)
      delete request.infoRequested
      request.updatedAt = new Date().toISOString()
    }
    // 把真实上下文用量写进单子：leader 不用再问"为什么现在交接"，也不用自己核对。
    const context = await contextReport(from)
    request.contextUsage = context
    request.contextLine = context.available
      ? `${context.used} / ${context.window}（${context.percent}%，${context.band}）`
      : `（${context.reason ?? 'unavailable'}）`
    request.docPath = writeHandoffDoc(request)
    state.handoffs[request.id] = request
    latch(from, request.id)
    save()
    if (isLeader) {
      // 自己的继任申请没有"上一级 leader"可通知：去处就是面板待办（工具返回值已经告诉它登记成功）。
      // 例外：给旧 leader 自己留一条系统提示，避免它以为申请没提交而重复提交。
      try {
        await postSystem({
          to: from,
          kind: 'roster-update',
          summary: `继任申请已登记：${request.job}`,
          body: `交接单：${request.docPath}\n等用户批准后新 leader 上任、你这个会话归档。不要重复提交，也不要在等待期间接大活。`,
          mode: 'inject',
        })
      } catch (error) {
        request.notifyError = String(error && error.message ? error.message : error)
        save()
      }
    } else {
      await post({
        from,
        to: 'leader',
        kind: 'handoff-request',
        summary: existing === undefined ? `交接申请：${request.job}` : `交接单已补充：${request.job}`,
        body: `交接单：${request.docPath}\n\n${summary}`,
      })
    }
    return clone(request)
  }

  /**
   * 要求补充（charter §6 的第三条路径）：申请**保持挂起**，只把"缺什么"回给申请方。
   *
   * 关键的一步是 `unlatch`：上闩守卫会否决 worker 的下一步，不放行它就没法补单子。
   * 但解除上闩后它理论上可以继续干活 —— 所以消息里只要求它补单子，
   * 并且它再交一次会**更新同一张单子**（见 requestHandoff 的 existing 分支）。
   */
  async function requestHandoffInfo(requestId, { note, by = 'leader' } = {}) {
    const request = state.handoffs?.[requestId]
    if (request === undefined) throw new Error(`未知交接申请: ${requestId}`)
    if (request.status !== 'pending') throw new Error(`申请不是待批状态: ${request.status}`)
    const text = String(note ?? '').trim()
    if (!text) throw new Error('note 必填：说清楚要补什么')
    const at = new Date().toISOString()
    request.infoRequested = { at, by, note: text }
    if (request.infoLog === undefined) request.infoLog = []
    request.infoLog.push({ at, by, note: text })
    save()
    unlatch(request.from)
    try {
      await postSystem({
        to: request.from,
        kind: 'question',
        summary: `交接单要补充：${request.job}`,
        body:
          `审批方（${by === 'user' ? '用户' : 'leader'}）要求补充交接单：\n\n${text}\n\n` +
          `补齐后重新调用 team_handoff_request：它会更新这一张单子（${request.id}），不会新建；` +
          '交完会重新上闩。在这之前不要再开新活，也不要继续原任务。',
      })
    } catch (error) {
      request.notifyError = String(error && error.message ? error.message : error)
      save()
    }
    return clone(request)
  }

  /** 批准：建继任会话 → 更新岗位表 → 投递交接单 → 归档旧会话。leader 的继任申请只能由用户批。 */
  async function approveHandoff(requestId, approvedBy = 'leader') {
    const request = state.handoffs?.[requestId]
    if (request === undefined) throw new Error(`未知交接申请: ${requestId}`)
    if (request.status !== 'pending') throw new Error(`申请不是待批状态: ${request.status}`)
    const isLeaderHandoff = request.from === state.leader
    if (isLeaderHandoff) {
      // 自己的继任申请不能自己批 —— 那等于自说自话地换人。
      if (approvedBy !== 'user') throw new Error('leader 的继任申请必须由用户批准（leader 不能批准自己的继任）')
    } else if (approvedBy === 'user' && leaderState().available) {
      // 用户只在 leader 不可用时接管 worker 的交接审批（用户 2026-11-21 决定）。
      throw new Error('leader 在线：交接申请应由 leader 批准，用户只在其不可用时才代批')
    }
    const preset = isLeaderHandoff ? 'agent-team' : 'agent-team-worker'
    const workspace_ = await workspace()
    const sessionId = await createSessionWithUniqueId({
      workspaceId: workspace_.id,
      agentPreset: preset,
      make: () => (isLeaderHandoff ? nextLeaderId() : nextWorkerId(request.job)),
    })
    const renameError = await nameSession(sessionId, sessionTitleFor(isLeaderHandoff ? 'leader' : request.job, `接手 ${request.summary}`))
    if (isLeaderHandoff) {
      const at = new Date().toISOString()
      state.sessions[sessionId] = {
        role: 'leader',
        job: 'leader',
        title: '团队 leader',
        preset,
        status: 'active',
        generation: state.generation,
        createdAt: at,
        createdBy: approvedBy,
        requestId,
        ...(renameError === null ? {} : { renameError }),
      }
      const previous = state.leader
      state.leader = sessionId
      if (state.sessions[previous] !== undefined) {
        state.sessions[previous] = { ...state.sessions[previous], status: 'archived', replacedBy: sessionId, replacedAt: at }
      }
      state.leaderHistory.push({ at, by: approvedBy, from: previous, to: sessionId, reason: 'leader-handoff' })
      if (state.leaderHistory.length > 50) state.leaderHistory = state.leaderHistory.slice(-50)
    } else {
      registerWorker({ sessionId, job: request.job, title: request.job, preset, createdBy: approvedBy, requestId })
      if (state.sessions[sessionId] !== undefined && renameError !== null) state.sessions[sessionId].renameError = renameError
      if (state.sessions[request.from] !== undefined) {
        state.sessions[request.from] = { ...state.sessions[request.from], status: 'archived', replacedBy: sessionId }
      }
    }
    request.status = 'approved'
    request.decidedBy = approvedBy
    request.decidedAt = new Date().toISOString()
    request.successor = sessionId
    save()
    const handoffBody = `你是这个岗位的继任会话。先读交接单再继续：${request.docPath}`
    if (isLeaderHandoff) {
      // 新 leader 由系统署名交付（旧 leader 即将归档，不能冒充它发言）。
      await postSystem({
        to: sessionId,
        kind: 'task',
        summary: '接手：团队 leader',
        body: `${handoffBody}\n你是这个团队的新 leader：先读交接单，再用 team_roster 看岗位表与待批申请。旧 leader 会被归档。`,
      })
    } else if (leaderState().available) {
      await post({
        from: state.leader,
        to: sessionId,
        kind: 'task',
        summary: `接手：${request.job}`,
        body: handoffBody,
      })
    } else {
      // leader 不在线时这条「接手」是用户代批产生的，署名给系统，别冒充已归档的 leader。
      await postSystem({
        to: sessionId,
        kind: 'task',
        summary: `接手：${request.job}`,
        body: `${handoffBody}\n这张交接单由用户代批（当时的 leader 不在线）。`,
      })
    }
    try {
      await ctx.workspaceRegistry.archiveSession(request.from, { stopActivity: true })
    } catch (error) {
      request.archiveError = String(error && error.message ? error.message : error)
    }
    unlatch(request.from)
    save()
    return { successor: sessionId, archived: request.from, doc: request.docPath }
  }

  /** 用户/leader 拒绝：不建会话，旧会话解除上闩、继续工作。 */
  async function rejectHandoff(requestId, reason) {
    const request = state.handoffs?.[requestId]
    if (request === undefined) throw new Error(`未知交接申请: ${requestId}`)
    if (request.status !== 'pending') throw new Error(`申请不是待批状态: ${request.status}`)
    request.status = 'rejected'
    request.decidedAt = new Date().toISOString()
    if (reason !== undefined) request.reason2 = reason
    unlatch(request.from)
    save()
    // 让被拒绝的 worker 知道自己被放行、继续干活（它刚才是上闩状态）。
    try {
      await postSystem({
        to: request.from,
        kind: 'notice',
        summary: '交接申请被拒绝：继续当前会话',
        body: reason ? `原因：${reason}` : '申请被拒绝，上闩已解除，继续你的任务。',
      })
    } catch (error) {
      request.notifyError = String(error && error.message ? error.message : error)
      save()
    }
    return clone(request)
  }

  /**
   * 批量归档/恢复会话（清场用）。只从本机接口调用，模型没有工具能碰它。
   * 归档是可逆的：数据仍在，只是不再出现在活跃列表里。
   */
  async function setArchived({ ids, prefix, keep = [], archive = true }) {
    const registry = ctx.workspaceRegistry
    // 安全阀：**绝不归档正在跑的会话**。archiveSession 带 stopActivity 会打断在跑的回合，
    // 2026-11-21 就因为没这道判断，把调用方自己（会话 id 也以 at- 开头）归档并掐断了。
    //
    // 1.7.1 修正：以前只要 agent 被实例化过就跳过（`!== undefined`），于是"刚跑过、现在空闲"的会话
    // 永远归档不掉（2026-11-21 实测：清场时 3 个空闲会话全被跳过）。现在只跳过**正在跑**的。
    const running = (sessionId) => {
      try {
        const agent = ctx.get?.('agents')?.get?.(sessionId)
        return agent !== undefined && agent.status === 'running'
      } catch {
        return false
      }
    }
    let targets = Array.isArray(ids) && ids.length > 0 ? [...ids] : null
    if (targets === null) {
      targets = []
      if (archive) {
        // 从各工作区的活跃会话里挑（sessionIds 含已归档的，archiveSession 自身幂等）
        for (const workspace of registry.list?.() ?? []) {
          for (const id of workspace.sessionIds ?? []) targets.push(id)
        }
      } else {
        targets = [...(registry.archivedSessionIds ?? [])]
      }
    }
    const done = []
    const failed = []
    const skippedLive = []
    for (const id of [...new Set(targets)]) {
      if (keep.includes(id)) continue
      if (typeof prefix === 'string' && prefix.length > 0 && !String(id).startsWith(prefix)) continue
      if (running(id)) {
        skippedLive.push(id)
        continue
      }
      try {
        if (archive) await registry.archiveSession(id, { stopActivity: true })
        else await registry.unarchiveSession(id)
        done.push(id)
        // 岗位表立刻改口：不然面板会一直显示"活跃"，用户得自己发现（2026-11-21 报的问题）。
        const entry = state.sessions[id]
        if (entry !== undefined) {
          if (archive && entry.status === 'active') state.sessions[id] = { ...entry, status: 'archived', archivedAt: new Date().toISOString() }
          if (!archive && entry.status === 'archived') state.sessions[id] = { ...entry, status: 'active', unarchivedAt: new Date().toISOString() }
        }
      } catch (error) {
        failed.push({ id, error: String(error && error.message ? error.message : error) })
      }
    }
    save()
    // leader 若在刚归档的那批里，席位要一起让出来（并对齐收件人状态）。
    const reconciled = reconcileArchived()
    return { archive, count: done.length, done, failed, skippedLive, reconciled }
  }

  /**
   * 面板 `/agent-team/state` 的整份响应。
   *
   * 为什么放在 store 里而不是 HTTP 处理器里：它就是"这个团队此刻长什么样"的投影。
   * 第 1 步只有一个 store；第 2 步起每个工作区各有一份，处理器只负责挑拿哪一份。
   */
  function panelState() {
    return {
      // 这份投影属于哪个工作区：面板据此高亮下拉当前项，验收据此判断"?workspace= 真的换了 store"。
      workspace: root,
      ...snapshot(),
      leaderStatus: leaderState(),
      // 最近一次"leader 卸任"（归档导致席位空出）——面板据此在**不点开**的情况下提示。
      leaderReleased: clone(
        [...state.leaderHistory].reverse().find((entry) => entry.to === null || entry.to === undefined) ?? null,
      ),
      leaderHistory: clone(state.leaderHistory.slice(-5)),
      // 消息总量（含没被 rows 带出来的那些）：面板据此决定还要不要「加载更早」
      totalMessages: state.messages.length,
      retention: {
        keep: retention.keep,
        ceiling: retention.ceiling,
        archivedMessages: (state.pruneLog ?? []).reduce((sum, entry) => sum + (entry.count ?? 0), 0),
      },
      pending: pendingActions(),
      rows: messages({ limit: 100 }),
    }
  }

  // ---- 服务导出 -------------------------------------------------------------

  const api = {
    root,
    charter: () => ({ spawnAuthority: authority(), effortPolicy: clone(charter.effortPolicy) }),
    authority: snapshotAuthority,
    setAuthority,
    resetTeam,
    setArchived,
    spawnLog: () => clone(state.spawnLog).slice(-50),
    snapshot,
    roster,
    directory,
    messages,
    activity,
    // 会话状态（1.10.0）：读状态只走 live agent，绝不唤醒会话
    statusReport,
    queueSnapshot,
    // 上下文用量与交接建议（数据，不是感觉）
    contextReport,
    contextPolicy: () => ({ ...contextPolicy }),
    // 保留策略：默认干跑，真跑走面板/本机 HTTP
    pruneMessages,
    retention: () => ({
      keep: retention.keep,
      ceiling: retention.ceiling,
      size: state.messages.length,
      archivedMessages: (state.pruneLog ?? []).reduce((sum, entry) => sum + (entry.count ?? 0), 0),
      history: clone((state.pruneLog ?? []).slice(-5)),
      error: state.retentionError ?? null,
    }),
    roleOf,
    isLeader: (sessionId) => state.leader === sessionId,
    claimLeader,
    promoteLeader,
    leaderHistory: () => clone(state.leaderHistory.slice(-20)),
    resolveRecipients,
    post,
    spawnWorker,
    requestSpawn,
    rejectSpawn,
    pendingActions,
    // 交接
    requestHandoff,
    requestHandoffInfo,
    approveHandoff,
    rejectHandoff,
    leaderState,
    pendingHandoffs: () => clone(Object.values(state.handoffs ?? {}).filter((r) => r.status === 'pending')),
    // 上闩（供 preset 作用域的 pre-step 守卫查询）
    latch,
    unlatch,
    isLatched,
    notePreStep,
    preStepCounts,
    noteReject,
    rejectCounts,
    pendingSpawns: () => clone(Object.values(state.spawnRequests).filter((r) => r.status === 'pending')),
    approveSpawn,
  }

  // ---- 工厂出口 -------------------------------------------------------------
  return {
    root,
    api,
    state: () => state,
    findMessage: (id) => state.messages.find((item) => item.id === id),
    panelState,
    reconcileArchived,
  }
}

export function apply(ctx, config = {}) {
  /**
   * 默认工作区：配置里给了就用配置；没给就用**注册表里的第一个工作区**
   * （DSH 的默认工作区通常排在最前），再没有才退回进程 cwd。
   * 这样"装上就能用"，而不会把某个人的绝对路径带进别人的机器。
   */
  const defaultRoot = resolveDefaultRoot(config)
    ?? ctx.workspaceRegistry.list()[0]?.path
    ?? process.cwd()

  /**
   * store 缓存：一个工作区一份（第 2 步起会有第二个 key）。
   *
   * 键是 `pathKey()`：resolve + Windows 下转小写 —— 同一个目录不能有两份 store，
   * 否则 `?workspace=` 的两种写法会各建一份，两个写者抢同一批文件。
   */
  const stores = new Map()
  function teamFor(root) {
    const key = pathKey(root)
    let store = stores.get(key)
    if (store === undefined) {
      // onChange 用箭头延迟取值：scheduleNotify 在下面才声明（函数声明会提升，这里只是别让它太隐晦）。
      store = createTeamStore(path.resolve(root), { ctx, config, onChange: () => scheduleNotify() })
      stores.set(key, store)
    }
    return store
  }

  /**
   * 别的工作区的 store.json **只读**看一样（面板下拉的小圆点用）。
   *
   * 为什么不在这些工作区上 `teamFor(...)`：那会给每个工作区 mkdir 一个 `.team/`。
   * 只是为了画一个小圆点就往别人的项目目录里建东西，不可接受。
   * 按 mtime+size 缓存：面板每 3–10 秒轮询一次，不能每次都把几 MB 的 store.json 重新解析。
   */
  const peekCache = new Map()
  function peekStore(root) {
    const key = pathKey(root)
    const file = path.join(root, '.team', 'store.json')
    let stamp
    try {
      const stat = fs.statSync(file)
      stamp = `${stat.mtimeMs}:${stat.size}`
    } catch {
      peekCache.delete(key)
      return undefined
    }
    const cached = peekCache.get(key)
    if (cached !== undefined && cached.stamp === stamp) return cached.store
    try {
      const store = JSON.parse(fs.readFileSync(file, 'utf8'))
      peekCache.set(key, { stamp, store })
      return store
    } catch {
      // 半截文件（正在写）就当没有：下一轮 mtime 变了会重读。
      return undefined
    }
  }

  /**
   * 面板工作区下拉的数据源：注册表里每个工作区 + 它那份团队的待办条数。
   *
   * `hasTeam` 区分"还没人用过的工作区"和"已经有团队的工作区"：面板暂时只用 `pending` 画圆点，
   * 但把 `hasTeam` 一起回给前端（第 4 步写文档/将来灰掉空工作区都用得上）。
   * 当前工作区走内存里的 live store，别的工作区走只读 peek，两者用同一个 `pendingCountOf` 口径。
   */
  function workspaceList() {
    return ctx.workspaceRegistry.list().map((workspace) => {
      const live = stores.get(pathKey(workspace.path))
      const peeked = live === undefined ? peekStore(workspace.path) : undefined
      return {
        id: workspace.id,
        path: workspace.path,
        title: workspace.title,
        default: pathKey(workspace.path) === pathKey(defaultRoot),
        sessions: workspace.sessionIds.length,
        hasTeam: live !== undefined || peeked !== undefined,
        pending: live !== undefined ? live.api.pendingActions().length : pendingCountOf(peeked),
      }
    })
  }

  /**
   * `?workspace=<绝对路径>` → 注册表里的工作区。
   *
   * 只认**已注册**的工作区：面板传个陌生路径过来就报错，而不是在别人的目录里
   * 悄悄 mkdir 一个 `.team/`。找不到返回 undefined，由调用方决定是 400 还是回落。
   */
  function workspaceByPath(target) {
    if (typeof target !== 'string' || target.trim() === '') return undefined
    const key = pathKey(target)
    return ctx.workspaceRegistry.list().find((candidate) => pathKey(candidate.path) === key)
  }

  const defaultStore = teamFor(defaultRoot)

  /**
   * `ctx.agentTeam`：默认工作区那份 api 的直接投影 + 两个按工作区取 api 的入口。
   *
   * 为什么还要把默认 api 平铺在上面：单工作区（配置里只有 workspaceRoot）的行为必须
   * 与 1.8.0 完全一致 —— 老调用方 `ctx.agentTeam.roster()` 照旧可用；工具层则改用
   * `forSession(...)`，拿自己所在团队的那份。
   */
  const service = {
    ...defaultStore.api,
    /**
     * 工具层用：调用方会话所在工作区的那份 api。
     *
     * 会话没挂任何工作区（理论上只有手工造的）时回落默认 root —— 与 1.8.0 行为一致。
     */
    forSession: (sessionId) => teamFor(owningWorkspace(ctx, sessionId)?.path ?? defaultRoot).api,
    /** 面板/验收用：按工作区路径取。未知路径一律抛错（不要 fallback，免得查错团队还看不出来）。 */
    forWorkspace: (target) => {
      const workspace = workspaceByPath(target)
      if (workspace === undefined) throw new Error(`未知工作区: ${target}`)
      return teamFor(workspace.path).api
    },
  }

  ctx.provide('agentTeam', service)

  // ---- HTTP：面板与用户代批用（P3 前端），模型调不到 --------------------------

  const loopback = (req) => {
    const address = req.socket?.remoteAddress ?? ''
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  }

  const json = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(value))
  }

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })

  // ---- SSE：面板订阅（3 秒轮询退为兜底） --------------------------------------
  //
  // 只推「store 变了」这一个事实，不推内容：面板收到就重新拉 /state。
  // 这样面板和审计读的是同一份投影，不会出现"推送里的数字和列表对不上"。
  const subscribers = new Set()
  let subscriberSeq = 0
  let notifyTimer = null

  function notifySubscribers() {
    if (subscribers.size === 0) return
    subscriberSeq += 1
    const frame = `event: team\ndata: ${JSON.stringify({ seq: subscriberSeq, at: new Date().toISOString() })}\n\n`
    for (const res of subscribers) {
      try {
        res.write(frame)
      } catch {
        subscribers.delete(res)
      }
    }
  }

  /** 合并短时间内的多次写盘（一台机器上 save() 可能连着触发好几回）。 */
  function scheduleNotify() {
    if (subscribers.size === 0 || notifyTimer !== null) return
    notifyTimer = setTimeout(() => {
      notifyTimer = null
      notifySubscribers()
    }, 120)
  }

  function streamEvents(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write('retry: 3000\n\n')
    res.write(`event: ready\ndata: ${JSON.stringify({ seq: subscriberSeq })}\n\n`)
    subscribers.add(res)
    // 心跳防中间层掐连接（25 秒一次注释帧，不算事件）。
    const beat = setInterval(() => {
      try {
        res.write(': ping\n\n')
      } catch { /* 写不进去就等 close 收尾 */ }
    }, 25_000)
    const done = () => {
      clearInterval(beat)
      subscribers.delete(res)
    }
    req.on('close', done)
    res.on('close', done)
    res.on('error', done)
  }

  /**
   * 这次请求看哪个团队的 store。
   *
   * `?workspace=<绝对路径>` → 那个工作区的团队；不带（或空串）→ 配置里的默认工作区，
   * 于是单工作区的面板行为与 1.8.0 完全一致。未知路径返回 undefined，由 handler 回 400。
   */
  const storeForRequest = (url) => {
    const wanted = url.searchParams.get('workspace')
    if (wanted === null || wanted.trim() === '') return defaultStore
    const workspace = workspaceByPath(wanted)
    return workspace === undefined ? undefined : teamFor(workspace.path)
  }

  const handler = async (req, res) => {
    try {
      if (!loopback(req)) return json(res, 403, { error: 'loopback only' })
      const url = new URL(req.url ?? '/', 'http://localhost')
      const store = storeForRequest(url)
      if (store === undefined) return json(res, 400, { error: `未知工作区: ${url.searchParams.get('workspace')}` })
      const api = store.api
      // 读之前先对账：宿主里被归档的会话，我方 store 要及时改口（否则面板一直显示旧的"活跃"）。
      if (req.method === 'GET') store.reconcileArchived()
      if (url.pathname === '/agent-team/events' && req.method === 'GET') return streamEvents(req, res)
      if (url.pathname === '/agent-team/state' && req.method === 'GET') return json(res, 200, store.panelState())
      // 工作区下拉（第 3 步）：列表 + 各自待办数。**不需要** `?workspace=` —— 它本来就是选工作区用的。
      if (url.pathname === '/agent-team/workspaces' && req.method === 'GET') {
        return json(res, 200, { default: defaultRoot, workspaces: workspaceList() })
      }
      // 临时诊断（2026-11-21）：桌面上"点下拉没反应"，而我看不到用户的屏幕 ——
      // 面板把页面里的 pointerdown 事实 POST 到这里，落成 <ws>/.team/client-diag.jsonl。
      // 定位完就删。只 loopback、只追加、路径固定在本工作区的 .team/ 下。
      if (url.pathname === '/agent-team/diag' && req.method === 'POST') {
        const payload = JSON.parse((await readBody(req)) || '{}')
        const file = path.join(store.root, '.team', 'client-diag.jsonl')
        fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), workspace: store.root, ...payload }) + '\n', 'utf8')
        return json(res, 200, { ok: true })
      }
      if (url.pathname === '/agent-team/roster' && req.method === 'GET') return json(res, 200, api.roster())
      if (url.pathname === '/agent-team/messages' && req.method === 'GET') {
        return json(res, 200, api.messages({
          limit: Number(url.searchParams.get('limit') ?? 100),
          since: url.searchParams.get('since') ?? undefined,
          before: url.searchParams.get('before') ?? undefined,
        }))
      }
      if (url.pathname === '/agent-team/activity' && req.method === 'GET') return json(res, 200, api.activity())
      if (url.pathname === '/agent-team/authority' && req.method === 'GET') return json(res, 200, api.authority())
      if (url.pathname === '/agent-team/authority' && req.method === 'POST') {
        const payload = JSON.parse((await readBody(req)) || '{}')
        return json(res, 200, api.setAuthority(payload.authority, payload.by ?? 'panel'))
      }
      if (url.pathname === '/agent-team/admin/reset' && req.method === 'POST') {
        const payload = JSON.parse((await readBody(req)) || '{}')
        if (payload.confirm !== 'RESET') return json(res, 400, { error: 'confirm 必须是 "RESET"' })
        return json(res, 200, api.resetTeam())
      }
      if (url.pathname === '/agent-team/admin/promote-leader' && req.method === 'POST') {
        const payload = JSON.parse((await readBody(req)) || '{}')
        if (payload.confirm !== 'PROMOTE') return json(res, 400, { error: 'confirm 必须是 "PROMOTE"' })
        return json(res, 200, await api.promoteLeader({ sessionId: payload.sessionId, reason: payload.reason, by: 'panel' }))
      }
      if (url.pathname === '/agent-team/admin/prune' && req.method === 'POST') {
        const payload = JSON.parse((await readBody(req)) || '{}')
        // 默认干跑：不带 confirm 只回计划，不写文件、不动 store。
        if (payload.dryRun === undefined) payload.dryRun = payload.confirm !== 'PRUNE'
        if (payload.dryRun !== true && payload.confirm !== 'PRUNE') {
          return json(res, 400, { error: '真跑必须带 confirm: "PRUNE"；只想看计划就传 dryRun: true' })
        }
        return json(res, 200, api.pruneMessages({ keep: payload.keep, dryRun: payload.dryRun === true }))
      }
      if (url.pathname === '/agent-team/admin/archive-sessions' && req.method === 'POST') {
        const payload = JSON.parse((await readBody(req)) || '{}')
        if (payload.confirm !== 'ARCHIVE') return json(res, 400, { error: 'confirm 必须是 "ARCHIVE"' })
        return json(res, 200, await api.setArchived({ ids: payload.ids, prefix: payload.prefix, keep: payload.keep ?? [], archive: true }))
      }
      if (url.pathname === '/agent-team/admin/unarchive-sessions' && req.method === 'POST') {
        const payload = JSON.parse((await readBody(req)) || '{}')
        if (payload.confirm !== 'ARCHIVE') return json(res, 400, { error: 'confirm 必须是 "ARCHIVE"' })
        return json(res, 200, await api.setArchived({ ids: payload.ids, prefix: payload.prefix, keep: payload.keep ?? [], archive: false }))
      }
      if (url.pathname === '/agent-team/body' && req.method === 'GET') {
        const id = url.searchParams.get('id') ?? ''
        const message = store.findMessage(id)
        if (message === undefined) return json(res, 404, { error: 'not found' })
        try {
          const text = fs.readFileSync(message.bodyPath, 'utf8')
          res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' })
          res.end(text)
        } catch (error) {
          return json(res, 404, { error: String(error && error.message ? error.message : error) })
        }
        return
      }
      if (url.pathname === '/agent-team/approve' && req.method === 'POST') {
        const payload = JSON.parse((await readBody(req)) || '{}')
        const id = String(payload.requestId ?? '')
        const result = id.startsWith('h-') ? await api.approveHandoff(id, 'user') : await api.approveSpawn(id)
        return json(res, 200, result)
      }
      if (url.pathname === '/agent-team/reject' && req.method === 'POST') {
        const payload = JSON.parse((await readBody(req)) || '{}')
        const id = String(payload.requestId ?? '')
        const result = id.startsWith('h-') ? await api.rejectHandoff(id, payload.reason) : await api.rejectSpawn(id, payload.reason)
        return json(res, 200, result)
      }
      if (url.pathname === '/agent-team/more-info' && req.method === 'POST') {
        const payload = JSON.parse((await readBody(req)) || '{}')
        return json(res, 200, await api.requestHandoffInfo(String(payload.requestId ?? ''), { note: payload.note, by: 'user' }))
      }
      return json(res, 404, { error: 'not found' })
    } catch (error) {
      return json(res, 500, { error: String(error && error.message ? error.message : error) })
    }
  }

  ctx.inject(['webServer'], (child) => {
    child.effect(() => {
      const dispose = child.webServer.register({ kind: 'prefix', path: '/agent-team', handler })
      return () => {
        if (typeof dispose === 'function') dispose()
        if (notifyTimer !== null) clearTimeout(notifyTimer)
        notifyTimer = null
        for (const res of subscribers) {
          try {
            res.end()
          } catch { /* 已经断了 */ }
        }
        subscribers.clear()
      }
    })
  })

  // 没有任何自动运行：本插件启动时只读写自己的 store，不建会话、不发消息。
}
