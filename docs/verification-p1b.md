# P1b 验证记录：组播与简单前端

> 日期：2026-11-20（Asia/Shanghai）
> 宿主：DeepSeek Harness 0.2.2-rc.5，desktop profile
> 结论：**PASS**（组播投递矩阵 4/4 正确；前端已注册到设置页）
> 证据：`.p1b/report.json`、`.p1b/state.json`、`.p1b/bodies/`、各会话的 `session.v4.jsonl.zstd`
> 预览插件：`plugin/`（当前已安装，供你在界面里查看）

---

## 1. 验证目标

四种投递方式，且只有收件人收到：

| 消息 | 发送方 | 收件人表达式 | 期望收到的会话 |
|---|---|---|---|
| `m-0001` ALL-CALL | leader | `all` | `at-w-01`、`at-w-02`、`at-w-03` |
| `m-0002` SUBSET-CALL | leader | `[at-w-01, at-w-02]` | `at-w-01`、`at-w-02` |
| `m-0003` TO-LEADER | `at-w-01` | `[at-lead-1]` | `at-lead-1` |
| `m-0004` PEER-CALL | `at-w-02` | `[at-w-01, at-w-03]` | `at-w-01`、`at-w-03` |

---

## 2. 结果（从会话日志逐条核对）

| 会话 | 期望 | 实际 | 结果 |
|---|---|---|---|
| `at-lead-1` | TO-LEADER | TO-LEADER | PASS |
| `at-w-01` | ALL-CALL / SUBSET-CALL / PEER-CALL | 三条全中 | PASS |
| `at-w-02` | ALL-CALL / SUBSET-CALL | 两条全中，**无 PEER-CALL** | PASS |
| `at-w-03` | ALL-CALL / PEER-CALL | 两条全中，**无 SUBSET-CALL / TO-LEADER** | PASS |

旁证：各会话实际跑出的轮数正好等于收到的消息数——

| 会话 | 轮数 | 对应消息数 |
|---|---|---|
| `at-lead-1` | 1 | 1 |
| `at-w-01` | 3 | 3 |
| `at-w-02` | 2 | 2 |
| `at-w-03` | 2 | 2 |

（轮数来自 `~/.dsh/storages/session_projcache/sessions/<id>.json` 的 `lastTurn`。）

---

## 3. 实现方式

### Host（`plugin/index.js`）

- 路由前缀 `/agent-team`，仅接受 loopback：
  - `GET /agent-team/state`：会话、消息、投递状态
  - `GET /agent-team/body?id=`：正文
  - `GET /agent-team/report`：验证报告
  - `POST /agent-team/demo`：跑一次演示（幂等）
- 组播：`to` 支持 `all` / `leader` / 显式 id 数组；服务端解析后逐个 `sessionController.prompt({ mode: 'queue' })`。
- 每条消息落盘：`.p1b/state.json` + `.p1b/bodies/m-XXXX.md`。
- 演示只跑一次（`.p1b/demo.done` 标记），避免每次启动重复建会话。

### Client（`plugin/client.js`）

- 注册 `settings.section`，id `agent-team-preview`，order 60，label `Agent Team`。
- 每 2 秒拉一次 `/agent-team/state`；表格展示时间、消息 id、发送方、收件人、类型、摘要、逐收件人投递状态。
- 点击行加载正文；底部按会话显示 PASS/FAIL 校验。

---

## 4. 发现并修复的问题

**收据匹配 bug**：首轮演示里投递全部成功（会话确实跑起来了），但报告显示 FAIL。原因：信封里的标记是裸词 `ALL-CALL`，而收据扫描找的是 `[[ALL-CALL]]`。

- 修复：`plugin/index.js` 的收据扫描改为 `userText.includes(marker)`。
- 影响：**已在代码里修好**；当前运行中的 Host 仍是旧模块（替换已安装包需要重启才加载新 JS），所以本次报告由独立脚本从会话日志重算，见 `scripts/verify-p1b.mjs`。
- 下次重启 DSH 后，插件自己的报告逻辑也会正确。

---

## 5. 前端状态

- 客户端注册已确认：`Slots.listSubTree` 显示 `settings.section` 下的 `agent-team-preview` 为 `active: true`，order 60。
- **视觉未验证**：桌面窗口不走可调试的 CDP；HTTP 入口需要 `dsh web` 的鉴权 token，未去猜或绕过。请你在界面里打开确认：
  1. 设置（左下角齿轮）→ 左侧导航 **Agent Team**；
  2. 若看不到，先 `Ctrl+R` 刷新一次（客户端模块需要页面重载）；
  3. 页面应显示 4 条消息、每位收件人的投递状态，以及底部四个 PASS。
- 消息表格点击任意一行可看正文（`.p1b/bodies/`）。

---

## 6. 当前安装状态

| 项 | 状态 |
|---|---|
| 预览插件 `dsh-agent-team-preview` | **已安装并启用**（供你查看） |
| 演示会话 | `at-lead-1`、`at-w-01..03`，共 4 个，留在工作区侧边栏 |
| 数据目录 | `.p1b/`（state、report、bodies、demo.done） |
| 卸载 | `plugin_manager remove_bundle target=dsh-agent-team-preview` |

> 卸载后会话与 `.p1b` 数据保留；`at-*` 四个会话可按需归档。

---

## 7. 尚未验证

- 前端视觉与交互（需要你在桌面窗口确认）。
- 未读游标：本次验证的是“投递到会话”，未实现/验证每个会话的未读游标与摘要注入。
- 正文按 ref 取：面板已按需加载；会话侧目前直接把正文路径写进信封，没有做“摘要 vs 正文”分离。
- 与真实 leader/worker 工具（而不是演示脚本）的接线。
