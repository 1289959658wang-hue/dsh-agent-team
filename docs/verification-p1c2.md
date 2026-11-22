# P1c.2 验证记录：真实压力 + 真工具 + 人类消息守卫

> 日期：2026-11-21 00:08（Asia/Shanghai）
> 结论：**PASS**
> 证据：`.p1c2/report.valid.json`（本次）、`.p1c2/report.crash-invalid.json`（事故那次，作废）
> 运行环境：**独立测试 profile `p1c2-test`**（从 web 模板创建，跑完已删除）；宿主为 npm 安装的 DSH `0.2.0-rc.2`
> 日常 desktop profile：**全程未安装、未重启、未改动**

---

## 1. 验证目标

| # | 目标 |
|---|---|
| 1 | 用真实 token 压力（不是消息条数）触发交接 |
| 2 | worker 通过**工具**发起交接申请 |
| 3 | leader 通过**工具**批准 |
| 4 | `agent/pre-step` 闩锁 + **人类消息守卫**：上闩后人类消息不被吞 |
| 5 | 交接单、岗位表、继任会话、归档、归档后可查 |

---

## 2. 结果（全部 PASS）

| 检查 | 结果 | 证据 |
|---|---|---|
| 真实压力观测 | PASS（`pressureTokens=15247`，`contextWindow=1000000`，ratio `0.015247`，来源 `projection`） | `steps.pressure` |
| 人类消息守卫 | PASS（上闩后 `HUMAN-PING` 仍写入会话） | `checks.humanGuard` |
| worker 工具申请 | PASS（`h-mwp69jb2`，status pending → approved） | `requests.json` |
| leader 工具批准 | PASS（`approvedBy: at-lead-p1c2e`） | `checks.leaderApproved` |
| 岗位表更新 | PASS（`current: at-w-p1c2e-02`） | `roster.json` |
| 继任会话回复 | PASS（`HANDOFF-OK`） | `checks.successorReplied` |
| 旧会话归档后可读 | PASS（日志 34080 字节仍在） | `checks.oldArchivedReadable` |

`report.valid.json` 的 `ok` 为 `true`。

---

## 3. 这次和 P1c 的区别

| | P1c | P1c.2 |
|---|---|---|
| 压力 | 消息条数 | `sessionProjections` 的 `contextPressure` 投影（真实 token） |
| 申请 | 脚本写入 | worker 调用 `team_handoff_request` 工具 |
| 审批 | 脚本写入 | leader 调用 `team_handoff_approve` 工具 |
| 闩锁/守卫 | 无 | `agent/pre-step` 闩锁 + 人类消息放行（`return next()`） |
| 环境 | desktop profile | **独立 test profile**，日常 profile 零改动 |

---

## 4. 跨版本 API 差异（重要）

测试宿主是 npm `0.2.0-rc.2`，与 desktop 的 `0.2.2-rc.5` 有三处不同，重跑时已适配：

| 能力 | 0.2.0-rc.2（test） | 0.2.2-rc.5（desktop） | 适配 |
|---|---|---|---|
| 上下文压力 | 无 `tokenMeter.contextPressure()` | 有 | 用 `sessionProjections.stateOf(session, 'contextPressure')` |
| 读会话事件 | 无 `sessionController.events()` | 有 | 用 `agent.session.deriveMessages()` |
| 默认模型 | web 模板是 `deepseek-official`（本次 402 余额不足） | desktop 配的是 `deepseek-account` | 测试 profile 的 patch 覆盖 `agent-default-model` |

还踩了一个跨进程坑：**桌面端正在运行的会话不能被另一个 host 重新创建**（`session "..." is already owned by an active write handle`）。所以测试用全新 session id，不复用 desktop 的 `at-*` 会话。

---

## 5. 安全措施（这次为什么不会再炸日常端）

- 测试 profile 从 web 模板新建，**只在 `p1c2-test` 的 bundles 里装 spike**；
- 桌面端 profile 全程未安装 spike、未重启；
- 跑完删除整个 `p1c2-test` profile；
- `guard-daily-profile.mjs` 复跑：**exit 0**（0 error；仅 1 INFO：desktop 里有一个休眠的 spike 依赖，不在 bundles 中，不随启动加载）。

---

## 6. 仍未做

1. **拒绝路径**：本次只验证了“上闩 + 人类消息 → 放行”，没有构造“上闩 + 非人类消息 → reject”的可控场景；
2. **审批 UI**：leader 通过工具批准，但还没有面板待办；
3. **工具作用域**：两个工具仍是全局注册，靠 session id 前缀判角色；P2 会改成 preset 作用域；
4. **自动压力巡检**：本次是测试脚本读一次压力后手动触发；还没有常驻 watcher。

---

## 7. 残留物

| 项 | 状态 |
|---|---|
| `p1c2-test` profile | 已删除 |
| spike 在 desktop 的依赖 | 休眠（不在 bundles），guard 只报 INFO |
| 测试会话 | `at-lead-p1c2e`、`at-w-p1c2e-02` 保留；`at-w-p1c2e-01` 已归档；侧边栏可能可见，可手动归档 |
| 证据 | `.p1c2/report.valid.json`、`requests.json`、`roster.json`、`handoffs/` |
| 事故那次报告 | `.p1c2/report.crash-invalid.json`（保留作对照，不引用） |
