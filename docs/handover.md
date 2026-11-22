# 交接：Agent Team 模式（Handover）

> 交接时间：2026-11-20 20:57（Asia/Shanghai）
> 交接人：lead 会话（DeepSeek Harness desktop profile）
> 接手对象：**另一个对话/另一个 agent**。读完这一份就能开工，不需要回看原会话。
> 交接时的状态：**可用**。桌面端已恢复正常，测试插件已隔离，事故已建档。

---

## 0. 30 秒读完

- **在做什么**：给 DSH 做一个「Agent Team」工作模式插件 —— leader/worker 分工、组播消息、岗位表、上下文交接、用户面板。
- **做到哪了**：P0/P1a/P1b/P1b.5/P1c/P1c.2/P2 全部通过；**P2（模式隔离）2026-11-21 在独立 `p2-test` profile 实测 15/15**（见 `docs/verification-p2.md`）；下一阶段是正式前端（侧边栏 + 抽屉）。
- **今晚出过大事**：我的 P1c.2 测试插件被装进 desktop profile 的 `bundles`，钩子写错（waterfall 裸 `return`），导致**桌面端所有会话每一轮都报** `Cannot read properties of undefined (reading 'kind')`。已修复、已隔离、已写防坑文档。
- **你现在要做的三件事**：①跑一遍体检确认干净；②读防坑文档再碰钩子；③做正式前端（侧边栏 + 抽屉）——P2 已完成。

---

## 1. 项目是什么

**目标**：可安装的工作模式插件（bundle + preset），提供 leader/worker 团队协作。

| 术语 | 含义 |
|---|---|
| 模式 | GUI 模式选择器里的一项，即 DSH 的 agent preset |
| Leader | 只做汇报、转达、建会话、派活、定岗位 |
| Worker | 执行单一岗位模块的会话，可开子会话/子智能体 |
| 组播 | 一条消息发给明确的收件人集合（单个/多个/全部/按岗位） |
| 团队章程 | 可配置协议的载体，安装时给默认草案，由 leader 与用户共同确认 |

**设计原则**：可配置优先，不写死；工作区固定为 `<repo>`。

---

## 2. 已完成与结论（判据优先，别只看"完成"两个字）

| 阶段 | 内容 | 状态 | 证据 |
|---|---|---|---|
| P0 | 调研与对标（官方 prototype / 社区 4 家） | 完成 | `docs/reusable-solutions.md` §2–§5 |
| P0.5 | 团队章程默认草案 | 草案，**待用户确认** | `docs/charter-default.md` |
| P1a | 创建平级根会话并归档 | **PASS** | `docs/verification-p1a.md`，`.p1a/report.json` |
| P1b | 组播四类投递 + 只读面板 | **PASS** | `docs/verification-p1b.md`，`.p1b/report.json`、`.p1b/demo.done` |
| P1b.5 | 推理强度按任务分级动态设定 | **PASS**（off/high/max 实测） | `docs/verification-effort.md`，`.p1b/effort-report.json` |
| P1c | 阈值交接事务（审批/阈值/工具**为模拟**） | **PASS（仅事务机制）** | `docs/verification-p1c.md`，`.p1c/report.json` |
| P1c.2 | 真实 token 压力 + 真交接工具 + 人类消息守卫 | **PASS**（2026-11-21 独立 test profile 重跑） | `docs/verification-p1c2.md`，`.p1c2/report.valid.json` |
| P2 | 模式隔离（只有 Agent Team 模式进团队流程） | **PASS**（15/15） | `docs/verification-p2.md`，`.p2/report.json`，`agent-team/` |

⚠️ **不要引用 `.p1c2/report.json` 的失败率**当作交接协议不行；那份数据被 bug 污染了。

---

## 3. 目录地图

