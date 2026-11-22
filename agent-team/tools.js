// Agent Team (P2) — preset 作用域里的团队工具。
//
// 这个模块同时被两个 preset 声明引用，靠 `config.role` 区分：
//   role: leader  → team_spawn_worker / team_post / team_roster
//   role: worker  → team_post / team_report
//
// 关键：`ctx.tools.register` 在这里执行，而这个插件的 ctx 就是 preset 的 scope，
// 所以只有选了该 preset 的会话能看到这些工具。选 standard 的会话看到的工具表里
// 没有它们——不是靠 `when` 隐藏，也不是靠工具内部检查拒绝，而是根本不在作用域里。
//
// 状态不在这里：读写都走 Host 提供的 `agentTeam` 服务（唯一写者）。
export const name = 'dsh-agent-team-tools'
export const inject = ['agentTeam', 'tools']

const ok = (value) => [{ type: 'text', text: JSON.stringify(value) }]

const callerOf = (exec) => exec?.agent?.id ?? exec?.agent?.session?.id ?? ''

/**
 * 回执的读法（team_post / team_report 共用一句）。
 *
 * 光有 `state:'delivered'` 会骗人：queue 打到正在跑的会话是"排在第 3 轮后面"，
 * inject 打到空闲会话是"一直停在 inbox、没人唤醒就永远不动"。`outcome` 是这三者的分辨依据。
 */
const OUTCOME_HELP =
  '返回里的 `outcome` 告诉你对方是立刻处理（woken-now）还是排队（queued-turn）还是根本不会醒（parked-no-wake）。'

/** `delivery[]` 的输出声明：新增字段只增不改（session/state/mode 是既有消费者依赖的）。 */
const DELIVERY_OUTPUT = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      session: { type: 'string' },
      state: { type: 'string' },
      mode: { type: 'string' },
      outcome: { type: 'string', description: 'held / failed / pending-delivery / woken-now / queued-turn / steered-step / injected-step / parked-no-wake' },
      targetStatus: { type: 'string' },
      ahead: { type: 'number', description: '发送前对方队列里已有几条（queue 看 next-turn，steer/inject 看 next-step）' },
      queue: { type: 'object' },
      hint: { type: 'string' },
    },
  },
}

/**
 * 上闩守卫的决策（纯函数，单测用）。
 *
 * 三条规则，顺序不能变：
 *   1. 没上闩 → 放行；
 *   2. 这批消息里有人类消息（`source.kind === 'user'`）→ 放行。
 *      被 reject 的批次里已 claim 的消息不会入库，拦掉人类消息就是丢消息；
 *   3. 其余 → 否决这一步（不取消整轮，也不打断正在进行的流）。
 *
 * @param {{ latched: boolean, messages?: unknown[] }} input
 * @returns {'allow' | 'reject'}
 */
export function guardDecision({ latched, messages }) {
  if (!latched) return 'allow'
  const human = (messages ?? []).some((message) => message?.source?.kind === 'user')
  return human ? 'allow' : 'reject'
}

