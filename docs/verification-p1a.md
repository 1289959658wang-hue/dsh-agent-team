# P1a 验证记录：创建平级根会话

> 日期：2026-11-20（Asia/Shanghai）
> 宿主：DeepSeek Harness 0.2.2-rc.5，desktop profile
> 结论：**PASS**（`report.ok = true`）
> 证据：`.p1a/report.json`、`.p1a/spike.log`（保留在仓库根）
> 验证方式：临时 bundle `spike-p1a/`，装进 profile 后自动跑一次，跑完立即卸载

---

## 1. 验收项与结果

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 创建平级根会话 | ✅ | `sessionId: p1a-spike-mwox7idq`，`agentPreset: standard` |
| 2 | 归属工作区 | ✅ | 复用已有工作区 `043a1137-…`（`reused: true`），`workspaceId` 传入 `create()` |
| 3 | 侧边栏可见（数据层） | ✅ | `workspace.sessionIds` 包含该 id |
| 4 | 能被 prompt 唤醒 | ✅ | `prompt.accepted: true`，`wait.reason: idle` |
| 5 | 会话真的执行了任务 | ✅ | 助手回复 `P1A-OK`（精确匹配） |
| 6 | 归档 | ✅ | `archiveSession(id, { stopActivity: true })` 返回成功 |
| 7 | 归档后仍可查 | ✅ | `events()` 返回 14 条记录，`hasMore: true` |
| 8 | 授权记录 | ✅（记录在案） | `authorizedBy: user approved "开始p1a" in chat 2026-11-20` |

**未验证项**：侧边栏的**视觉**呈现（本次只验证了侧边栏的数据来源 `workspace.sessionIds`，没有截图确认）。

---

## 2. 用到的 API（实测）

```js
// 工作区：复用或创建
const ws = await ctx.workspaceRegistry.resolveByPath('<repo>')
  ?? await ctx.workspaceRegistry.create('<repo>', 'AgentWorkTeam')

// 建会话（根会话，不是子智能体）
const created = await ctx.sessionController.create({
  sessionId: 'p1a-spike-mwox7idq',
  workspaceId: ws.id,
  agentPreset: 'standard',
})

// 激活 agent：create 本身不发布活体 agent
const { agent } = await ctx.sessionController.resolveAgent(created.sessionId)

// 投递一条提示
await ctx.sessionController.prompt({
  requestId: 'p1a-…',
  sessionId: created.sessionId,
  mode: 'queue',
  content: [{ type: 'text', text: '…' }],
  clientTimeZone: 'Asia/Shanghai',
}, signal)

// 等它跑完
const waited = await ctx.sessionController.wait({ sessionId, timeoutMs: 120000, maxMessages: 40 }, signal)

// 归档（带 stopActivity）
await ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true })

// 归档后读日志
const page = await ctx.sessionController.events({
  address: { kind: 'session', sessionId },
  maxMessages: 5,
}, signal)
```

---

## 3. 观察与坑

1. **`create()` 只建会话，不发布 agent。** 必须再 `resolveAgent()` 才会得到可用的 agent；否则 `prompt` 会走到 resume 路径，行为不确定。
2. **归属工作区必须传 `workspaceId`。** 只传 `cwd` 不会附加工作区（与 auto-handoff 记录的缺陷 A 一致）。本次 `resolveByPath` 复用了现有工作区，没有新建。
3. **归档不会把会话从 `workspace.sessionIds` 移除。** 归档后 `contains` 仍为 `true`。说明"归档"是独立集合，UI 侧边栏应靠归档过滤；P1a 的"归档后仍可查"满足，但"归档后侧边栏隐藏"需要在 P1b/P1c 或面板阶段确认。
4. **模型调用不需要审批。** 新会话沿用 profile 默认模型（deepseek-account/deepseek-flash），`prompt` 直接受理。
5. **一次回复就绪很快（约 1.4s）。** `wait()` 返回 `records: 1`，只含该轮的 assistant 事件；更早的会话事件要用 `events()` 读。
6. **插件在 `apply()` 里自动跑了一次。** 正式实现必须由工具或显式命令触发，不能一装就跑；本次是验证脚本的有意行为。

---

## 4. 清理记录

| 动作 | 结果 |
|---|---|
| 卸载临时 bundle | `plugin_manager remove_bundle dsh-p1a-spike` → `application: applied` |
| 恢复校验 | profile 的 `package.json` 与 `cordis.patch.yml` 与安装前**逐字节相同**（diff SAME） |
| 残留检查 | 两个文件中没有 `p1a` 字样 |
| 临时备份 | 已删除（源已恢复，备份过期） |
| 测试会话 | `p1a-spike-mwox7idq` 已归档，日志保留在会话存储中，作为"归档后仍可查"的证据 |
| 工作区 | 复用原有工作区，未新建 |

---

## 5. 对后续步骤的影响

- P1b（组播）可以直接用 `sessionController.prompt` 的三种投递模式；`create` + `resolveAgent` 的组合是标准动作。
- "侧边栏可见"应作为**数据判据 + 视觉判据**两条：数据看 `workspace.sessionIds`，视觉看归档过滤是否生效。
- P1c（交接）里创建新会话可以照抄本记录的顺序：`create → resolveAgent → prompt`。
- 正式插件需要把测试脚本里的"安装即跑"改成"工具/命令触发"，避免副作用。

---

## 6. 复现方式

```bash
# 1. 把 spike-p1a/ 装进 profile
#    plugin_manager install_bundle target=<abs path to spike-p1a>
# 2. 等 ~3 秒，读报告
cat .p1a/report.json
# 3. 卸载
#    plugin_manager remove_bundle target=dsh-p1a-spike
```

> 注意：重装会再建一个会话。复现前先确认你要保留上一次的证据。