```
docs/                设计与验证文档
  README.md            索引（先看这个）
  reusable-solutions.md  调研 + 组播设计 + 已知坑（§8.1 是今晚事故摘要）
  pitfall-pre-step-waterfall.md  ★ 防坑文档（写钩子前必读）
  charter-default.md    团队章程草案
  panels.md             前端面板规格
  verification-p1*.md   各阶段实测记录
plugin/              ★ 预览插件（已装进 desktop profile）
  index.js             Host：会话管理 + 组播投递 + 4 条 HTTP 路由
  client.js            设置页只读面板（slots 注入）
  cordis.patch.yml     插件自己的 patch 层
spike-p1a/            P1a 验证用临时 bundle（现未激活）
spike-effort/         P1b.5 推理强度验证用（未激活）
spike-p1c/            P1c 阈值交接验证用（未激活）
spike-p1c2/           P1c.2 验证用（★ 已修复，现未激活，见 §7）
scripts/
  guard-daily-profile.mjs       ★ 日常 profile 体检（exit 0 = 干净）
  repro-pre-step-waterfall.mjs  ★ 离线复现 waterfall 吞决策
  verify-p1b.mjs                P1b 投递矩阵复核（会重写 .p1b/report.json）
.p1a/ .p1b/ .p1c/ .p1c2/        各阶段运行证据（JSON 为主）
.diag/               备份与临时脚本（按时间戳分目录，含 SHA256 记录）
```

**git（2026-11-21 起）**。`main` 分支保持可运行；基线 `p1c2-pass` 对应 P1c.2 通过后的状态。历史 `.diag/backup-*`、`.diag/fixed-*`、`.diag/verified-*` 仍保留（文档有引用），但**新改动一律走 commit + tag**，不再新增拷贝式备份。工作流见 `docs/git-workflow.md`。

---

## 4. 已实测的机制结论（可直接照抄，别再重新摸）

### 4.1 会话与投递（P1a/P1b 验证过）

| 能力 | 调用 | 实测结果 |
|---|---|---|
| 解析会话 | `ctx.sessionController.resolveAgent(id)` | 返回 `{ agent }` 或 `{ error: { code } }`（不存在是 `session/not-found`） |
| 建会话 | `ctx.sessionController.create({ sessionId, workspaceId, agentPreset })` | 建出来是持久会话，`agentPreset` 可用 `standard` |
| 投递消息 | `ctx.sessionController.prompt({ requestId, sessionId, mode:'queue', content:[{type:'text',text}], clientTimeZone }, signal)` | `mode:'queue'` 排队不打断当前回合；`requestId` 自定但要唯一 |
| 查会话事件 | `ctx.sessionController.events({ address:{ kind:'session', sessionId }, maxMessages }, signal)` | `page.records[].event.type`，如 `user/message`、`assistant/message`；这是**审计回执**的来源 |
| 定强度 | `ctx.sessionController.selectModel({ sessionId, provider, model, reasoningEffort })` | 返回 `applied.selected.reasoningEffort`；off/high/max 实测写入请求头 |
| 取默认模型 | `ctx.agentDefaultModel.currentSelection()` | 拿 `{ provider, model }` 再配强度 |
| 工作区 | `ctx.workspaceRegistry.resolveByPath(p)` / `.create(p, name)` / `.archiveSession(id, { stopActivity:true })` | 归档后 pre-step 会被宿主自动拦（archived gate） |
| 压力 | `ctx.tokenMeter.contextPressure(agent.session)` | `{ pressureTokens, contextWindow }`；比值超过阈值才触发交接 |
| 注册工具 | `ctx.tools.register({ name, description, parameters, output:{schema,render}, execute })` | 工具返回结构化值；`exec.agent.id` 可判角色（如只允许 `at-w-*` 调） |
| 注册 HTTP | `ctx.webServer.register({ kind:'prefix', path:'/xxx', handler })` | 面板数据走同源路由；记得只允许 loopback |

### 4.2 客户端面板（P1b 验证过）

`window.__ModuleLoader__.load({ id, factory(require) })` → `ctx.slots.inject('settings.section', () => ctx.slots.register({ name, id, order, label }, Panel))`。
面板是只读的：定时 `fetch('/agent-team/state')` + `/agent-team/report` + `/agent-team/body?id=`。

### 4.3 ★ 两条必须记住的语义坑

1. **`agent/pre-step` 是 waterfall**：返回值 = 最外层监听器的返回值；**不调 `next()` 等于否决整条链**；裸 `return` 会抛出 `Cannot read properties of undefined (reading 'kind')`，**所有会话每一轮都炸**。详见 `docs/pitfall-pre-step-waterfall.md`。
2. 同族还有 `agent/request`、`agent/request-error`、`system-prompt/assemble` 也是 waterfall；`agent/turn-stopping` 是 **serial**（不返回值 = 继续），两者语义别混。

---

## 5. 事故建档：INC-2026-11-20-PRESTEP

