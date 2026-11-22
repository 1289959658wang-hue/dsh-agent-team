#!/usr/bin/env node
// test-delivery-visibility.mjs — 1.10.0 的验收（规格：docs/delivery-visibility.md §8）。
//
// 三条纪律：
//   1. **不碰真实 `.team/`**：store 建在 `os.tmpdir()` 下，跑完删掉；
//   2. **不建真会话**：假 Agent 按 0.2.2-rc.5 的真实语义改 inbox ——
//      followup → next-turn + 唤醒；steer → next-step + 唤醒；inject → next-step + **不唤醒**；
//   3. **读状态不许唤醒会话**：第 10 条断言假 `resolveAgent` 的调用次数一次都没涨。
//
// 判据：逐条打印 PASS/FAIL，失败 exit 1。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTeamStore, deliveryVerdict, readQueue, deliveryHint, statusHint, formatWait, deliveryReceipt } from '../agent-team/index.js'
import { apply as applyTools } from '../agent-team/tools.js'

const LEADER = 'at-lead-test'

// ---- 假 DSH 环境 ------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'at-delivery-'))
const root = path.join(tmp, 'ws')
fs.mkdirSync(root, { recursive: true })

/** live agent 表：`ctx.agents.get()` 只认这里；`sessionController.create` 才会往里加。 */
const agents = new Map()
let resolveAgentCalls = 0
/** 读会话日志的次数：`statusReport` 对未挂载会话不许碰它（不拉起、也不为看一眼读日志）。 */
let eventsCalls = 0

/** 假 Agent：`status` + `inbox.nextTurn/nextStep` + 三个投递方法（按真实语义）。 */
function fakeAgent(sessionId, { status = 'idle' } = {}) {
  return {
    id: sessionId,
    status,
    inbox: { nextTurn: [], nextStep: [] },
    followup(message) {
      this.inbox.nextTurn.push(message)
      this.status = 'running'
    },
    steer(message) {
      this.inbox.nextStep.push(message)
      this.status = 'running'
    },
    inject(message) {
      // 真实语义：进 next-step，但**不唤醒**（空闲会话会一直停在 inbox）。
      this.inbox.nextStep.push(message)
    },
  }
}

const workspace = { id: 'ws-1', path: root, title: 'tmp', sessionIds: [LEADER] }

const ctx = {
  sessionController: {
    async resolveAgent(sessionId) {
      resolveAgentCalls += 1
      const agent = agents.get(sessionId)
      return agent === undefined ? { error: { code: 'session/not-found' } } : { agent }
    },
    async create({ sessionId }) {
      // 建会话 = 得到一个 live agent（与真实语义一致：新会话是挂载着的）。
      agents.set(sessionId, fakeAgent(sessionId))
      return { sessionId }
    },
    async rename() {
      return {}
    },
    async selectModel() {
      return { selected: { reasoningEffort: 'high' } }
    },
    async events({ address }) {
      eventsCalls += 1
      // 读日志：没挂载的会话读不到 usage（与"未运行、没有在途消息"一致）。
      if (!agents.has(address?.sessionId)) return { records: [] }
      return {
        records: [{ event: { type: 'assistant/message', time: Date.now(), data: { usage: { inputTokens: 40000, cacheReadTokens: 8000 } } } }],
      }
    },
  },
  workspaceRegistry: {
    list: () => [workspace],
    archivedSessionIds: [],
    async archiveSession() {},
    async unarchiveSession() {},
    async resolveByPath() {
      return workspace
    },
    async create(p, title) {
      return { id: 'ws-1', path: p, title }
    },
  },
  agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test-model' }) },
  // 规格 §3：读状态只走 `ctx.agents.get`（不提供 resolveAgent 的旁路）。
  agents: { get: (sessionId) => agents.get(sessionId) },
  get: (name) => (name === 'agents' ? { get: (sessionId) => agents.get(sessionId) } : undefined),
}

