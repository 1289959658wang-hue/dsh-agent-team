<a id="zh"></a>

# Agent Team 模式 · 文档索引

> 中文 ｜ [English](#en)

面向使用者的入口是根目录 [`README.md`](../README.md)；这里是更细的设计、实测与防坑记录。
当前版本 **1.10.0**。

> **语言**：面向使用者的文档（README、CONTRIBUTING、本索引、panels、charter、effort-policy、verification-install、GUIDE）已中英双语；`verification-*.md` 与 `CHANGELOG` 是过程证据，保持中文。

## 使用者需要读的

| 文档 | 内容 |
|---|---|
| [GUIDE.md](./GUIDE.md) | **完整手册**：安装、使用流程、架构、逐项功能、工具参考、HTTP 接口、数据模型、配置、验收、排错、回退 |
| [verification-install.md](./verification-install.md) | 安装实测：GitHub 直接安装、组合后的配置、运行时路由、默认工作区推导、未验证项 |
| [panels.md](./panels.md) | 面板规格：待办（代批）+ 消息（只读审计） |
| [charter-default.md](./charter-default.md) | 团队章程默认草案（权限、交接、风控、变更） |
| [effort-policy.md](./effort-policy.md) | 推理强度调度：分级映射、机制与守则 |

## 设计与调研

| 文档 | 内容 |
|---|---|
| [reusable-solutions.md](./reusable-solutions.md) | 官方/社区方案调研、能力对照、组播设计、已知坑、验证计划 |
| [delivery-visibility.md](./delivery-visibility.md) | 投递可见性：队列深度、投递结果判定、`team_status` 规格 |
| [agent-team/docs/DETAIL.md](../agent-team/docs/DETAIL.md) | 插件内部结构（改代码前看） |

## 防坑

| 文档 | 内容 |
|---|---|
| [pitfall-pre-step-waterfall.md](./pitfall-pre-step-waterfall.md) | **必读**：`agent/pre-step` 是 waterfall，裸 `return` 会击穿所有会话（INC-2026-11-20），含检查清单与自动检查脚本 |

## 实测记录（按时间）

| 文档 | 结论 |
|---|---|
| [verification-p1a.md](./verification-p1a.md) | P1a：创建平级根会话并归档 — PASS |
| [verification-p1b.md](./verification-p1b.md) | P1b：组播四类投递 + 简单前端 — PASS |
| [verification-effort.md](./verification-effort.md) | 推理强度 off/high/max 写入请求头 — PASS |
| [verification-p1c.md](./verification-p1c.md) | P1c：阈值交接事务（审批/阈值为模拟）— PASS（事务机制） |
| [verification-p1c2.md](./verification-p1c2.md) | P1c.2：真实压力 + 真工具 + 人类消息守卫 — PASS |
| [verification-p2.md](./verification-p2.md) | P2：模式隔离（preset 作用域），115 → 121 条断言 — PASS |
| [verification-frontend.md](./verification-frontend.md) | 正式前端：侧边栏 + 抽屉实测，含多工作区下拉与两轮事故复盘 |
| [verification-install.md](./verification-install.md) | 安装（对外发布用） |

## 维护者记录

| 文档 | 内容 |
|---|---|
| [handover.md](./handover.md) | 阶段交接：现状、机制结论、铁律、待决策、验证命令 |
| [handoff-multi-workspace.md](./handoff-multi-workspace.md) | 多工作区改造的交接书（四步计划与回退点） |
| [git-workflow.md](./git-workflow.md) | 版本控制与开发流程：一次性设置、pre-commit 守卫、提交/tag 约定、回退点阶梯 |

## 术语

- **模式**：GUI 模式选择器中的一项，即 DSH 的 agent preset。
- **Leader**：做汇报、建会话、派活、定岗位的会话。
- **Worker**：执行单一岗位模块的会话，可开子智能体。
- **组播**：一条消息发给明确的收件人集合（单个 / 多个 / 全部 / 按岗位）。
- **团队章程**：可配置协议的载体，由 leader 与用户共同制定。
- **上闩（latch）**：交接申请发出后，禁止旧会话继续开新步骤的状态。

---

<a id="en"></a>

# Agent Team · Documentation index

> [中文](#zh) ｜ English

The entry point for users is [`README.md`](../README.md) at the repository root; this page indexes the
deeper design, verification and pitfall records. Current version **1.10.0**.

## For users

| Document | Contents |
|---|---|
| [GUIDE.md](./GUIDE.md) | **Full manual**: install, workflow, architecture, feature-by-feature notes, tool reference, HTTP API, data model, configuration, acceptance, troubleshooting, rollback |
| [verification-install.md](./verification-install.md) | Install verification: direct GitHub install, composed config, runtime routes, default-workspace resolution, open items |
| [panels.md](./panels.md) | Panel specification: pending items (approvals) and messages (read-only audit) |
| [charter-default.md](./charter-default.md) | Default team charter draft (authority, handoff, risk control, change management) |
| [effort-policy.md](./effort-policy.md) | Reasoning-effort scheduling: tier mapping, mechanism and rules |

## Design and research

| Document | Contents |
|---|---|
| [reusable-solutions.md](./reusable-solutions.md) | Survey of official/community approaches, capability comparison, multicast design, known traps, verification plan |
| [delivery-visibility.md](./delivery-visibility.md) | Delivery visibility: queue depth, delivery verdicts, the `team_status` contract |
| [agent-team/docs/DETAIL.md](../agent-team/docs/DETAIL.md) | Plugin internals (read before changing code) |

## Pitfalls

| Document | Contents |
|---|---|
| [pitfall-pre-step-waterfall.md](./pitfall-pre-step-waterfall.md) | **Must read**: `agent/pre-step` is a waterfall; a bare `return` breaks every session on the host (INC-2026-11-20), with a checklist and an automated check script |

## Verification records (chronological)

| Document | Result |
|---|---|
| [verification-p1a.md](./verification-p1a.md) | P1a: create and archive a peer root session — PASS |
| [verification-p1b.md](./verification-p1b.md) | P1b: four multicast delivery paths + a simple panel — PASS |
| [verification-effort.md](./verification-effort.md) | Reasoning effort off/high/max reaches the request header — PASS |
| [verification-p1c.md](./verification-p1c.md) | P1c: threshold handoff transaction (approval/threshold simulated) — PASS (transaction mechanism) |
| [verification-p1c2.md](./verification-p1c2.md) | P1c.2: real pressure + real tools + human-message guard — PASS |
| [verification-p2.md](./verification-p2.md) | P2: mode isolation (preset scope), 115 → 121 assertions — PASS |
| [verification-frontend.md](./verification-frontend.md) | Production UI: sidebar + drawer, including the multi-workspace dropdown and two incident reviews |
| [verification-install.md](./verification-install.md) | Installation (for public release) |

## Maintainer records

| Document | Contents |
|---|---|
| [handover.md](./handover.md) | Phase handover: current state, mechanism conclusions, hard rules, open decisions, verification commands |
| [handoff-multi-workspace.md](./handoff-multi-workspace.md) | Handover for the multi-workspace refactor (four-step plan and rollback points) |
| [git-workflow.md](./git-workflow.md) | Version control and development flow: one-time setup, pre-commit guard, commit/tag conventions, rollback ladder |

## Glossary

- **Mode**: one entry in the GUI mode selector, i.e. a DSH agent preset.
- **Leader**: the session that reports, creates sessions, dispatches work and assigns roles.
- **Worker**: a session executing a single role; it may spawn sub-agents.
- **Multicast**: one message delivered to an explicit set of recipients (one / several / all / by role).
- **Team charter**: the carrier for configurable protocol, agreed by the leader and the user.
- **Latch**: after a handoff request is filed, the old session may not start new steps.