- **现象**：桌面端所有新会话/新消息红字 `本轮运行失败 Cannot read properties of undefined (reading 'kind')`；网页端正常（`web` profile 没装肇事插件）。
- **根因**：`spike-p1c2` 的 `agent/pre-step` 监听器用裸 `return` 表达"放行"，把 `undefined` 当决策交回宿主。
- **放大因素**：该插件被写进 desktop profile 的 `bundles`（启动即加载）、且 `apply()` 里带 `setTimeout(2500, run)` 自动跑测试。
- **修复**：改 `return next()`；自动运行改为 `DSH_P1C2_AUTORUN=1` 才触发；从 `bundles` 移出；桌面端 20:52:54 重启验证通过。
- **连带损失**：`.p1c2` 那次运行数据作废；用户当晚桌面端不可用数小时。
- **完整版**（含排查顺序、五条硬规则、装插件前 7 问、脚本用法与局限）：`docs/pitfall-pre-step-waterfall.md`。

---

## 6. 环境与铁律

**环境**
- 本机 DSH：npm 安装 `0.2.0-rc.2`（我核查源码用这个）；桌面端另有 Electron 打包安装 `C:\Software\DSH`，**desktop profile 由 Electron 独占管理**，`dsh --profile desktop --dump-config` 会直接报错，属正常。
- profile 位置：`~/.dsh/profiles/{desktop,web,headless}`；每个 profile 的 `package.json` 里 `dsh.profile.bundles` 决定**启动时加载什么**。
- 桌面端改动插件的生效方式：**重启 App**（client 插件另说，需要 `pnpm run dev:web` 才有 HMR）。

**铁律（都是踩出来的）**
1. `*-spike` / `*-test` **永不**进日常 profile 的 `bundles`；要跑用独立 profile 或 `--patch` 临时叠加。
2. 任何 waterfall 监听器必须带 `next`，放行一律 `return next()`；否决返回合法决策对象。
3. `apply()` 里任何自动干活（`setTimeout` 等）必须默认关闭、显式开关。
4. 改 profile / 装插件后先跑体检，`exit 0` 才允许重启：
   ```bash
   node scripts/guard-daily-profile.mjs
   ```
5. 每完成一个可验收的步骤就**提交并打 tag**（`git commit` + `git tag <阶段>-<步骤>`）；里程碑另做一次 `.diag/` 异地快照（git 防误改，不防整个目录被删）。提交由 `.githooks/pre-commit` 自动跑体检，ERROR 不许提交。
6. 报告结论必须区分「实测」与「推断」，并写清入口（tool 还是 CLI）、字段名、数据来源。

---

## 7. 怎么验证（三条命令，判据是退出码）

```bash
# 1) 日常 profile 有没有被测试插件污染
node scripts/guard-daily-profile.mjs
#    期望：exit 0（当前 0 warn；1 INFO：desktop 里有一个休眠的 p1c2 spike 依赖，不在 bundles，不随启动加载）

# 2) waterfall 语义是否还是我们认知的那样（10 秒）
node scripts/repro-pre-step-waterfall.mjs
#    期望输出含 not latched -> undefined / CRASH: TypeError / fixed -> { kind: 'enter' }

# 3) P1b 投递矩阵复核（可选）
node scripts/verify-p1b.mjs
#    ⚠️ 会重写 .p1b/report.json。它从 ~/.dsh/sessions/--C-Work~0020Place-AgentWorkTeam--/
#    的会话日志倒推投递结果（原始插件回执扫描有 marker 匹配 bug，这份才算权威）。
#    依赖那批 P1b 会话日志还在；清过 sessions 目录就别跑。
```

**P1c.2 重跑**（目前未激活，需要时按下面做）：
- 方式 A：临时 profile + `--patch` 叠加 `spike-p1c2/cordis.patch.yml`；
- 方式 B：把它加回某个**非日常** profile 的 `bundles`，并 `set DSH_P1C2_AUTORUN=1`；
- 跑前确认 `.p1c2/run.lock` 不存在（脚本 finally 会删，异常退出可能残留）；证据写到 `.p1c2/report.json`。

**P2 验收**（独立 `p2-test` profile，约 15 秒，判据 = `.p2/report.json` 的 `ok`）：完整命令见 `docs/verification-p2.md` §6。要点：`guard` 先 exit 0 → 用 `--patch` 叠加 `agent-team/` 与 `spike-p2/` → `DSH_P2_AUTORUN=1` 启动 → 读 `.p2/report.json`。**永远不要把这两个包写进日常 profile 的 `bundles`。**

---

## 8. 待办与待决策（接手方不要擅自决定）

