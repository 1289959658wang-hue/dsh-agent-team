# Agent Team 模式：可复用方案调研

> 状态：讨论稿 v0.1（2026-11-20）
> 范围：只做资料整理与方案比对，不含实现。
> 用途：为「Agent Team 工作模式」插件选择可复用的现成方案，并记录每个决定背后的依据与坑。

---

## 0. 结论摘要

1. **形态可行**：一个 bundle 声明 preset（必要时两三个），装完在模式选择器里出现；官方 prototype 与多个社区插件都用了同一套机制。
2. **平级根会话可行且已有生产级先例**：官方 prototype 的 worker 会话就是根会话，按 `worker-<ticketId>` 命名，在自己的目录里工作。
3. **上下文交接不必自研**：`dsh-handoff-session` + `dsh-auto-handoff` 已经把「压力阈值 → 交接单 → 新会话 → 旧会话退役」走通，并记录了关键陷阱。
4. **消息层要自研**：DSH 原生没有「会话间群组」。官方 prototype 用星型汇报（report/relay），没有群聊；社区里最接近的是 agent-community 的房间与 agent-teams 的成员邮箱。
5. **需要自研的三件事**：①会话间组播投递器；②岗位表作为跨会话唯一真相（服务为真相、文件为视图）；③leader 世代交接（所有权转移）。
6. **组播不是"广播后过滤"**：按收件人集合定向投递（单发/多选/全量/按岗位），`sessionId` 只是收件人标识；服务端 fan-out 决定谁收到，模型不需要"收到再判断"。
7. **不设消息配额**：框架只做摘要折叠、TTL 与去重（都属展示层/幂等），不阻断投递；异常由 **leader 自主判断**（框架不写死阈值），判定异常必须向用户汇报，不确定则提交人工复核。
8. **可配置优先**：异常口径、汇报格式、岗位、消息规则、交接单字段都不写死，存为「团队章程」，由 leader 与用户按项目共同制定；插件只提供机制与默认草案。

---

## 1. 术语与需求

| 术语 | 含义 |
|---|---|
| 工作模式 | GUI 模式选择器里的一项，即 DSH 的 agent preset |
| 会话 | DSH Session；`sessionId` 是唯一身份 |
| Leader | 只做汇报、转达、建会话、派活、定岗位，不直接做业务 |
| Worker | 只执行自己岗位的模块，可开子智能体 |
| 岗位表 | `sessionId → 岗位/负责内容`；服务为真相，文件为视图 |
| 组播（multicast） | 一条消息发给明确的收件人集合：1 个 / 几个 / 全部 / 某岗位组 |
| 交接单 | 结构化文档：岗位、已完成、产物路径、已知坑、下一步 |
| 团队章程 | 可配置协议的载体：异常口径、汇报格式、岗位定义、消息规则、交接单字段；leader 与用户共同维护 |

**需求修正（2026-11-20）**：消息能力不是"所有人收到再按 id 过滤"，而是**组播**：

- leader → 全体 worker
- leader → 指定的几个 worker
- worker → leader
- worker → 另外几个会话（含其他 worker）
- 不允许的：发给不存在的会话、越权群发（由策略决定）

### 1.1 设计原则：可配置优先，不写死

**凡是会随项目/用户变化的东西，都不进插件代码。** 插件只提供机制与默认草案，具体协议由 leader 与用户按项目共同制定，存为**团队章程**，可随时改。

| 会变的东西 | 谁定 | 存在哪 |
|---|---|---|
| 什么算"异常" | leader 自主判断（可随项目调整口径） | 团队章程 / leader 提示词 |
| 风控汇报的格式与详略 | leader 与用户约定 | 团队章程 |
| 岗位划分与职责 | leader 与用户 | 岗位表 |
| leader 身份 | 用户（首个会话默认 leader，可直接指定） | 团队章程 |
| 派发新会话的权限 | 用户下放（`ask` / `autonomous`） | 团队章程 |
| 交接主体责任 | worker 交接归 leader；leader 交接归用户 | 团队章程 |
| 允许谁给谁发消息 | 用户 + leader | 团队章程（策略段） |
| 交接单字段 | 用户 + leader | 团队章程 |
| 观察/摘要的频次 | leader | 团队章程 |

