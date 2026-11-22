# 推理强度实测记录

> 日期：2026-11-20（Asia/Shanghai）
> 宿主：DeepSeek Harness 0.2.2-rc.5
> 结论：**PASS**（off / high / max 三档都写进了请求头）
> 证据：`.p1b/effort-report.json`
> 验证包：`spike-effort/`（已卸载；可复现）

---

## 1. 背景问题

P1b 的四个测试会话，请求头里的强度都是 `max`：

```json
"config": { "provider": "deepseek-account", "model": "deepseek-flash", "reasoningEffort": "max" }
```

原因是建会话后没有显式选择强度，会话用了模型目录默认档。

---

## 2. 验证方法

建三个会话，分别设 `off` / `high` / `max`，各发一条提示，然后读各自会话日志里的 `request/header`：

```js
await ctx.sessionController.selectModel({
  sessionId, provider, model, reasoningEffort: 'off' | 'high' | 'max',
})
await ctx.sessionController.prompt({ ... })
```

---

## 3. 结果

| 会话 | 请求 | 选择结果 | 日志中看到的 | 判定 |
|---|---|---|---|---|
| `eff-off` | off | off | off | PASS |
| `eff-high` | high | high | high | PASS |
| `eff-max` | max | max | max | PASS |

`effort-report.json` 的 `ok` 为 `true`。三个会话在验证后已归档。

---

## 4. 结论

- `selectModel` 可以在**投递前**改变会话的推理强度，无需重建会话。
- 四档 `off / low / high / max` 由适配器支持（`dsh-llm-deepseek` 的配置 schema）。
- 因此"按任务动态设强度"可以落地为：leader 给任务分级 → 投递前 `selectModel` → 再 `prompt`。

---

## 5. 清理

- `dsh-effort-spike` 已卸载；profile 的 `package.json` / `cordis.patch.yml` 与安装前一致。
- 三个 `eff-*` 会话已归档，日志保留。
- 证据文件：`.p1b/effort-report.json`。

---

## 6. 跟进到预览插件

`plugin/`（Agent Team 预览）已加入同样的机制：

- 派发消息带 `complexity`（simple / moderate / complex）；
- 投递前调用 `selectModel` 设定强度；
- 消息与投递记录里保存 `effort`，面板新增「强度」列；
- 报告统计 `max` 使用次数（只展示，不阻断）；
- 演示默认**不触发 max**（simple / moderate / simple / moderate），避免为了演示而用最贵的档。

> 当前运行中的 Host 仍是旧模块（替换已安装包需要重启才加载新 JS），所以**现在打开面板还看不到「强度」列**；下次 DSH 重启后生效。强度机制本身已由上面的独立验证确认。