| # | 事项 | 谁定 | 备注 |
|---|---|---|---|
| 1 | `dsh-agent-team-preview` 是否继续留在日常 profile | **已定：摘除** | 2026-11-20 已从 desktop profile 移除；正式前端后续重做（侧边栏 + 抽屉） |
| 2 | P1c.2 重跑的时间与方式 | **已完成** | 在独立 `p1c2-test` profile 重跑通过，跑完已删除该 profile；见 `docs/verification-p1c2.md` |
| 3 | 团队章程草案（P0.5）最终确认 | **用户** | `docs/charter-default.md` 目前是草案 |
| 4 | P2 模式隔离的技术路线 | **已定：preset 作用域** | 2026-11-21 落地并实测：工具注册在 preset 的 scope 里，Host 只提供状态、不注册工具；见 `docs/verification-p2.md` §2 |
| 5 | 交接协议里"审批"是否要接真审批服务 | 用户 | P1c 的审批是模拟的 |

---

## 9. 建议的开工顺序

1. 读 `docs/README.md`（索引）→ 读 `docs/pitfall-pre-step-waterfall.md`（防坑）。
2. 跑 §7 的三条命令，确认现状与本文一致（不一致就先查，不要直接改代码）。
3. 与用户确认 §8 的 1、2 两项，再决定是"重跑 P1c.2"还是"直接进 P2"。
4. 动代码前先备份；每次改完先跑体检，再重启，再验证。

---

## 10. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-20 20:57 | 建立本文档（交接给其他对话）；同期完成事故修复与防坑文档 |
| 2026-11-21 00:10 | 摘除 preview 插件；用独立 `p1c2-test` profile 重跑 P1c.2 并通过（真实压力 / 工具申请审批 / 人类守卫）；guard exit 0；见 `docs/verification-p1c2.md` |
| 2026-11-21 00:40 | 建立 git 仓库（基线 tag `p1c2-pass`）+ pre-commit 守卫；更正本文「没有 git」与铁律 5；新增 `docs/git-workflow.md` |
| 2026-11-21 00:50 | **P2 落地并通过**：新建 `agent-team/` bundle（Host 状态 + 两个 preset 作用域工具），独立 `p2-test` profile 实测 15/15；见 `docs/verification-p2.md`。同时更正：桌面端运行时是 `0.2.2-rc.5`（不是 npm 的 0.2.0-rc.2） |

---

## 11. P2 开工提示（已于 2026-11-21 落地，见 `docs/verification-p2.md`）

> 本节保留为设计依据。实际实现与此处建议一致：bundle 声明两个 preset、Host 只放共享状态、
> 工具挂 preset 作用域、去掉安装即跑、会话侧按 `ctx.agentPresets` 判身份。
> 与原文的差异：没有用 `header.agentPreset` 过滤（0.2.2-rc.5 改用投影），见验证记录 §2。

**目标**：只有 `agent-team` 模式进入团队流程，其他模式零影响。

1. Bundle 声明两个 preset：
   - `agent-team`（leader 角色）；
   - `agent-team-worker`（worker 角色；名称/描述注明“由 leader 自动创建，请勿手选”）。
2. 共享状态放 Host 层（组播存储、岗位表、待办）；**工具与提示词挂 preset 作用域**，其他模式加载不到。
3. 去掉“安装即跑”的演示；建会话/派活只能由团队工具触发。
4. 所有会话侧监听器按 `agent.session.header.agentPreset` 过滤。
5. 验收：
   - 标准模式无任何团队工具；
   - `agent-team` 会话工具出现、可当 leader；
   - leader 建出的 worker 是 `agent-team-worker`；
   - 两个团队会话共享同一存储；
   - 其他模式会话调不到团队工具。

**安全约束**：先在独立 profile 验证；不把测试包放进 desktop 的 `bundles`；每步先 `guard-daily-profile.mjs`（exit 0）再重启。leader 身份与“派发/交接”权限沿用 `charter-default.md` §3。

---

## 12. P2 之后怎么走（2026-11-21 01:35 更新）

### 12.1 现状的准确说法

- **模式已经有了，但只存在于隔离 profile**：`p2-test`（`--patch` 叠加），你要日常用必须先装进桌面端。
- **已经有真实一轮**：`agent-team` 模式的会话跑通了一次模型对话，模型自己调了 `team_roster` → `team_spawn_worker`，拿到 `needs_user_approval`。证据见 `docs/verification-p2.md` §6.5 与截图 `docs/assets/agent-team-live-turn.png`。

