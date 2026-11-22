# Agent Team 模式 · 文档索引

> 目标：一个可安装的工作模式插件（bundle + preset），提供 leader/worker 团队协作、组播消息、岗位表、上下文交接与用户面板。
> 状态：设计阶段（P1a 已通过）。所有文档均为讨论稿，改动需在修订记录留痕。

| 文档 | 内容 | 状态 |
|---|---|---|
| [handover.md](./handover.md) | **★ 交接文档**：给其他对话/agent 的开工指引（现状、机制结论、铁律、待决策、验证命令） | 2026-11-20 交接 |
| [git-workflow.md](./git-workflow.md) | 版本控制与开发流程：一次性设置、pre-commit 守卫、提交/tag 约定、开源前待办 | 2026-11-21 建立 |
| [reusable-solutions.md](./reusable-solutions.md) | 官方/社区方案调研、能力对照、组播设计、已知坑、验证计划 | v0.5 讨论稿 |
| [charter-default.md](./charter-default.md) | 安装时随插件提供的团队章程默认草案（权限、交接、风控、变更） | v0.4 待用户最终确认 |
| [panels.md](./panels.md) | 前端面板规格：团队待办（代批）+ 群组消息（只读审计） | v0.2 |
| [verification-p1a.md](./verification-p1a.md) | P1a 实测记录：创建平级根会话并归档 | PASS |
| [verification-p1b.md](./verification-p1b.md) | P1b 实测记录：组播四类投递 + 简单前端 | PASS |
| [effort-policy.md](./effort-policy.md) | 推理强度调度：分级映射、机制与守则 | 设计 + 实测 |
| [verification-effort.md](./verification-effort.md) | 推理强度实测：off/high/max 写入请求头 | PASS |
| [verification-p1c.md](./verification-p1c.md) | P1c 实测记录：阈值交接事务（审批/阈值部分为模拟） | PASS（事务机制） |
| [verification-p1c2.md](./verification-p1c2.md) | P1c.2 实测记录：真实压力 + 真工具 + 人类消息守卫 | **PASS**（独立 test profile） |
| [verification-p2.md](./verification-p2.md) | P2 实测记录：模式隔离（preset 作用域）15/15 | **PASS**（独立 `p2-test` profile） |
| [verification-frontend.md](./verification-frontend.md) | 正式前端实测：侧边栏按钮 + 抽屉（待办/消息）、代批主路径 | **可用**（3 处偏差、4 项未做） |
| [pitfall-pre-step-waterfall.md](./pitfall-pre-step-waterfall.md) | **防坑文档**：`agent/pre-step` 是 waterfall，裸 `return` 会击穿所有会话（INC-2026-11-20） | 已归档，含检查清单与自动检查脚本 |

## 验证进度

| 步骤 | 内容 | 状态 |
|---|---|---|
| P0 | 调研与对标 | 完成 |
| P0.5 | 团队章程默认草案 | 草案完成，待确认 |
| P1a | 创建平级根会话 | **PASS**（见验证记录） |
| P1b | 组播（leader→全体/子集、worker→leader、worker→worker） | **PASS**（服务层；`verification-p1b.md`）。P2 重写后的**工具层**回归见 `verification-p2.md` §6.18 |
| P1b.5 | 推理强度按任务分级动态设定 | **PASS**（off/high/max 实测） |
| P1c | 阈值交接 + 审批 + 归档 | **PASS（事务机制）**；审批/阈值/工具为模拟，见验证记录 |
| P1c.2 | 真实压力 + 真工具 + 人类消息守卫 | **PASS**（独立 test profile，见验证记录） |
| P2 | 模式隔离：只有 Agent Team 模式进入团队流程 | **PASS**：15/15，独立 `p2-test` profile，见 [verification-p2.md](./verification-p2.md) |

> 2026-11-20 事故：P1c.2 的 `agent/pre-step` 监听器用裸 `return` 当"放行"，吞掉 waterfall 决策，导致**桌面端所有会话每一轮都报** `Cannot read properties of undefined (reading 'kind')`。`spike-p1c2` 已从 desktop profile 的 bundles 移出，自动运行改为 `DSH_P1C2_AUTORUN=1` 才触发。根因、修复与防线见 [pitfall-pre-step-waterfall.md](./pitfall-pre-step-waterfall.md)；日常体检命令：
> ```bash
> node scripts/guard-daily-profile.mjs   # exit 0 = 没有测试插件污染日常 profile
> ```

## 术语

- **模式**：GUI 模式选择器中的一项，即 DSH 的 agent preset。
- **Leader**：只做汇报、转达、建会话、派活、定岗位的会话。
- **Worker**：执行单一岗位模块的会话，可开子智能体。
- **组播**：一条消息发给明确的收件人集合（单个 / 多个 / 全部 / 按岗位）。
- **团队章程**：可配置协议的载体，由 leader 与用户共同制定。

## 仓库结构（当前）

```
docs/                 设计与验证文档（防坑文档见 pitfall-pre-step-waterfall.md）
plugin/               预览插件（Host 组播服务 + 设置页消息面板，当前已安装）
scripts/              验证与防护脚本：
                        guard-daily-profile.mjs       日常 profile 体检（exit 0 = 干净）
                        repro-pre-step-waterfall.mjs  离线复现 waterfall 吞决策
                        verify-p1b.mjs                P1b 独立验证
spike-p1a/            P1a 验证用临时 bundle（未安装；可复现）
spike-effort/         P1b.5 推理强度验证用临时 bundle（未安装；可复现）
spike-p1c/            P1c 阈值交接验证用临时 bundle（未安装；可复现）
spike-p1c2/           P1c.2 验证用 bundle（已从 desktop bundles 移出；自动运行需 DSH_P1C2_AUTORUN=1）
.p1a/                 P1a 运行证据（report.json / spike.log）
.p1b/                 P1b 运行证据（state.json / report.json / bodies / effort-report.json）
.p1c/                 P1c 证据（report.json / roster.json / handoffs）
.p1c2/                P1c.2 证据（report.json；本次运行结论作废）
```