框架不规定模板、不内置阈值、不替用户判断；只保证机制可用、数据可读、行为可审计。

---

## 2. 参考对象清单

| 参考 | 类型 | 版本/来源 | 我们读到的范围 |
|---|---|---|---|
| [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) | 官方研究原型（MIT，README 声明非官方产品） | 仓库 main，2026-11-20 抓取 | README、`docs/001-domain.md`、`docs/003-execution.md`、`docs/007-architecture.md`、`prompts/*.md`、`cordis.patch.yml`、`src/app/sessions.ts`、`src/executor/dsh.ts` |
| [@nanmicoder/dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams) | 社区团队插件 | npm latest 0.1.31；文档对应 0.1.15 | README_ZH v0.1.15 |
| [dsh-plugin-agent-collaboration](https://github.com/Leo-sail/dsh-plugin-agent-collaboration) | 社区群聊/机器人插件 | npm 0.5.0（2026-11-10） | npm README |
| [dsh-handoff-session](https://github.com/BlueOcean3214/dsh-handoff-session) | 社区交接插件 | npm 0.9.0（2026-11-12） | npm README 全文 |
| [dsh-auto-handoff](https://github.com/qingyou002/dsh-auto-handoff) | 社区自动交接插件 | npm 0.2.0（2026-10-18） | npm README 全文 |
| [oxmumu3/dsh-superagent](https://github.com/oxmumu3/dsh-superagent) | 社区任务看板（同名不同物） | v0.3.0 | README |

---

## 3. 官方 dsh-superagent-prototype

### 3.1 组织与角色

- **Main Session（orchestrator）**：评估请求、建工单、派工、汇报；不做实现。
- **Executor Session（worker）**：一个工单一个会话、一个目录；负责实现、验证、交付。
- worker 可以再开子智能体；子智能体固定用 DSH `standard` preset，并受 worker 的权限约束。

### 3.2 会话与 preset（对我们最关键）

来自 `src/app/sessions.ts` 的 `ensure()`（只读核对）：

```ts
const workspace = await ctx.workspaceRegistry.create(cwd)
await ctx.sessionController.create({
  sessionId: id,                 // 'worker-<ticketId>'
  workspaceId: workspace.id,
  agentPreset: role === 'worker' ? WORKER_PRESET : ROUTER_PRESET,
})
ctx.permissionPresets.set(result.agent.session, 'danger-full-access')
await ctx.sessionController.rename({ sessionId: id, title })
```

- **平级根会话**：不是子智能体，是正常 Session。
- **每个会话独立目录**：`<stateDir>/work/<shortName>`，可先用 prepare 命令建 worktree。
- **两个 preset 由 bundle 声明**：`dsh-superagent-router`、`dsh-superagent-worker`。
- 官方注释：**preset 行无法从模式选择器隐藏**，只能靠名称与描述说明"给谁用"。

### 3.3 投递机制（组播的技术底座）

`src/app/sessions.ts` 的 `prompt(sessionId, requestId, text, mode)`：

| 模式 | 语义 | 适合 |
|---|---|---|
| `queue` | 投到下一轮（会话不忙时唤醒） | 派活、需要对方行动的请求 |
| `steer` | 注入当前轮 | 紧急纠正、打断当前思路 |
| `{ inject: label }` | 不唤醒，作为上下文静默注入 | 通知、状态更新、给 leader 的摘要 |

**结论**：DSH 侧"给某个会话发消息"是现成能力；缺的只是"一次解析多个收件人并逐个投递"的那一层。

### 3.4 状态与恢复（工程重点）

- 真相在持久化 Store（工单、派工、报告、输入、订阅），面板只是视图。
- 所有副作用先存储后执行；失败退避重试（2s 起翻倍到 60s）。
- worker slot 并发限制；后台任务 30 分钟上限；交接给人时释放 slot。
- 重启恢复：中断的派工带恢复说明重启；读过的消息不重投。
- 人类介入用结构化 `attention`，不靠自由文本猜。

### 3.5 能用的 / 不能用的

| 结论 | 内容 |
|---|---|
| ✅ 直接用 | 双 preset 形态；根会话创建方式；三种投递模式；"先存储后执行"的可靠性模式 |
| ⚠️ 改造后用 | 状态机（工单）→ 岗位表 + 群组消息；星型汇报 → 组播 |
| ❌ 没有 | 会话间群组/组播；上下文阈值自交接（它的 handoff 指交还给人类） |

---

## 4. 社区方案

### 4.1 dsh-agent-teams（队长 + 成员 + 任务 DAG）

- 当前会话当队长；成员是**可续聊子 Agent**（不是根会话）。
- 任务有负责人与依赖，空闲成员自动续领；`attempt` 租约防迟到结果覆盖。
- **成员持久化邮箱，可直接联系队友或队长，不需要队长中转** → 我们的 worker↔worker 需求有先例。
- 状态在 `<workspace>/.agent-teams/`，**单进程串行，多进程不保证一致**。
- 已知边界：模型可能干完活却没按协议更新任务状态。

**可借鉴**：邮箱语义、租约/attempt、自动续领、DAG 就绪判定。
**不可照搬**：成员是子会话；文件状态在多进程下的限制。

### 4.2 dsh-plugin-agent-collaboration（Bots + 房间）

- 持久 bot：身份、模型、权限、工作区、会话都能跨重启存活。
- **房间路由**：消息点名一个 bot → 只它答；不点名 → 全体成员都答。这就是"组播"在消息层的先例。
- run 有租约 + 心跳，运行时死掉可被回收，不堵房间。
- 13 个工具；持久 transcript。

**可借鉴**：收件人解析（点名/不点名/全员）、租约与心跳、持久记录。
**注意**：它的成员是 bot 实体，不是一组工作会话；我们要把"bot 身份"换成"会话 id"。

### 4.3 dsh-handoff-session（压力感知交接）

- 压力投影：轮数、步数、上下文占用、累计 token、缓存命中。
- 每轮把 `<session-pressure>` 注入运行时上下文，分 `low / watch / recommended / urgent` 四档。
- `session_handoff` 写交接文档 + 可检索转录，快照/打断子智能体，`sessionController.create()` 建新会话并投递提示词。
- 幂等：同一旧会话再次调用返回同一个新会话；进程重启后按文档识别。

**可借鉴**：压力分档、提示词注入、交接单格式、子智能体快照与"重新派出"。
**注意**：新会话看不到旧对话，交接单必须自包含。

### 4.4 dsh-auto-handoff（阈值触发 + 安全边界）

- 触发：手动 `/handoff`，或累计 token 阈值（不是单次上下文占比）。
- **软停止**：闩锁 + `agent/pre-step` reject，只拒绝"启动下一个 Step"，**从不 cancel**；等 `whenIdle()` 自然收尾。
- **人类提示守卫**：本批消息里有 `source.kind === 'user'` 就绝不 reject（被 reject 的已 claim 消息不入库）。
- 逐项继承：cwd、工作区归属、preset、模型、权限预设、Plan 模式；每项报告"继承/回退/未继承"。
- 记录了两个真实缺陷：
  - **缺陷 A**：按 cwd 建会话不会自动归属工作区 → 必须 `resolveByPath(cwd).attachSession(newId)`，否则侧边栏看不到。
  - **缺陷 B**：新会话在列表里是 `blank`，需 `sessions.refresh()` 才会显示。

**可借鉴**：阈值 + 检查点 + 守卫的完整闭环，以及逐项继承矩阵。
**注意**：它在 Web 面 `planMode/compaction` 位于 preset 的 isolate realm 内，要按 agent 解析服务（`agentPresets.serviceFor`）。

### 4.5 oxmumu3/dsh-superagent（社区任务看板）

- 任务卡片 + AI 拆单分诊 + 风险点头锁 + Codex Worktree 并发 + 结构化交活。
- 不在 DSH 会话之间做协作，偏"任务台账 + 外部执行器"。
- 与我们的关系：可借鉴"卡片/验收清单/待人工决定"的 UI 抽象，不借鉴其执行模型。

---

## 5. 能力对照与采用决定

| 需求 | 现成方案 | 采用决定 | 备注 |
|---|---|---|---|
| 工作模式 = preset | 官方双 preset；DSH bundle patch | ✅ 直接采用 | 我们至少要 `agent-team`（leader）与 `agent-team-worker` 两个 preset |
| 平级根会话 worker | 官方 `sessionController.create` | ✅ 采用，需实测 0.2.2-rc.5 | P1a 验证 |
| 独立工作区/目录 | 官方 `workspaceRegistry.create(cwd)` | ✅ 采用 | 注意 attachSession 的坑 |
| 会话身份 | `sessionId`；官方 `worker-<id>` 命名 | ✅ 采用 | 建议 `at-lead-` / `at-w-` 前缀便于识别 |
| leader 身份与开新会话权限 | 无现成实现 | 🔧 自研 | 首个会话默认 leader、用户可改；**派发**走 `ask`/`autonomous`，**交接替换**由 leader 批并自动执行；leader 交接归用户 |
| 组播消息 | 无现成；agent-community 有路由先例 | 🔧 自研投递器 | 见第 6 节 |
| 投递模式 | 官方 queue/steer/inject | ✅ 直接复用 | 通知用 inject，派活用 queue |
| 岗位表 | 官方状态机；agent-teams 文件 | 🔧 服务为真相、文件为视图 | CAS/单写者 |
| 阈值自交接 | handoff-session + auto-handoff | ✅ 组合复用 | 宿主判定，模型执行 |
| 交接单 | handoff 插件的文档格式 | ✅ 采用并扩展岗位字段 | 自包含 |
| leader 自身交接 | 通用 handoff 流程 | 🔧 自研世代交接事务 | 四家都没有 |
| 子智能体协助 | 官方允许并规定生命周期 | ✅ 采用 | 注意 30 分钟/作业回收 |
| 人类介入 | 官方 attention | ✅ 采用 | 结构化提问 |
| 人工代批载体 | 无现成 | 🔧 自研插件面板 | 团队待办队列；不用 DSH approval（需打开的回合、受 `never` 策略影响） |
| 用户查看会话间通信 | 无现成 | 🔧 自研插件面板 | 群组消息只读审计；两个面板见 [panels.md](./panels.md) |
| 推理强度调度 | `sessionController.selectModel` | ✅ 采用 | 派发前按分级设定 off/low/high/max，见 [effort-policy.md](./effort-policy.md) |
| 面板 | agent-teams / 官方 panel | 二期再做 | 一期先用文件视图 |

---

## 6. 消息层设计：组播（multicast）而非广播过滤

### 6.1 为什么不是"广播后过滤"

- 全广播 = 每个会话都吞全群原文，token 成本 = 会话数 × 消息长度。
- 过滤靠模型自律不可靠：模型可能误读、误回、把无关消息写进上下文。
- 组播在**投递端**解析收件人：只有收件人收到；日志仍保留全量，面板可回放。

### 6.2 信封格式

```yaml
msg:
  id: m-000123            # 单调递增，服务端分配
  ts: 2026-11-20T19:00:00+08:00
  from: session:at-w-03
  to: [session:at-w-01, session:at-w-02]   # 解析后的收件人
  to_expr: leader | all | role:frontend | [id, id]
  kind: task | question | answer | report | notice | handoff-request | handoff-approval | roster-update
  priority: normal | urgent
  summary: 一行摘要（进收件人上下文的就是它）
  body_ref: group/2026-11-20/m-000123.md    # 正文按需拉取
```

### 6.3 收件人解析

| 发送者 | 允许的 to | 说明 |
|---|---|---|
| leader | `all`、`[ids]`、`role:<岗位>` | 派活、广播通知、点名 |
| worker | `leader`、`[ids]`（同组或指定） | 求助、汇报、协同 |
| 任意 | 自己 | 记录用（可选） |

规则：
- 收件人必须存在且属于本团队；不存在 → 发送失败，不静默丢弃。
- 越权（如 worker 群发全团队）默认拒绝，由策略开关放开。
- leader 默认"旁听"：所有消息对 leader 可见，但**不逐条唤醒**；按 step 汇总注入（inject），只有点名给 leader 或 urgent 才 queue。

### 6.4 投递模式

| 场景 | 模式 |
|---|---|
| 派活、要求对方立即行动 | `queue`（对方空闲则唤醒） |
| 紧急纠正/停止 | `steer` |
| 通知、状态、摘要、旁听 | `inject`（不唤醒） |

### 6.5 已读与顺序

- 每个会话一个 mailbox + 读游标；未读在下一步以**信封摘要**注入，正文按 `body_ref` 取。
- 同一收件人按 `id` 顺序；跨收件人不承诺同时。
- 每步注入上限（建议 8 条），超出折叠为"还有 N 条未读"。
- 发送失败/投递失败入重试队列（退避），并让发送者看到失败回执。

### 6.6 存储与一致性

- 真相：Host 服务的存储（或工作区下的 `team/` 目录 + 单写者），**不是聊天记录**。
- 单写者或 CAS；禁止多个会话直接改同一文件。
- 掉线/重启：mailbox 持久化，重投未读；已读以游标为准。
- 审计：全量消息日志保留，面板可按收件人/类型/会话筛选。

### 6.7 不设配额：改由 Leader 风控

**原则：框架不替模型判断"这条消息该不该发"。** 长任务里消息多、正文长，是模型工作方式的产物，不是框架该用硬门槛去压的东西。任何"每日 N 条 / 每会话 N 条"的预算都会先在正常的长任务上误伤，所以取消。

- **没有发送配额、没有投递配额、没有自动熔断。**
- 消息永远可发、永远入库；投递失败才重试，不因"发太多"被拒绝。
- 下列机制只做**展示层与幂等**，不阻断工作：

| 机制 | 作用 | 边界 |
|---|---|---|
| 每步信封摘要上限（超出折叠为"还有 N 条"） | 控制进入上下文的体积 | 只影响展示，不影响投递 |
| 信封 TTL | 防旧摘要无限累积 | 过期不删日志，只不再注入 |
| 重复消息去重（同内容哈希 → 同收件人，窗口内只投一次） | 幂等 | 不是限额；不同内容照常投 |
| 全量审计日志 | 谁在何时发了多少、多长、给谁 | 只增不删 |

#### Leader 的风控职责

**框架不定义"异常"，也不设告警阈值。** 判断权完全在 leader；框架只提供原始事实与读取手段。

- leader 随时可用工具读取团队活动统计：速率、最长消息、往复最频繁的会话对、重复内容、无产物时长、错误/重试数——只给指标与指针，不给全文。
- 框架默认以低干扰方式（`inject`，不唤醒）把一份**原始活动摘要**送到 leader；频次可由 leader 自己调整或关闭，**不写死在代码里**。
- leader 需要细节时按 `body_ref` 拉原文，自行判断是正常还是异常。
- 判定异常后按轻到重处置：提醒收敛 → 调整岗位/拆任务 → 要求改用摘要或收窄收件人 → 暂停某会话 → 上报用户。
- **正常就不干预**：不因"消息多"本身动作。

#### 汇报义务（强制）

- **触发风控必须汇报**：leader 一旦判定异常并处置（哪怕只发了一条提醒），必须向用户汇报。汇报的**格式与详略由 leader 与用户按项目约定**（团队章程），框架不规定模板；但内容必须让用户能复核并决定下一步。
- **不确定就上报**：leader 无法判断时不得猜、不得自行处置，直接向用户报告"不确定，请复核"，附原始事实与建议关注点。
- 汇报走 leader 与用户的会话；不打断 worker。
- 用户未回复前，leader 保持现状，不升级处置。

给 leader 判读用的原始指标（不是框架的判定）：

| 信号 | 说明 | 注意 |
|---|---|---|
| 速率突增 | 某会话频率是自身基线的数倍 | 里程碑/交接时正常，要结合产物看 |
| 超长消息 | 单条正文异常长 | 常是贴了整段日志，建议改成引用 |
| 往复震荡 | 同一对会话短时间来回多次 | 最像"AI 互聊"的信号 |
| 重复内容 | 内容高度相似 | 去重已在投递层做，这里看是否在复述 |
| 无产物时长 | 一段时间无文件/任务状态变化 | 比消息数更能说明空转 |
| 越权投递 | 收件人不在允许范围 | 授权层拒绝；风控只做复盘 |

#### 明确不做的

| 不做 | 原因 |
|---|---|
| 每日/每会话消息预算 | 先在长任务上误伤 |
| 按条数自动熔断 | 正常讨论会被打断 |
| 框架自动决定"不投递" | 应由 leader 判断，框架只提供数据 |
| 静默丢弃消息 | 任何情况下都不丢；只做去重与折叠 |

兜底：面板可随时暂停某会话或整个团队；用户可随时叫停。所有风控动作与暂停都写日志。

### 6.8 发送权限（不属于风控）

- 谁能发给谁：策略表；默认 leader 全权，worker 只能找 leader 与指定同事。
- 越权投递由授权层直接拒绝（发送失败并回执），不是"限额"，也不会被 leader 风控覆盖。
- 消息不自动转发：一条消息不会因为被谁收到就再复制给第三方。

---

## 7. 需要自研的五件事

1. **组播投递器 + 风控数据面**（本文件第 6 节）：DSH 没有跨会话群组，官方是星型汇报；风控是"把原始事实摆给 leader"，判断与汇报归 leader，不是框架自动处置。
2. **岗位表**：跨会话唯一真相 + 变更通知；文件只是 leader 导出的视图。
3. **leader 世代交接**：新 leader 会话接管岗位表所有权、群组主控权、未完成任务；旧 leader 退役。四家参考都没有这个协议，需要定义事务与回滚。
4. **团队章程**：可配置协议的载体（见 §1.1）。插件只提供默认草案（[charter-default.md](./charter-default.md)）与读写工具，内容由 leader 与用户共同制定、随项目演进；框架不得把异常口径、汇报格式、岗位划分写成常量。
5. **用户面板**：「团队待办」（代批）与「群组消息」（只读审计）。规格见 [panels.md](./panels.md)；入口、数据模型、接口与验收判据都在里面。

---

## 8. 已知坑（直接来自参考实现）

| 坑 | 来源 | 影响 |
|---|---|---|
| `pre-step` reject 会丢已 claim 的消息 | auto-handoff §7.3 | 交接时必须放过含人类消息的批次 |
| 按 cwd 建会话不自动归属工作区 | auto-handoff §6.5 缺陷 A | 侧边栏看不到新会话 |
| 新会话是 `blank`，不刷新不显示 | auto-handoff §6.5 缺陷 B | UI 跳转失败 |
| preset 无法从选择器隐藏 | 官方 `cordis.patch.yml` 注释 | worker 模式会出现在下拉里，需命名说明 |
| `planMode`/`compaction` 在 preset realm 内 | auto-handoff §6.4 | 宿主平面读不到，要按 agent 解析 |
| 文件状态单进程串行 | agent-teams README | 多进程会不一致 |
| 模型干完活不更新状态 | agent-teams README | 需要宿主侧一致性检查 |
| fork 会把长上下文带走 | 常识 + 两家 handoff 都不 fork | 交接必须"新会话 + 交接单" |
| DSH approval 需打开的回合，且 `never` 策略下自动拒绝 | `approval` 服务契约（本次核查） | 不能用它做团队代批 |
| `agent/pre-step` 里 `return` 不等于放行 | 2026-11-20 P1c.2 事故（见 §8.1 与 [pitfall-pre-step-waterfall.md](./pitfall-pre-step-waterfall.md)） | 宿主 agent loop 抛 `Cannot read properties of undefined (reading 'kind')`，**所有会话每一轮都失败** |

### 8.1 `agent/pre-step` 是 waterfall：没调 `next()` 就是"否决且没结论"

**现象**：桌面端 App 里**所有**新会话、以及已有会话的新消息，一发就红字 `本轮运行失败 Cannot read properties of undefined (reading 'kind')`；网页端（web profile）正常。触发点是装上 P1c.2 验证插件的那一刻。

**根因**（两段代码对不上）：

1. 宿主 `dsh-agent-loop/lib/index.js:911-920` 把 pre-step 结果当决策用：
   ```js
   const decision = await this.dispatch.waterfall('agent/pre-step', {...}, () => ({ kind: 'enter', messages }))
   if (decision.kind === 'reject') return decision   // decision 为 undefined → TypeError
   ```
2. cordis 的 `ctx.waterfall`（`@deepseek-ai/cordis/lib/index.js:317-325`）**返回值 = 最外层监听器的返回值**；监听器不调 `next()` 就否决后续链（含内置的 `{ kind: 'enter' }`）。所以监听器 `return` 一个 `undefined` 不是"放行"，而是"返回 undefined 当决策"。

**事故代码**（`spike-p1c2/index.js`，已修）：
```js
ctx.on('agent/pre-step', (payload) => {
  if (!state.latch.has(id)) return        // ✗ 未上闩 = 绝大多数会话 → 全部崩
  if (human) return                       // ✗ 上闩放行 → 崩 + 用户消息被丢
  return { kind: 'reject' }               // ✓ 只有这条是对的
})
```
正确写法：
```js
ctx.on('agent/pre-step', (payload, next) => {
  if (!state.latch.has(id)) return next()
  if (human) return next()
  return { kind: 'reject' }
})
```

**离线判据**（不用起宿主，`scripts/repro-pre-step-waterfall.mjs` 同款）：用真 cordis 起一个 `Context`，注册一个"裸 return"的监听器，`await ctx.waterfall('x', {}, () => ({ kind: 'enter' }))` → 得到 `undefined`，再读 `.kind` 就复现该 TypeError；改成 `return next()` 得到 `{ kind: 'enter' }`。

**教训**：验证插件（spike）装进用户日常 profile 之前，必须先问"它挂的是哪条事件链、失败面有多大"。这次把一个每轮都会走的 waterfall 装进了 desktop profile 的 bundles，等于给整个桌面端上了个全局地雷 —— 而且 `spike-p1c2` 还带 2.5s 自动运行测试。现在 spike 已从 bundles 移出，自动运行改为 `DSH_P1C2_AUTORUN=1` 才触发。

> 本节是摘要。完整版（排查顺序、装插件前 7 问、五条硬规则、自动检查脚本用法与局限、事故时间线）见 [pitfall-pre-step-waterfall.md](./pitfall-pre-step-waterfall.md)。

---

## 9. 兼容性矩阵（本机宿主 0.2.2-rc.5）

| 方案 | 声明适配 | 能否直接装 |
|---|---|---|
| 官方 prototype | README 未写范围；源码用 `sessionController`/`agentPresets`/`workspaceRegistry` | 未验证，优先读源码 |
| oxmumu3/dsh-superagent 0.3.0 | `>=0.2.2-rc.2 <0.3.0`（macOS） | 版本匹配，平台需确认 |
| @nanmicoder/dsh-agent-teams 0.1.15 | Harness 0.1.2-alpha.2 | ❌ 不匹配 |
| dsh-plugin-agent-collaboration 0.5.0 | README 写基于 0.2.0-rc.2 构建 | ⚠️ 需实测 |
| dsh-handoff-session 0.9.0 | 0.1.x 时代开发 | ⚠️ 需实测 |
| dsh-auto-handoff 0.2.0 | `engines.dsh` 上限 0.2.1-rc.2 | ❌ 被版本拦截 |

结论：**参考可读，安装要另验**。不要用"装上去能不能跑"来判断方案价值。

---

## 10. 验证计划（P1 拆分）

| 步骤 | 内容 | 验收判据 |
|---|---|---|
| P0.5 | 团队章程：安装时给默认草案，leader 按项目补全，交用户确认 | `status: confirmed`；未确认不得建 worker/派活 |
| P1a | 创建平级根会话：指定 cwd、preset、id，挂到工作区并唤醒 | 会话真实存在；侧边栏可见；能被 prompt 唤醒跑一步；归档后仍可查；**`ask` 档下建会话前有用户授权记录** |
| P1b | 组播：leader→全部/子集、worker→leader、worker→两个同事 | 只有收件人看到；未读游标正确；正文按 ref 可取；非收件人上下文无该消息 |
| P1c | 阈值交接：宿主判定 + 闩锁 + pre-step 守卫 + 交接单 + 新会话 + leader 审批 + 归档 | 交接单自包含；旧会话归档；岗位表已更新；人类消息不被吞 |
| P1c.2 | 真实压力 + 工具申请/审批 + 人类消息守卫 | 压力来自投影；worker/leader 各调工具；上闩后人类消息仍写入 |
| P2 | 模式隔离：只有 `agent-team` 模式进入团队流程 | 其他模式无团队工具/提示词/监听；团队会话只见团队数据 |

**进度**：P1a 已于 2026-11-20 通过（`report.ok = true`），记录见 [verification-p1a.md](./verification-p1a.md)。P1b 同日晚通过（四类投递矩阵 4/4），记录见 [verification-p1b.md](./verification-p1b.md)。P1c 事务机制通过（审批与阈值触发为模拟），记录见 [verification-p1c.md](./verification-p1c.md)。

每步完成做一次备份；每步的退出码即结论。

---

## 11. 未决问题

1. 组播的"旁听"范围：leader 是否默认收到所有消息的摘要？worker 之间是否互相可见？
2. 岗位表变更的最小粒度：整表 CAS 还是按行 CAS？
3. leader 交接时，未完成任务与未读消息如何迁移？是否允许"双 leader"短暂并存？
4. worker 的 id 前缀与岗位是否绑定：换岗是否换 id？
5. 群组消息是否进会话日志（可追溯）还是只进团队存储（省上下文）？
6. 团队章程的初始化：安装时给一份默认草案，还是首次会话由 leader 起草后请用户确认？

---

## 12. 来源与核验记录

- 抓取时间：2026-11-20（Asia/Shanghai）。
- 官方 prototype 的源码结论以 `src/app/sessions.ts`、`src/executor/dsh.ts`、`cordis.patch.yml` 为准；其余为文档描述。
- 社区方案结论来自 npm README 与仓库 README，未逐行读源码；标注"可借鉴"不等于"已验证可运行"。
- 版本号与发布时间以 npm registry 返回为准（`dist-tags.latest` 与 `time` 字段）。
- 本文件是调研记录，不是最终设计；设计变更时在下方追加修订。

### 修订记录

| 日期 | 变更 |
|---|---|
| 2026-11-20 | 初稿：参考对象、能力对照、组播设计、坑与 P1 判据 |
| 2026-11-20 | 按用户反馈把"广播+过滤"修正为"组播（按收件人定向投递）" |
| 2026-11-20 | 取消消息配额与自动熔断；改为 leader 风控（只观测、不阻断），框架只做摘要折叠与去重 |
| 2026-11-20 | 风控判断完全归 leader（框架不写死阈值）；触发风控必须向用户汇报，不确定时提交人工复核 |
| 2026-11-20 | 汇报格式不固定；新增 §1.1「可配置优先」与「团队章程」，所有随项目变化的协议由 leader 与用户共同制定 |
| 2026-11-20 | 新增团队章程默认草案 `docs/charter-default.md`，作为安装时随插件提供的初始版本 |
| 2026-11-20 | 章程定稿：首个会话默认 leader、用户可直接改；开新会话权限分 `ask`/`autonomous` 两档（用户下放） |
| 2026-11-20 | 区分「派发」与「交接替换」：派发走申请档；交接替换由 leader 审批自动执行后汇报；leader 交接归用户负责 |
| 2026-11-20 | 补异常兜底：leader 不可用时，待批交接申请挂起并由用户人工代批，不自动通过、不丢弃 |
| 2026-11-20 | 明确代批载体：插件面板「团队待办」；不用 DSH approval（open turn / 工具语义 / never 策略限制） |
| 2026-11-20 | 新增前端面板草案 `docs/panels.md`：团队待办 + 群组消息（只读审计） |
| 2026-11-20 | 面板定稿：消息默认全部、不导出、批准不自动跳转、通知默认关、代码块做高亮 |
| 2026-11-20 | P1a 验证通过：根会话创建/归属/唤醒/归档/归档后可查全部满足，记录见 `docs/verification-p1a.md` |
| 2026-11-20 | P1b 验证通过：四类组播投递矩阵 4/4，简单前端注册到设置页；收据匹配 bug 已修，记录见 `docs/verification-p1b.md` |
| 2026-11-20 | 推理强度调度落地：派发前 `selectModel`，simple→off / moderate→high / complex→max；off/high/max 实测通过 |
| 2026-11-20 | P1c 事务机制通过：交接单、岗位表、继任会话、归档、归档后可查；审批与阈值触发为模拟，记录见 `docs/verification-p1c.md` |
| 2026-11-21 | P1c.2 通过：真实 token 压力（projection）、worker/leader 工具申请与审批、pre-step 闩锁与人类消息守卫；在独立 test profile 跑，日常 profile 零改动，记录见 `docs/verification-p1c2.md` |
