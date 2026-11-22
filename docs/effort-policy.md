# 推理强度调度（effort policy）

> 状态：设计 + 已实测（2026-11-20）
> 结论：派发任务时可以按任务复杂度动态设定推理强度，`off / low / high / max` 四档均有效。

---

## 1. 为什么需要

第一次组播实测（P1b）里，新会话的请求头全部是：

```json
"config": { "provider": "deepseek-account", "model": "deepseek-flash", "reasoningEffort": "max" }
```

原因是插件建会话时没有显式选择模型/强度，会话落到了模型目录的默认档。对简单任务用 `max` 既慢又贵。

---

## 2. 机制（实测）

建会话、激活后，在投递任务前调用：

```js
await ctx.sessionController.selectModel({
  sessionId,
  provider: base.provider,   // 例如 deepseek-account
  model: base.model,         // 例如 deepseek-flash
  reasoningEffort: 'off',    // off | low | high | max
})
```

然后 `prompt({ mode: 'queue', ... })`。

实测（`spike-effort`，已卸载）：三个会话分别设 `off` / `high` / `max`，各自会话日志里的 `request/header.config.reasoningEffort` 与请求值一致，全部 PASS。

---

## 3. 默认分级映射

| 等级 | 判定参考 | 强度 |
|---|---|---|
| `simple` | 单文件、机械改动、问答、通知、汇报 | `off` |
| `moderate` | 多文件、需要调研但路径明确、常规实现 | `high` |
| `complex` | 架构/跨模块、高风险、长时间、需要权衡 | `max` |

规则：

- **`max` 只用于 `complex`**，且 leader 派发时要在消息里写明理由。
- 能用 `high` 解决的不上 `max`；`max` 是例外，不是默认。
- 同一会话可**按任务切换**强度：每次派发前设定，而不是建会话时一次定死。
- 交接单记录「建议强度」；新会话按下一项任务重新设定。
- 报告与面板统计 `max` 使用次数，**只展示、不阻断**（延续"不设配额"的原则）。

映射可在团队章程 / 插件配置里改，不写死。

---

## 4. 在团队协议中的位置

- **leader 派发**：给每个任务标 `complexity`，投递前调用 `selectModel`。
- **worker 交接**：交接单带「建议强度」；leader 批准后，新会话的首个任务按同一规则设定。
- **leader 交接**：不影响成员；新 leader 按自己的任务重新设定。
- **子智能体**：由父会话在创建子任务时决定（子智能体工具本身也有强度参数，待接线验证）。

---

## 5. 未做 / 待定

- 未做自动分级（由 leader 判断，符合"可配置优先"）。
- 未验证子智能体的强度继承规则。
- 未做按会话的强度切换历史展示（面板只显示每条消息的 `complexity → effort`）。