export function apply(ctx, config = {}) {
  const role = config.role === 'worker' ? 'worker' : 'leader'

  /**
   * 这次调用属于**哪个团队**（第 2 步）：按调用方会话反查它所在的工作区，取那份 store 的 api。
   *
   * 工具签名一个没动 —— 模型看到的参数与 1.8.0 完全相同，变的只是"去哪个 store 拿数据"。
   * 会话没挂工作区时 `forSession` 回落默认 root，所以单工作区的行为也不变。
   */
  const teamOf = (exec) => ctx.agentTeam.forSession(callerOf(exec))

  /** leader 侧：调用者必须真的是 leader。一个团队不允许并存多个 leader。 */
  function requireLeader(exec) {
    const team = teamOf(exec)
    const id = callerOf(exec)
    if (!id) throw new Error('取不到调用者会话 id')
    if (!team.isLeader(id)) {
      // 团队还没有 leader 时，该模式下的第一个会话默认就是 leader（charter §3.1）。
      const claimed = team.claimLeader(id)
      if (!claimed) {
        const leader = team.leaderState()
        throw new Error(
          `此会话不是 leader：本队 leader 是 ${leader.id}（${leader.reason}）。` +
          '一个团队不允许并存多个 leader，所以本会话不能派发或审批。' +
          '如需换人，请让用户在面板里操作（或先归档现有 leader）；在此之前不要自行绕过。',
        )
      }
    }
    return id
  }

  /** worker 侧：必须是 leader 派发出来的成员。 */
  function requireMember(exec) {
    const team = teamOf(exec)
    const id = callerOf(exec)
    if (!id) throw new Error('取不到调用者会话 id')
    const entry = team.roster().members.find((member) => member.session === id)
    if (entry === undefined) throw new Error(`会话 ${id} 不在团队岗位表里：worker 应由 leader 派发创建`)
    return id
  }

  // 上下文用量：让"该不该交接"看数据，不看感觉。
  // worker 只能查自己；leader 可以查任意成员（用来判断是不是该让人交接了）。
  ctx.effect(() =>
    ctx.tools.register({
      name: 'team_context',
      description:
        '看上下文用量：已用多少 / 窗口多大 / 百分比，以及该不该交接（keep-working / suggest-handoff / handoff-now）。' +
        '交接前先调它——低于 suggest 档不要因为"感觉快满了"交接；到 handoff-now 就立刻申请。',
      parameters: {
        type: 'object',
        properties: {
          session: { type: 'string', description: '要查哪个会话（默认自己；只有 leader 能查别人）' },
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            available: { type: 'boolean' },
            used: { type: 'number' },
            window: { type: 'number' },
            percent: { type: 'number' },
            band: { type: 'string' },
            hint: { type: 'string' },
          },
        },
        render: (_args, value) => ok(value),
      },
      async execute(args, exec) {
        const team = teamOf(exec)
        const self = callerOf(exec)
        const target = args.session ?? self
        if (target !== self && !team.isLeader(self)) throw new Error('只有 leader 能查别人的上下文用量')
        return team.contextReport(target)
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'team_directory',
      description:
        '看团队里还有谁、各自什么岗位（只读通讯录）：会话 id、岗位、角色、是不是 leader。' +
        '用来知道该跟哪个会话协作；不含活动指标、不含待批申请（那些是 leader 的 team_roster）。' +
        '两种角色都有：leader 也能用它核对某个成员到底在不在团队里。',
      parameters: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: ['all', 'leader', 'worker'], description: '只看某一类，默认 all' },
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            leader: { type: 'string', description: '当前 leader 的会话 id；没有 leader 时为空串' },
            hasLeader: { type: 'boolean' },
            total: { type: 'number' },
            members: { type: 'array', items: { type: 'object' } },
          },
        },
        render: (_args, value) => ok(value),
      },
      async execute(args, exec) {
        const team = teamOf(exec)
        const viewer = callerOf(exec)
        return team.directory({ role: args.role ?? 'all', viewer })
      },
    }),
  )

  // 会话状态（1.10.0）：默认查自己，`session` 查队友。
  // 两种角色都注册 —— 发消息**之前**先看对方堵着几条，比发完再猜有用。
  // 只读 live agent（`ctx.agents.get`），不会唤醒任何会话；归档会话只报 archived。
  ctx.effect(() =>
    ctx.tools.register({
      name: 'team_status',
      description:
        '看一个会话此刻的状态：running / idle / not-live / archived、inbox 里堵着几条' +
        '（先 next-turn 后 next-step，最多 20 条，带 from / kind / waitMs）、有没有投递失败、' +
        '交接是否上闩、上下文用量（只有自己或 leader 看别人时给）。默认查自己，`session` 查队友。' +
        '用来在发消息前判断"现在发是立刻处理、还是只是又排一条"。只读 live agent：不会唤醒任何会话。',
      parameters: {
        type: 'object',
        properties: {
          session: { type: 'string', description: '要查哪个会话（默认自己；leader / worker 都可查在职队友）' },
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            session: { type: 'string' },
            self: { type: 'boolean' },
            role: { type: 'string' },
            job: { type: 'string' },
            title: { type: 'string' },
            archived: { type: 'boolean' },
            replaced: { type: 'boolean', description: '被新 leader 顶替的旧会话：true 时不要再发任务，接任者是同岗位的新会话' },
            live: { type: 'boolean' },
            status: { type: 'string', description: 'running | idle | not-live | archived | replaced' },
            latched: { type: 'boolean', description: '交接上闩：true 时发给它的消息会被暂扣，别发任务' },
            inbox: { type: 'object' },
            delivery: { type: 'object' },
            activity: { type: 'object' },
            context: { oneOf: [{ type: 'object' }, { type: 'null' }], description: '上下文用量（自己总是给；leader 查已挂载队友也给；其余为 null）' },
            hint: { type: 'string' },
          },
        },
        render: (_args, value) => ok(value),
      },
      async execute(args, exec) {
        const team = teamOf(exec)
        const self = callerOf(exec)
        const wanted = typeof args.session === 'string' ? args.session.trim() : ''
        return team.statusReport(wanted === '' ? self : wanted, { viewer: self })
      },
    }),
  )

  const postTool = {
    name: 'team_post',
    // 描述按角色写：以前两种角色共用一段"可以发 all / role:"的文案，worker 照着试、
    // 拿到的是权限错误 —— 工具说明在骗它。
    description: role === 'leader'
      ? '向团队里的指定收件人发一条消息（只有收件人收到）。' +
        '收件人写成 leader / all / role:<岗位> / 逗号分隔的会话 id。' +
        '消息先入库再投递，失败只标记该收件人，不丢弃。' +
        OUTCOME_HELP
      : '向 leader 或同事发一条消息（单播：一个会话 id；多播：逗号分隔多个 id；' +
        '同组合播：role:<你自己的岗位>）。worker 不能发给 all，也不能按别的岗位群发。' +
        '消息先入库再投递，失败只标记该收件人，不丢弃。' +
        OUTCOME_HELP,
    parameters: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: role === 'leader'
            ? 'leader | all | role:<岗位> | 会话 id 列表（逗号分隔）'
            : 'leader | role:<你自己的岗位> | 会话 id（多个用逗号分隔）',
        },
        kind: {
          type: 'string',
          enum: ['task', 'question', 'answer', 'report', 'notice', 'handoff-request', 'handoff-approval', 'roster-update'],
          description: '消息类型，默认 notice',
        },
        summary: { type: 'string', description: '一行摘要，收件人上下文里看到的就是它（≤500 字）' },
        body: { type: 'string', description: '正文，按需从 body 路径读取；不要塞整段日志' },
        priority: { type: 'string', enum: ['normal', 'urgent'], description: '默认 normal' },
      },
      required: ['to', 'summary'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          to: { type: 'array', items: { type: 'string' } },
          delivery: DELIVERY_OUTPUT,
        },
      },
      render: (_args, value) => ok(value),
    },
    async execute(args, exec) {
      const team = teamOf(exec)
      const from = role === 'leader' ? requireLeader(exec) : requireMember(exec)
      const message = await team.post({
        from,
        to: args.to,
        kind: args.kind ?? 'notice',
        priority: args.priority ?? 'normal',
        summary: args.summary,
        body: args.body ?? '',
      })
      return { id: message.id, to: message.to, delivery: message.delivery }
    },
  }

  ctx.effect(() => ctx.tools.register(postTool))

  if (role === 'leader') {
    ctx.effect(() =>
      ctx.tools.register({
        name: 'team_spawn_worker',
        description:
          '派发一个新 worker 会话（平级根会话，preset 为 agent-team-worker）并投递第一条任务。' +
          '默认「需要批准」档：只登记一条待用户批准的申请；「完全权限」档：直接创建并派活，每次都会记入派发日志。',
        parameters: {
          type: 'object',
          properties: {
            job: { type: 'string', description: '岗位标识，2–32 位小写字母/数字/连字符，如 frontend' },
            title: { type: 'string', description: '给人看的岗位名，默认同 job' },
            task: { type: 'string', description: '新会话收到的第一条指令（自包含）' },
            complexity: { type: 'string', enum: ['simple', 'moderate', 'complex'], description: '决定推理强度，默认 moderate' },
          },
          required: ['job', 'task'],
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              sessionId: { type: 'string' },
              requestId: { type: 'string' },
              preset: { type: 'string' },
            },
          },
          render: (_args, value) => ok(value),
        },
        async execute(args, exec) {
          const team = teamOf(exec)
          const from = requireLeader(exec)
          if (!/^[a-z0-9-]{2,32}$/.test(args.job ?? '')) throw new Error('job 必须是 2–32 位小写字母、数字或连字符')

          const fullAuthority = team.charter().spawnAuthority === 'autonomous'
          if (!fullAuthority) {
            const request = team.requestSpawn({
              job: args.job,
              title: args.title,
              task: args.task,
              complexity: args.complexity ?? 'moderate',
              requestedBy: from,
            })
            return { status: 'needs_user_approval', requestId: request.id, preset: 'agent-team-worker' }
          }

          // 完全权限：不再等用户批准，直接建会话并派活；每次都进 spawnLog 供事后复盘。
          const spawned = await team.spawnWorker({
            job: args.job,
            title: args.title,
            task: args.task,
            complexity: args.complexity ?? 'moderate',
            requestedBy: from,
          })
          return {
            status: 'created',
            sessionId: spawned.sessionId,
            preset: spawned.preset,
            messageId: spawned.messageId,
            authority: 'full',
            note: '已按「完全权限」自主派发，已记入派发日志，请在下次风控汇报里向用户说明',
          }
        },
      }),
    )

    ctx.effect(() =>
      ctx.tools.register({
        name: 'team_handoff_approve',
        description:
          '批准一条挂起的交接申请：建继任会话（同岗位、agent-team-worker 预设）、更新岗位表、投递交接单，并归档旧会话。' +
          '用户面板也能批准同一条申请。',
        parameters: {
          type: 'object',
          properties: { requestId: { type: 'string', description: '交接申请 id（h- 开头）' } },
          required: ['requestId'],
        },
        output: {
          schema: { type: 'object', properties: { successor: { type: 'string' }, archived: { type: 'string' }, doc: { type: 'string' } } },
          render: (_args, value) => ok(value),
        },
        async execute(args, exec) {
          const team = teamOf(exec)
          requireLeader(exec)
          if (!String(args.requestId ?? '').startsWith('h-')) throw new Error('这不是交接申请 id（应以 h- 开头）')
          return team.approveHandoff(args.requestId, 'leader')
        },
      }),
    )

    ctx.effect(() =>
      ctx.tools.register({
        name: 'team_handoff_more_info',
        description:
          '要求交接单补充信息：申请**保持挂起**，把"缺什么"回给申请方，并解除它的上闩让它能补单子。' +
          '补齐后它会重新提交，更新的是同一张单子（不会新建），然后重新上闩。' +
          '用户面板也能走这条路径。',
        parameters: {
          type: 'object',
          properties: {
            requestId: { type: 'string', description: '交接申请 id（h- 开头）' },
            note: { type: 'string', description: '要补什么（必填）' },
          },
          required: ['requestId', 'note'],
        },
        output: {
          schema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' }, infoRequested: { type: 'object' } } },
          render: (_args, value) => ok({ id: value.id, status: value.status, infoRequested: value.infoRequested }),
        },
        async execute(args, exec) {
          const team = teamOf(exec)
          requireLeader(exec)
          if (!String(args.requestId ?? '').startsWith('h-')) throw new Error('这不是交接申请 id（应以 h- 开头）')
          return team.requestHandoffInfo(args.requestId, { note: args.note, by: 'leader' })
        },
      }),
    )

    ctx.effect(() =>
      ctx.tools.register({
        name: 'team_request_successor',
        description:
          '给**自己**提继任申请：交接单写清楚，用户批准后会建一个新的 leader 会话接手，旧 leader 归档。' +
          '用 team_context 看数据：到 suggest 档（约 45%）先做完当前里程碑再提；到 handoff-now 档立刻提。' +
          '不要"感觉快满了"就提 —— 窗口约 1M，100–200k 是正常的。',
        parameters: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: '一句话说明为什么交接、交接到什么状态' },
            reason: { type: 'string', description: '触发原因（建议直接写 team_context 的 used/window）' },
            completed: { type: 'array', items: { type: 'string' }, description: '已完成的事' },
            artifacts: { type: 'array', items: { type: 'string' }, description: '产物路径' },
            next: { type: 'array', items: { type: 'string' }, description: '继任 leader 要做的下一步' },
            effort: { type: 'string', enum: ['off', 'high', 'max'], description: '建议继任者的推理强度' },
          },
          required: ['summary'],
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              status: { type: 'string' },
              docPath: { type: 'string' },
              context: { type: 'object' },
            },
          },
          render: (_args, value) => ok(value),
        },
        async execute(args, exec) {
          const team = teamOf(exec)
          const from = requireLeader(exec)
          const request = await team.requestHandoff({
            from,
            summary: args.summary,
            reason: args.reason,
            completed: args.completed ?? [],
            artifacts: args.artifacts ?? [],
            next: args.next ?? [],
            effort: args.effort ?? 'high',
          })
          return { id: request.id, status: request.status, docPath: request.docPath, context: request.contextUsage }
        },
      }),
    )

    ctx.effect(() =>
      ctx.tools.register({
        name: 'team_roster',
        description: '读团队岗位表、待批派发申请与原始活动指标（只给数字与指针，不给全文）。',
        parameters: {
          type: 'object',
          properties: { include: { type: 'string', enum: ['roster', 'activity', 'both'], description: '默认 both' } },
        },
        output: {
          schema: { type: 'object', properties: { roster: { type: 'object' }, activity: { type: 'object' } } },
          render: (_args, value) => ok(value),
        },
        async execute(args, exec) {
          const team = teamOf(exec)
          requireLeader(exec)
          const include = args.include ?? 'both'
          return {
            ...(include === 'activity' ? {} : { roster: team.roster() }),
            ...(include === 'roster' ? {} : { activity: team.activity() }),
          }
        },
      }),
    )
  }

  if (role === 'worker') {
    // 上闩守卫：交接申请发出后，旧会话不许再开新步骤。
    //
    // 这个监听器注册在 **worker preset 的作用域** 里，所以只对选了这个 preset 的会话生效；
    // `standard` 等其它模式的会话根本不会走到这里。
    //
    // `agent/pre-step` 是 waterfall：放行必须 `return next()`（裸 return 会把 undefined
    // 当决策交回宿主，所有会话每一轮都会炸 —— INC-2026-11-20-PRESTEP）。
    ctx.effect(() => ctx.on('agent/pre-step', (payload, next) => {
      const id = callerOf({ agent: payload.agent })
      const team = teamOf({ agent: payload.agent })
      // 先记一笔：这个监听器到底看得到哪些会话（验收时用来判作用域是否真的隔离）。
      team.notePreStep(id)
      if (!id) return next()
      if (guardDecision({ latched: team.isLatched(id), messages: payload.messages }) === 'reject') {
        team.noteReject(id)
        return { kind: 'reject' }
      }
      return next()
    }))

    ctx.effect(() =>
      ctx.tools.register({
        name: 'team_handoff_request',
        description:
          '申请把当前岗位交接给一个新会话（上下文接近上限、需要换人时用）。' +
          '会写一张自包含的交接单、给 leader 发申请，并让本会话不能再开新步骤——直到 leader 批准或拒绝。',
        parameters: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: '一句话说明为什么交接、交接到什么状态' },
            reason: { type: 'string', description: '触发原因，如"上下文接近上限"' },
            completed: { type: 'array', items: { type: 'string' }, description: '已完成的事' },
            artifacts: { type: 'array', items: { type: 'string' }, description: '产物路径' },
            next: { type: 'array', items: { type: 'string' }, description: '接手方要做的下一步' },
            effort: { type: 'string', enum: ['off', 'high', 'max'], description: '建议继任会话的推理强度' },
          },
          required: ['summary'],
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              status: { type: 'string' },
              docPath: { type: 'string' },
              context: { type: 'object', description: '你的上下文用量（used/window/percent/band），已写进交接单' },
            },
          },
          render: (_args, value) => ok(value),
        },
        async execute(args, exec) {
          const team = teamOf(exec)
          const from = requireMember(exec)
          const request = await team.requestHandoff({
            from,
            summary: args.summary,
            reason: args.reason,
            completed: args.completed ?? [],
            artifacts: args.artifacts ?? [],
            next: args.next ?? [],
            effort: args.effort ?? 'high',
          })
          // 把上下文用量一起回给模型：这样它在 summary / 汇报里能引真数字，而不是"感觉快满了"。
          return { id: request.id, status: request.status, docPath: request.docPath, context: request.contextUsage }
        },
      }),
    )


    ctx.effect(() =>
      ctx.tools.register({
        name: 'team_report',
        description:
          '向 leader 汇报：进度、结论、阻塞、需要决策的事项。消息会入库并投递给 leader。' +
          OUTCOME_HELP,
        parameters: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: '一行摘要（≤500 字）' },
            body: { type: 'string', description: '正文：做了什么、产物路径、下一步、卡在哪' },
            kind: { type: 'string', enum: ['report', 'question', 'answer'], description: '默认 report' },
            priority: { type: 'string', enum: ['normal', 'urgent'], description: '默认 normal' },
          },
          required: ['summary'],
        },
        output: {
          schema: { type: 'object', properties: { id: { type: 'string' }, delivery: DELIVERY_OUTPUT } },
          render: (_args, value) => ok(value),
        },
        async execute(args, exec) {
          const team = teamOf(exec)
          const from = requireMember(exec)
          const message = await team.post({
            from,
            to: 'leader',
            kind: args.kind ?? 'report',
            priority: args.priority ?? 'normal',
            summary: args.summary,
            body: args.body ?? '',
          })
          return { id: message.id, delivery: message.delivery }
        },
      }),
    )
  }
}