### 12.2 P3：装进桌面端（"增添 Agent Team 模式"的交付点）

**装/卸/查状态都有脚本，别手改 `package.json`：**

```bash
node scripts/desktop-bundle.mjs status     # 看装没装
node scripts/desktop-bundle.mjs install    # 装（自动先备份 package.json + cordis.patch.yml 带 SHA256）
node scripts/desktop-bundle.mjs uninstall  # 卸（同样先备份）
node scripts/guard-daily-profile.mjs       # 必须 exit 0 才允许重启
```

1. `desktop-bundle.mjs install`（备份 → 加 dependency + bundles → 建 junction）；
2. `guard-daily-profile.mjs` → **exit 0**；
3. **重启桌面端**（由用户执行；CLI 无法 dump desktop profile，组合只能重启后在 GUI 里看）；
4. 重启后验收：模式选择器出现 `Agent Team · Leader` / `Agent Team · Worker`；侧边栏底部出现 Agent Team 按钮；用 Leader 开一个会话说一句话，看它派活或申请；
5. **观察期**：重点确认非团队会话一切照常（守卫监听器只挂在 worker preset 作用域，p2-test 已实测标准会话进不了它的视野）；
6. 回滚：`node scripts/desktop-bundle.mjs uninstall` → `guard` exit 0 → 重启。

> 当前状态（2026-11-21 01:53）：步骤 1–2 已完成，`guard` = 0 error / 1 warning（工作区 link，预期）/ 1 info，**等用户重启**。
> 磁盘上已有的自动备份：`.diag/backup-desktop-20261121-015111/`（package.json + cordis.patch.yml + SHA256SUMS.txt）。

**清场（演练/测试数据弄脏团队时）**：

```bash
curl -X POST http://127.0.0.1:<当前GUI端口>/agent-team/admin/reset \
  -H "content-type: application/json" -d '{"confirm":"RESET"}'
```

岗位表、消息、申请、上闩、日志全部归零，派发权限保留当前档位。**注意**：团队 store 在 `<workspaceRoot>/.team/`，是**按工作区**共享的——p2-test 与 desktop 用同一个工作区，所以测试数据会出现在桌面端。这也意味着"一个工作区只有一个团队"是既定设计，不是 bug。

风险比 `INC-2026-11-20-PRESTEP` 低：监听器只在 preset 作用域、非否决分支一律 `return next()`、`apply()` 零自动运行。但**它仍然是往日常 profile 装东西**，按上面 6 步走。

### 12.3 已定的两个决策（2026-11-21）

| # | 问题 | 决定 | 实现 |
|---|---|---|---|
| 1 | 第二个 `agent-team` 会话怎么办 | **不接受多个 leader 并存**；团队做深靠 worker 挂子智能体 | 第二个会话调 leader 工具直接报错；不自动接管 |
| 2 | 审批路径 | leader → 用户（派发）；worker → leader（交接）；**只有 leader 宕机时用户才代批** | `pendingActions()` 带 `awaiting`；`approveHandoff(id,'user')` 在 leader 在线时拒绝；面板对"等 leader"的申请不给批准按钮 |
| 3 | 完全权限（新增需求） | **leader 可跳过用户审批直接派发**，由用户随时开关 | 面板「待办」顶部开关；`POST /agent-team/authority`；每次自主派发写 `spawnLog`，切换写 `authorityLog`；模型无权修改 |

`spawnAuthority` 的运行时档位存在团队 store 里（用户面板可切），bundle 配置里的 `spawnAuthority` 只是首次初始化时的默认值。

### 12.4 P4：正式化与开源

**已做**：打包（tgz，10 个文件含 LICENSE）；`LICENSE`（MIT）/ `README.md` / `CONTRIBUTING.md`；「完全权限」档；**leader 移交**（面板 `/admin/promote-leader`，§6.10）——即原计划的"leader 归档后用户接管"；两个 preset 的工具清单改为从 `standard` 生成（`scripts/gen-preset-tools.mjs`，已接进 pre-commit；顺带补上 worker 缺失的 `delegation` 组）；面板时间/收件人/状态筛选与 SSE；交接的**「要求补充」路径**。

**还剩**：桌面通知（用户 2026-11-21 明确不做）、交接单的版本 diff（`revisions` 只记摘要）。四条尾巴已全部收口：leader 移交、preset 生成、要求补充、消息分页；另外补了 **store 保留策略**（超上限归档、不删）。
