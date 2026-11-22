# P1c 验证记录：阈值交接事务

> 日期：2026-11-20（Asia/Shanghai）
> 宿主：DeepSeek Harness 0.2.2-rc.5
> 结论：**PASS（事务机制）**；审批与阈值触发目前由验证脚本模拟，真实工具与 UI 属后续步骤
> 证据：`.p1c/report.json`、`.p1c/handoffs/`、`.p1c/roster.json`
> 验证包：`spike-p1c/`（已卸载）

---

## 1. 验证目标

一次完整的交接事务：

1. 宿主观测到上下文达到阈值；
2. 写一份自包含交接单；
3. worker 向 leader 提出交接申请；
4. leader 批准；
5. 岗位表切换到新会话；
6. 建立继任会话并让它读交接单继续；
7. 旧会话归档；
8. 归档后旧日志仍可查。

---

## 2. 结果

| 检查项 | 结果 | 证据 |
|---|---|---|
| 阈值观测 | PASS（观测 6，阈值 2） | `checks.thresholdObserved` |
| 交接单完整 | PASS（11 个字段无缺失） | `checks.docComplete` |
| 岗位表更新 | PASS（current = `at-w-p1c-02`） | `roster.json` |
| 审批已记录 | PASS（leader 批准） | `steps.requestApproval` |
| 继任会话已回复 | PASS（`HANDOFF-OK`） | `checks.successorReplied` |
| 旧会话归档后可读 | PASS（24 条记录） | `checks.oldArchivedReadable` |

报告 `ok = true`。

---

## 3. 实际做了什么

| 步骤 | 实现 |
|---|---|
| 建会话 | `at-lead-p1c`（leader，强度 off）、`at-w-p1c-01`（worker，强度 high） |
| 产生上下文 | worker 跑一个 `WORKER-READY` 回合 |
| 阈值观测 | 读 worker 的 `events()`，统计 user/assistant 消息数（本次 6） |
| 交接单 | `.p1c/handoffs/at-w-p1c-01-<时间>.md`，含旧/新会话、岗位、目标、已完成、产物、决策、坑、下一步、未完成任务、子智能体、建议强度 |
| 申请与审批 | 写入 request `h-p1c-001` + approval（**由验证脚本模拟 leader**） |
| 岗位表 | `.p1c/roster.json`：`current = at-w-p1c-02`，`history = [old, new]` |
| 继任会话 | 建 `at-w-p1c-02`，同岗位、同强度，提示读交接单；回复 `HANDOFF-OK` |
| 归档 | 继任会话启动后归档旧会话 |
| 归档后可查 | `events()` 仍返回 24 条 |

---

## 4. 哪些是真的、哪些是模拟的

**真实验证：**

- 阈值观测（读会话事件）；
- 交接单生成与字段完整性；
- 岗位表写入；
- 新会话创建、强度设定、读交接单并回复；
- 旧会话归档；
- 归档后日志可读。

**模拟/未做：**

- **worker 的交接申请**：由脚本写入，不是 worker 通过工具发起；
- **leader 审批**：由脚本写入，不是 leader 会话真的批准；
- **阈值口径**：用消息条数代替 `tokenMeter.contextPressure`；
- **pre-step 闩锁与人类消息守卫**：未实现、未验证；
- **面板上的待办 UI**：未实现（属 P3）。

---

## 5. 清理与残留

| 项 | 状态 |
|---|---|
| `dsh-p1c-spike` | 已卸载；profile 与安装前**逐字节相同** |
| 临时备份 | 已删除（源已恢复） |
| 测试会话 | `at-lead-p1c`、`at-w-p1c-02` 保留；`at-w-p1c-01` 已归档 |
| 证据 | `.p1c/` 保留 |

> 侧边栏里会看到 P1b/P1c 的测试会话；不需要时可手动归档。

---

## 6. 下一步（P1c.2 或并入正式实现）

1. 把交接申请做成分发给 worker 的工具（仅 `at-w-*` 可用），由模型发起；
2. 把审批接到 leader 工具/面板，而不是脚本；
3. 用 `tokenMeter.contextPressure` 替代消息条数；
4. 加 `agent/pre-step` 闩锁与人类消息守卫（参考 `dsh-auto-handoff`）；
5. 交接单字段由团队章程配置，不写死。