const store = createTeamStore(root, { ctx, config: { workspaceRoot: root } })
const api = store.api
api.claimLeader(LEADER)
// leader 自己也是挂载着的会话（T9 的 team_report 要投给它）。
agents.set(LEADER, fakeAgent(LEADER, { status: 'running' }))

/** 建一个 worker 会话（走真实的 spawnWorker 路径：create → rename → register → 投第一条任务）。 */
async function spawnWorker(job) {
  const spawned = await api.spawnWorker({ job, title: `岗位 ${job}`, task: `任务：${job}`, requestedBy: LEADER })
  return spawned
}

/** 轮询到条件成立（`unlatch` 的补投是 `void` 异步的，不能假定下一行就完成）。 */
async function waitFor(predicate, { timeout = 3000, interval = 20 } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  return predicate()
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}
const equal = (actual, expected, label) => {
  if (actual !== expected) throw new Error(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

/** 假 tools 作用域：收集 `ctx.tools.register` 的产物，`effect(fn)` 立刻执行。 */
function toolsHarness(role) {
  const tools = new Map()
  const toolsCtx = {
    agentTeam: { forSession: () => api },
    tools: { register: (spec) => tools.set(spec.name, spec) },
    effect: (fn) => {
      fn()
      return () => {}
    },
    on: () => () => {},
  }
  applyTools(toolsCtx, { role })
  return tools
}

const leaderTools = toolsHarness('leader')
const workerTools = toolsHarness('worker')
const callTool = (tools, name, args, sessionId) => tools.get(name).execute(args, { agent: { id: sessionId } })

// ---- 断言清单（顺序即 §8 的 1..10） ----------------------------------------

const cases = []
const test = (label, fn) => cases.push({ label, fn })

let workerA
let workerB
let workerC
let workerD
let workerE
let workerF
let workerG
let workerI
let queuedReceipt
let firstTaskReceipt

test('[0] 纯函数表：§5.1 的九行判定 + readQueue 的容错', async () => {
  equal(deliveryVerdict({ mode: 'queue', status: 'idle' }), 'woken-now', 'queue+idle')
  equal(deliveryVerdict({ mode: 'queue', status: 'running' }), 'queued-turn', 'queue+running')
  equal(deliveryVerdict({ mode: 'steer', status: 'running' }), 'steered-step', 'steer+running')
  equal(deliveryVerdict({ mode: 'steer', status: 'idle' }), 'woken-now', 'steer+idle')
  equal(deliveryVerdict({ mode: 'inject', status: 'running' }), 'injected-step', 'inject+running')
  equal(deliveryVerdict({ mode: 'inject', status: 'idle' }), 'parked-no-wake', 'inject+idle')
  equal(deliveryVerdict({ mode: 'queue', status: 'running', latched: true }), 'held', 'latched 优先')
  equal(deliveryVerdict({ mode: 'queue', status: 'running', failed: true }), 'failed', 'failed 优先')
  equal(deliveryVerdict({ mode: 'queue', status: 'running', reentrant: true }), 'pending-delivery', 'reentrant')
  // 容错：字段缺失按 0（不给 agent 也不炸）
  const empty = readQueue(undefined)
  equal(empty.status, 'not-live', 'readQueue(undefined).status')
  equal(empty.turn + empty.step, 0, 'readQueue(undefined) 队列为 0')
  equal(empty.teamTurn, 0, 'readQueue(undefined).teamTurn')
  const queued = deliveryHint({ outcome: 'queued-turn', ahead: 2, queue: { oldestWaitMs: 95000 } })
  assert(queued.includes('前面已有 2 条排队'), 'deliveryHint 写出 ahead')
  assert(queued.includes('最久 95 秒'), 'deliveryHint 写出等待时长')
  assert(queued.includes('先等回执'), 'deliveryHint 给出动作')
  const parked = deliveryHint({ outcome: 'parked-no-wake' })
  assert(parked.includes('直到有人唤醒'), 'deliveryHint 说明 inject 不会醒')
  // 文案必须可执行：team_post 没有 mode 参数，能改命的是 priority 与 kind。
  assert(parked.includes('priority: "urgent"'), `deliveryHint 给出可执行的改法（实际：${parked}）`)
  assert(parked.includes('走 queue'), 'deliveryHint 给出第二条可执行路径（换 kind）')
  assert(parked.includes('team_post（queue）') === false, 'deliveryHint 不再给不存在的 mode 参数')
  equal(statusHint({ archived: true }), '该会话已归档：不要再发任务；需要人就在 team_directory 里找接任者。', 'statusHint 归档优先')
})

test('[1] idle + queue → woken-now / ahead 0 / 发送后 running', async () => {
  const spawned = await spawnWorker('worker-a')
  workerA = spawned.sessionId
  const message = store.findMessage(spawned.messageId)
  const slot = message.delivery[0]
  equal(slot.outcome, 'woken-now', 'outcome')
  equal(slot.ahead, 0, 'ahead')
  equal(slot.targetStatus, 'idle', 'targetStatus')
  equal(agents.get(workerA).status, 'running', '发送后 status')
  firstTaskReceipt = message
})

test('[2] running + 已有 2 条 next-turn + queue → queued-turn / ahead 2 / nextTurn 3', async () => {
  const spawned = await spawnWorker('worker-b')
  workerB = spawned.sessionId
  equal(agents.get(workerB).status, 'running', 'spawn 后 running')
  equal(agents.get(workerB).inbox.nextTurn.length, 1, 'spawn 的任务已排队（1）')
  await api.post({ from: LEADER, to: workerB, kind: 'task', summary: '第二条', body: '' })
  equal(agents.get(workerB).inbox.nextTurn.length, 2, '第二条已排队（2）')
  queuedReceipt = await api.post({ from: LEADER, to: workerB, kind: 'task', summary: '第三条', body: '' })
  const slot = queuedReceipt.delivery[0]
  equal(slot.outcome, 'queued-turn', 'outcome')
  equal(slot.ahead, 2, 'ahead（发送前已有 2 条）')
  equal(slot.targetStatus, 'running', 'targetStatus')
  equal(agents.get(workerB).inbox.nextTurn.length, 3, '发送后 nextTurn')
})

test('[3] running + steer → steered-step / 落在 nextStep', async () => {
  const spawned = await spawnWorker('worker-c')
  workerC = spawned.sessionId
  const message = await api.post({ from: LEADER, to: workerC, kind: 'task', priority: 'urgent', summary: '紧急纠正', body: '' })
  const slot = message.delivery[0]
  equal(slot.mode, 'steer', 'mode')
  equal(slot.outcome, 'steered-step', 'outcome')
  equal(slot.state, 'delivered', 'state')
  equal(agents.get(workerC).inbox.nextStep.length, 1, 'nextStep 有一条')
})

test('[4] idle + inject → parked-no-wake / status 仍 idle / nextStep 1', async () => {
  const spawned = await spawnWorker('worker-d')
  workerD = spawned.sessionId
  // 模拟它把手上那轮跑完了：空闲、inbox 清空。
  const agent = agents.get(workerD)
  agent.status = 'idle'
  agent.inbox.nextTurn.length = 0
  const message = await api.post({ from: LEADER, to: workerD, kind: 'notice', summary: '旁听通知', body: '' })
  const slot = message.delivery[0]
  equal(slot.mode, 'inject', 'mode')
  equal(slot.outcome, 'parked-no-wake', 'outcome')
  equal(slot.state, 'injected', 'state（旧字段）')
  equal(agents.get(workerD).status, 'idle', 'inject 不唤醒：status 仍 idle')
  equal(agents.get(workerD).inbox.nextStep.length, 1, 'nextStep 有一条')
})

test('[5] 上闩 → held / error:latched；解闩后 redeliverHeld 补投成 delivered', async () => {
  const spawned = await spawnWorker('worker-e')
  workerE = spawned.sessionId
  api.latch(workerE, 'test')
  const message = await api.post({ from: LEADER, to: workerE, kind: 'task', summary: '上闩期间的消息', body: '' })
  const slot = message.delivery[0]
  equal(slot.state, 'held', 'state')
  equal(slot.error, 'latched', 'error')
  equal(slot.outcome, 'held', 'outcome')
  const before = agents.get(workerE).inbox.nextTurn.length
  equal(before, 1, '上闩期间没投进 inbox')
  api.unlatch(workerE)
  // 回执是 clone；补投改的是 store 里的 slot，所以要盯 store 的那一份。
  const stored = store.findMessage(message.id)
  const delivered = await waitFor(() => stored.delivery[0].state === 'delivered')
  assert(delivered, `解闩后仍是 ${stored.delivery[0].state}`)
  equal(stored.delivery[0].outcome === 'held', false, 'outcome 已更新（不再是 held）')
  equal(stored.delivery[0].error, undefined, 'error 已清掉')
  equal(agents.get(workerE).inbox.nextTurn.length, 2, '补投进了 nextTurn')
})

test('[6] statusReport(self)：inbox.total / messages[].from,kind,waitMs / delivery 计数', async () => {
  const spawned = await spawnWorker('worker-f')
  workerF = spawned.sessionId
  await api.post({ from: LEADER, to: workerF, kind: 'task', summary: '第二条任务', body: '' })
  const report = await api.statusReport(workerF, { viewer: workerF })
  equal(report.self, true, 'self')
  equal(report.session, workerF, 'session')
  equal(report.live, true, 'live')
  equal(report.status, 'running', 'status')
  equal(report.inbox.total, 2, 'inbox.total')
  equal(report.inbox.turn, 2, 'inbox.turn')
  equal(report.inbox.teamTurn, 2, 'inbox.teamTurn')
  equal(report.inbox.humanTurn, 0, 'inbox.humanTurn')
  equal(report.inbox.truncated, false, 'inbox.truncated')
  equal(report.inbox.messages.length, 2, 'messages 条数')
  for (const entry of report.inbox.messages) {
    equal(entry.from, LEADER, 'messages[].from')
    equal(entry.kind, 'task', 'messages[].kind')
    equal(entry.target, 'next-turn', 'messages[].target')
    assert(typeof entry.waitMs === 'number' && entry.waitMs >= 0, `messages[].waitMs 是数字（实际 ${entry.waitMs}）`)
    assert(typeof entry.summary === 'string' && entry.summary.length > 0, 'messages[].summary 从 store 反查到了')
  }
  equal(report.delivery.pending, 0, 'delivery.pending')
  equal(report.delivery.held, 0, 'delivery.held')
  equal(report.delivery.failed, 0, 'delivery.failed')
  equal(report.activity.sent, 0, 'activity.sent')
  equal(report.activity.received, 2, 'activity.received')
  assert(report.context !== null && report.context.available === true, '自己的 context 总是给')
  equal(report.context.used, 48000, 'context.used')
  assert(report.hint.startsWith('你有 2 条未处理'), `hint 说明欠账（实际：${report.hint}）`)
  assert(report.hint.includes(`来自 ${LEADER}`), `hint 里有发件人（实际：${report.hint}）`)
})

test('[7] team_status 工具：自己 / 队友 / leader 的 context 权限 / 团队外抛错', async () => {
  assert(workerTools.has('team_status') && leaderTools.has('team_status'), '两种角色都注册了 team_status')
  // worker 查自己 → 正常返回（"200"）
  const selfReport = await callTool(workerTools, 'team_status', {}, workerF)
  equal(selfReport.session, workerF, 'worker 查自己')
  equal(selfReport.self, true, 'worker 查自己 self=true')
  // worker 带 session 查队友 → context 必须是 null
  const peerReport = await callTool(workerTools, 'team_status', { session: workerA }, workerF)
  equal(peerReport.session, workerA, 'worker 查队友')
  equal(peerReport.context, null, 'worker 查队友：context 为 null')
  // leader 查队友 → 有 context
  const leaderView = await callTool(leaderTools, 'team_status', { session: workerF }, LEADER)
  equal(leaderView.session, workerF, 'leader 查队友')
  assert(leaderView.context !== null && leaderView.context.available === true, 'leader 查队友：有 context')
  // 团队外 → 抛错（两种角色都抛）
  for (const [label, tools, session] of [
    ['worker', workerTools, workerF],
    ['leader', leaderTools, LEADER],
  ]) {
    let error = null
    try {
      await callTool(tools, 'team_status', { session: 'at-not-in-team' }, session)
    } catch (thrown) {
      error = thrown
    }
    assert(error !== null, `${label} 查团队外应当抛错`)
    assert(/不在本团队/.test(error.message), `${label} 抛的是"不在本团队"：${error.message}`)
  }
})

test('[8] activity().queues 只含在职成员（归档会话不出现、不拉起）', async () => {
  // 归档前先让它空闲：setArchived 的安全阀会跳过正在跑的会话。
  agents.get(workerA).status = 'idle'
  await api.setArchived({ ids: [workerA], archive: true })
  equal(api.roleOf(workerA) === 'worker' && store.state().sessions[workerA].status, 'archived', 'workerA 已归档')
  const activity = api.activity()
  const queues = activity.queues
  assert(queues !== undefined, 'activity().queues 存在')
  equal(workerA in queues, false, '归档成员不出现在 queues 里')
  assert(LEADER in queues && workerB in queues, '在职成员在 queues 里')
  const snapshot = queues[workerB]
  for (const key of ['status', 'turn', 'step', 'teamTurn', 'teamStep', 'oldestWaitMs', 'latched']) {
    assert(key in snapshot, `queues[].${key}`)
  }
  equal(snapshot.status, 'running', 'queues[].status')
  equal(snapshot.turn, 3, 'queues[].turn 是真实队列深度')
  equal(snapshot.latched, false, 'queues[].latched')
  // 归档会话的状态报告：archived / 队齐全 0 / context 为 null（不拉起）
  const archivedReport = await api.statusReport(workerA, { viewer: LEADER })
  equal(archivedReport.archived, true, '归档报告 archived')
  equal(archivedReport.live, false, '归档报告 live')
  equal(archivedReport.status, 'archived', '归档报告 status')
  equal(archivedReport.inbox.total, 0, '归档报告 inbox.total')
  equal(archivedReport.context, null, '归档报告 context 为 null')
})

test('[9] 旧字段兼容：回执仍有 session / state / mode（只增不减）', async () => {
  const slot = queuedReceipt.delivery[0]
  equal(slot.session, workerB, 'delivery[].session')
  equal(slot.mode, 'queue', 'delivery[].mode')
  equal(slot.state, 'delivered', 'delivery[].state')
  assert(typeof slot.outcome === 'string' && slot.outcome.length > 0, 'delivery[].outcome')
  assert(typeof slot.hint === 'string' && slot.hint.includes('先等回执'), `delivery[].hint（实际：${slot.hint}）`)
  assert(slot.queue !== undefined, 'delivery[].queue（发件人据此判断排队深度）')
  equal(slot.queue.turn, 2, 'delivery[].queue.turn（发送前的深度）')
  equal(slot.queue.teamTurn, 2, 'delivery[].queue.teamTurn')
  assert('oldestWaitMs' in slot.queue, 'delivery[].queue.oldestWaitMs')
  // store 里的 slot 形状：旧字段 + 新字段都在（工具回执是 clone，store 里没有 hint / queue）
  const stored = store.findMessage(queuedReceipt.id).delivery[0]
  for (const key of ['session', 'state', 'mode', 'at', 'outcome', 'targetStatus', 'queueBefore', 'queueAfter', 'ahead']) {
    assert(key in stored, `store slot 的 ${key}`)
  }
  equal('hint' in stored, false, 'hint 只在回执里，不落 store')
  // 工具层原样透传：worker 的 team_report 也能拿到 outcome/hint
  const report = await callTool(workerTools, 'team_report', { summary: '进度：验收脚本跑通' }, workerF)
  const reportSlot = report.delivery[0]
  assert(typeof reportSlot.session === 'string', 'team_report 回执有 session')
  equal(reportSlot.mode, 'queue', 'team_report 回执有 mode')
  equal(reportSlot.state, 'delivered', 'team_report 回执有 state')
  assert(typeof reportSlot.outcome === 'string' && reportSlot.outcome.length > 0, 'team_report 回执有 outcome')
  assert(typeof reportSlot.hint === 'string' && reportSlot.hint.length > 0, 'team_report 回执有 hint')
})

test('[10] 查未挂载会话 → not-live，且 resolveAgent 一次都没被调用', async () => {
  const spawned = await spawnWorker('worker-g')
  workerG = spawned.sessionId
  agents.delete(workerG) // 模拟"会话没挂载"（冷/未恢复）
  const before = resolveAgentCalls
  const eventsBefore = eventsCalls
  const report = await api.statusReport(workerG, { viewer: LEADER })
  equal(resolveAgentCalls, before, 'resolveAgent 调用次数（读状态不许拉起会话）')
  equal(eventsCalls, eventsBefore, 'sessionController.events 调用次数（未挂载会话不为看一眼去碰会话日志）')
  equal(report.live, false, 'live')
  equal(report.status, 'not-live', 'status')
  equal(report.archived, false, 'archived（在职但没挂载）')
  equal(report.inbox.total, 0, 'inbox.total')
  equal(report.inbox.turn + report.inbox.step, 0, '队列全 0')
  equal(report.inbox.messages.length, 0, '没有 messages')
  equal(report.context, null, '未挂载会话：context 为 null')
  equal(report.hint, '未运行，没有在途消息；发消息会把它唤醒。', 'hint 说明会唤醒')
  // 顺带：纯读也不该改变队列快照
  const snapshot = api.queueSnapshot(workerG)
  equal(snapshot.status, 'not-live', 'queueSnapshot().status')
  equal(snapshot.turn, 0, 'queueSnapshot().turn')
  equal(firstTaskReceipt.delivery[0].outcome, 'woken-now', '前面的回执没被后续读状态改掉')
})

test('[11] P2-3/P2-2：formatWait 空值不写「0 秒」；历史失败只做后缀', async () => {
  // formatWait：没有等待数据 → 空串（以前 Number(null) === 0 → 「最久 0 秒」）
  equal(formatWait(null), '', 'formatWait(null)')
  equal(formatWait(undefined), '', 'formatWait(undefined)')
  equal(formatWait(Number.NaN), '', 'formatWait(NaN)')
  equal(formatWait('95000'), '', 'formatWait(非数字) 也算不出')
  equal(formatWait(95000), '95 秒', 'formatWait(95000)')
  equal(formatWait(120), '1 秒', '亚秒/亚 2 秒至少 1 秒')
  // deliveryHint：队列快照没有等待数据时，不拼「最久 …」
  const noWait = deliveryHint({ outcome: 'queued-turn', ahead: 0, queue: { oldestWaitMs: null } })
  assert(noWait.includes('最久') === false, `没有等待数据时不写「最久」（实际：${noWait}）`)
  assert(noWait.includes('0 秒') === false, `也不写「0 秒」（实际：${noWait}）`)

  // 真机场景：目标活着、空闲、队列空，但一小时前失败过一条
  const workerH = (await spawnWorker('worker-h')).sessionId
  agents.delete(workerH) // 投给一个没有 live agent 的会话 → 这一条落成 failed（历史累计）
  await api.post({ from: LEADER, to: workerH, kind: 'task', summary: '永远送不到的一条', body: '' })
  agents.set(workerH, fakeAgent(workerH, { status: 'idle' })) // 会话回来了，现在空闲、inbox 空
  const report = await api.statusReport(workerH, { viewer: LEADER })
  equal(report.status, 'idle', 'status 仍是 idle')
  equal(report.inbox.total, 0, '队列空')
  equal(report.delivery.failed, 1, 'delivery.failed 是历史累计')
  assert(report.hint.startsWith('空闲且队列空：现在发能立刻处理。'), `主提示不被历史失败盖掉（实际：${report.hint}）`)
  assert(report.hint.includes('另有 1 条历史投递失败'), `失败作为后缀（实际：${report.hint}）`)
  // 没有主提示时，失败自己就是主提示（用"自己 running + 队列空"这个仍然没有主提示的状态）
  const onlyFailure = statusHint({ self: true, status: 'running', inbox: { total: 0, teamTurn: 0 }, delivery: { failed: 2 } })
  assert(onlyFailure.startsWith('有 2 条历史投递失败'), `纯失败时自己当主提示（实际：${onlyFailure}）`)
  assert(statusHint({ status: 'idle', inbox: { total: 0, teamTurn: 0 }, delivery: { failed: 0 } }) === '空闲且队列空：现在发能立刻处理。', '没有失败时不追加后缀')
})

test('[12] P2-4/P2-6：replaced 不再算 archived；旧 slot 回执为 unknown', async () => {
  // 1.10.0 之前写下的 slot 没有 outcome：回执必须给 'unknown'，且不能留 undefined（否则 lossless 校验炸）
  const legacy = deliveryReceipt({ session: 'at-old', state: 'delivered', mode: 'queue', at: '2026-11-01T00:00:00.000Z' })
  equal(legacy.outcome, 'unknown', '旧 slot 回执 outcome')
  equal(legacy.hint, '', '旧 slot 的 hint 为空串')
  assert(Object.values(legacy).every((value) => value !== undefined), '回执里没有 undefined 值')

  // promoteLeader 把 LEADER 顶成 replaced（同时把 workerG 立为 leader —— 放在最后做，不影响前面的断言）
  const promoted = await api.promoteLeader({ sessionId: workerG, reason: 'test-replaced' })
  equal(promoted.changed, true, 'promoteLeader 生效')
  const report = await api.statusReport(LEADER, { viewer: workerG })
  equal(report.archived, false, 'replaced 不算 archived')
  equal(report.replaced, true, 'replaced 标记')
  equal(report.status, 'replaced', 'status')
  equal(report.live, false, 'live')
  equal(report.inbox.total, 0, '队列全 0')
  equal(report.context, null, 'context 为 null')
  assert(report.hint.includes('已被交接替换'), `hint 指向接任者（实际：${report.hint}）`)
  equal(api.queueSnapshot(LEADER).status, 'replaced', 'queueSnapshot 也区分 replaced')
  assert(statusHint({ replaced: true }).includes('已被交接替换'), 'statusHint 认 replaced')
  assert(statusHint({ archived: true, replaced: true }).startsWith('该会话已归档'), 'archived 仍然优先于 replaced')
})

test('[13] 真机回归：对方 idle + next-step 积压（inject 停在队列里）→ hint 不再为空', async () => {
  // 纯函数：真机原样的输入（status idle、teamTurn 0、teamStep 1、oldestWaitMs 2539）
  const idleBacklog = statusHint({ self: false, status: 'idle', inbox: { total: 1, teamStep: 1, teamTurn: 0, oldestWaitMs: 95000 } })
  assert(idleBacklog.includes('不唤醒'), `hint 说明这些消息不唤醒（实际：${idleBacklog}）`)
  assert(idleBacklog.includes('1 条'), `hint 给出条数（实际：${idleBacklog}）`)
  assert(idleBacklog.includes('最久 95 秒'), `有等待数据时写最久（实际：${idleBacklog}）`)
  assert(idleBacklog.includes('priority: "urgent"'), 'hint 可执行')
  // 没有积压时仍是「空闲且队列空」
  equal(
    statusHint({ self: false, status: 'idle', inbox: { total: 0, teamStep: 0, teamTurn: 0 } }),
    '空闲且队列空：现在发能立刻处理。',
    '没有积压时不变',
  )
  // 算不出等待时长 → 不写「最久」
  const noWait = statusHint({ self: false, status: 'idle', inbox: { total: 1, teamStep: 1, teamTurn: 0, oldestWaitMs: null } })
  assert(noWait.includes('不唤醒') && noWait.includes('最久') === false, `null 等待不写最久（实际：${noWait}）`)

  // 端到端复刻真机那条 notice：idle 的 worker + inject 停在 next-step
  workerI = (await spawnWorker('worker-i')).sessionId
  const agent = agents.get(workerI)
  agent.status = 'idle'
  agent.inbox.nextTurn.length = 0
  // [12] 之后 LEADER 已是 replaced，这里用现任 leader（workerG）发，语义才不别扭
  const message = await api.post({ from: workerG, to: workerI, kind: 'notice', summary: '真机那条 notice 的复刻', body: '' })
  equal(message.delivery[0].outcome, 'parked-no-wake', '回执仍是 parked-no-wake')
  const report = await api.statusReport(workerI, { viewer: workerG })
  equal(report.status, 'idle', 'status')
  equal(report.inbox.total, 1, 'inbox.total')
  equal(report.inbox.teamTurn, 0, 'teamTurn 为 0（inject 停在 next-step）')
  equal(report.inbox.teamStep, 1, 'teamStep 为 1')
  assert(report.hint !== '', 'hint 不再为空')
  assert(report.hint.includes('不唤醒'), `端到端 hint 也说得出（实际：${report.hint}）`)
})

test('[14] 真机回归 2：对方 running + 队列空 → 说明「会排到下一轮」，self 不变', async () => {
  // 纯函数：running + 队列空不再留空串（空队列 ≠ 立刻处理）
  const runningEmpty = statusHint({ self: false, status: 'running', inbox: { total: 0, teamTurn: 0, teamStep: 0 } })
  assert(runningEmpty.includes('排到它下一轮'), `hint 说明会排到下一轮（实际：${runningEmpty}）`)
  assert(runningEmpty.includes('不是立刻处理'), 'hint 纠正"空队列 = 马上能看"的误判')
  // 自己 running + 队列空：仍为空串（不需要提醒自己）
  equal(statusHint({ self: true, status: 'running', inbox: { total: 0, teamTurn: 0 } }), '', 'self 仍为空串')
  // 对方 running + 有积压 → 上一档（排队）优先，不落到这一档
  const runningBacklog = statusHint({ self: false, status: 'running', inbox: { total: 2, teamTurn: 2, oldestWaitMs: 3000 } })
  assert(runningBacklog.includes('前面还有 2 条排队'), `有积压时先说排队（实际：${runningBacklog}）`)
  assert(runningBacklog.includes('排到它下一轮') === false, '不落到"队列空"那档')

  // 端到端：正在跑、队列空的队友（真机里 worker 查 leader 那条的复刻）
  const agent = agents.get(workerI)
  agent.status = 'running'
  agent.inbox.nextStep.length = 0
  const report = await api.statusReport(workerI, { viewer: workerG })
  equal(report.status, 'running', 'status')
  equal(report.inbox.total, 0, 'inbox.total')
  assert(report.hint.includes('排到它下一轮'), `端到端 hint 也说出来（实际：${report.hint}）`)
})

// ---- 跑 ----------------------------------------------------------------

let failed = 0
for (const item of cases) {
  try {
    await item.fn()
    console.log(`PASS ${item.label}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${item.label}`)
    console.log(`     ${error && error.message ? error.message : String(error)}`)
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`)
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
