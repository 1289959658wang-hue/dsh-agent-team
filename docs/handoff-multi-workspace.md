# 交接：多工作区团队（每工作区一个团队）

> 写给**接手的新会话**。你没有任何上文，这份文档自带全部背景。看完照 §7 的顺序动手即可。
> 写作时间：2026-11-21 15:06 · 交接时版本：`v1.8.0`（验收 115/115，桌面端实测可用）

---

## 1. 一句话任务

把 Agent Team 从「**一个 profile 一个团队**」改成「**每个工作区一个团队**」（用户叫它"模型 ①"），并按 §7 的四步推进，每步单独验收、单独提交、可单独回退。

**不是**重写插件，是给现有的 Host 加一层"按工作区分片"。

---

## 2. 回退点（先看这个，再动手）

| 项 | 值 |
|---|---|
| 可用的最后版本 | tag **`v1.8.0`** = **`pre-multi-workspace`** = commit `5d5d501` |
| `main` 分支 | 停在 `5d5d501`，**只要不合并就永远可用** |
| 工作分支 | `feat/multi-workspace`（已从 main 切出） |

```bash
git checkout -- .                                   # ① 丢掉未提交改动
git reset --hard pre-multi-workspace                # ② 回到重构前（同一分支）
git checkout main                                   # ③ 彻底放弃（main 一直在 5d5d501）
git branch -D feat/multi-workspace
```

**回退或改完后必须重启桌面端**：插件在 profile 里是 `link:<repo>/agent-team`，仓库切到哪个分支，重启后加载的就是哪个版本，**没有热更**。

---

## 3. 现状：为什么需要这个改动

Host 是**单例闭包**，只认一个写死的工作区：

```js
// agent-team/index.js:22
const DEFAULT_ROOT = '<repo>'
// :104
const root = path.resolve(config.workspaceRoot ?? DEFAULT_ROOT)
const home = path.join(root, '.team')          // store 只有一个
let state = load()                              // 内存态也只有一个
// :854
async function workspace() {
  return (await ctx.workspaceRegistry.resolveByPath(root)) ?? (await ctx.workspaceRegistry.create(root, 'AgentWorkTeam'))
}
```

后果（用户已确认是缺陷）：

- 在项目 B 里新建 `Agent Team · Leader` 会话，读写的仍是**项目 A** 的 `.team/`；
- `team_spawn_worker` 建出的 worker 一定落在 A；
- 面板只有一个团队，没有切换概念。

---

## 4. 目标设计（模型 ①）

### 4.1 数据

- store 路径 = **会话所属工作区**的 `<workspaceRoot>/.team/`；
- 现有 `.team/` **零迁移**：它本来就在自己的工作区里；
- 别的工作区首次用到时，自动建空 store（`generation: 1`、计数器从 1 开始）。

### 4.2 解析"这是哪个团队"

| 入口 | 解析规则 |
|---|---|
| 工具调用（`team_post` / `team_roster` / …） | 从 `exec.agent.id`（调用方会话）反查它属于哪个工作区 —— **工具签名不变**，每个工具都已经有 `from` |
| 面板 HTTP `/agent-team/*` | 新增 `?workspace=<绝对路径>`；不带则回退到配置里的默认工作区（**保证单工作区行为完全不变**） |
| 交付消息（`deliver` / `resolveAgent`） | 不用改：会话 id 是全局的，与工作区无关 |

### 4.3 建会话的地方必须用"该团队自己的"工作区

`spawnWorker` / `approveHandoff`（worker 与 leader 继任）/ `requestSuccessor` 里的
`ctx.sessionController.create({ workspaceId })` 现在都传死 `root`，要改成传该团队的工作区 id。

### 4.4 跨工作区守卫

A 团队的会话 `team_post` 给 B 团队的会话 → **直接拒绝**（`收件人不在本团队`）。
否则岗位表、广播、归档口径全乱。（这条要单独问用户是否要"允许跨团队点对点"——见 §9。）

### 4.5 面板

```
工作区: [AgentWorkTeam ▾]  ● 2 待办       ← 下拉 = workspaceRegistry.list()
leader 卡 / 团队卡 / 待批 / 消息           ← 只显示当前工作区那份
```

- 切换 = 请求带 `?workspace=`，重新拉 `/state`；
- 徽章口径建议：**只算当前工作区**，下拉项上带小圆点（`项目B ●3`）；
- 切换不影响任何正在跑的会话（只是换个视图）。

---

## 5. 代码地图

| 文件 | 行数 | 作用 |
|---|---|---|
| `agent-team/index.js` | 1659 | **Host**：state、持久化、投递、上闩、交接、路由、对账。**这次改动的主体** |
| `agent-team/tools.js` | 483 | preset 作用域里的团队工具。**几乎不用改**（都带 `from`） |
| `agent-team/client.js` | 956 | 侧边栏按钮 + 右侧抽屉。**小改**（下拉 + 参数） |
| `agent-team/cordis.patch.yml` | — | host 行 config（`workspaceRoot` 等）+ 两个 preset 行（`persona` 覆盖 / `delegation` 覆盖 / 追加 `tool-agent-team-*`） |
| `scripts/gen-preset-tools.mjs` | 271 | preset 工具清单生成器（1.8.0 起是**策展白名单** `CURATED`，详见 §8） |
| `spike-p2/index.js` | 1125 | 验收 harness，**115 条断言**，判据是 `.p2/report.json` 的 `ok` |
| `docs/GUIDE.md` | — | 用户/接手方手册（安装、使用、工具表、接口、排障） |
| `docs/verification-p2.md` | — | 每条实测记录（§6.1–§6.27），**改行为前先读相邻章节** |

Host 里可复用的关键函数（都是闭包内）：

```
load save resetTeam                # 持久化 / 清场
roster directory messages activity # 读
resolveRecipients deliver post postSystem teamMessage  # 投递
latch unlatch notePreStep          # 上闩（agent/pre-step 守卫）
spawnWorker requestSpawn approveSpawn
requestHandoff requestHandoffInfo approveHandoff rejectHandoff
reconcileArchived leaderStatus claimLeader promoteLeader setArchived
contextReport readContextUsage pruneMessages maybePrune
```

路由一览：`/agent-team/{state,events,roster,messages,activity,authority,body,approve,reject,more-info,admin/{reset,promote-leader,prune,archive-sessions,unarchive-sessions}}`

---

## 6. 用户定下的硬约束（必须遵守）

1. **每次改动前先确认 git**，定好回退点再动手；一个可验证的改动 = 一个提交；
2. 测试产物**不入库**（`probe-*.md`、`.team/`、`.p2-sandbox/`、`dist/`、`docs/qa/` 都已在 `.gitignore`）；
3. **不要**做桌面推送（该功能已放弃）；
4. 项目开源（MIT），随便用随便改；
5. 报告要区分「已实测」与「推断」；数据要带出处（哪个 commit / 哪条断言 / 哪个文件）。

---

## 7. 分步计划（每步都要单独验收 + 提交）

### 第 1 步：把 store 拆成工厂（**行为零变化**）

- 把现在这堆闭包函数收进 `createTeamStore(root)`，返回同一组方法；
- 外面加 `teamFor(root)` 缓存（`Map<root, store>`）；
- 只有配置里的默认 root 会被使用（还不多工作区）；
- **判据**：`115/115` 全过、桌面端照常用、`git diff` 里没有行为改动（只有结构搬运）。

### 第 2 步：解析团队 + 跨区守卫

- 工具路径：从 `exec.agent.id` 找会话所属工作区（`workspaceRegistry.list()` 里有 `sessionIds`）；
- HTTP 路径：支持 `?workspace=`，缺省回落默认；
- `create({ workspaceId })` 改用团队所属工作区；
- 跨工作区 `team_post` 拒绝；
- **判据**：新增 3 条断言 —— ① 两个工作区的 store 互不可见；② 带/不带 `?workspace=` 都正确；③ 不传 `workspaceRoot` 的旧配置行为不变（`115 + 3 = 118/118`）。

### 第 3 步：面板

- 工作区下拉（`workspaceRegistry.list()`）+ 请求带参 + 徽章口径；
- **判据**：桌面端手动切两个工作区，状态不串台、徽章数对。

### 第 4 步：文档 + 版本

- `GUIDE.md` 加一节"多工作区"、`DETAIL.md` 更新结构、`CHANGELOG` 1.9.0；
- `package.json` 升 1.9.0、`npm pack --pack-destination ../dist`、commit + `git tag -a v1.9.0`。

---

## 8. 已知的坑（都是这轮实测踩出来的，别再踩）

| 坑 | 事实 |
|---|---|
| preset 的 `plugins` 是**全量清单**，无继承 | 所以要维护清单；1.8.0 起是 `CURATED` 白名单 + 从 shipped `standard` 取正文；白名单 id 在新版 DSH 里缺失 → `--check` 报错 |
| `agent/pre-step` 是 waterfall | **必须 `return next()`**，裸 return 会吞掉整条链（`docs/pitfall-pre-step-waterfall.md`） |
| 工具输出 schema 是**严格的** | 声明 `type:'string'` 就不能返回 `null`（1.7.0 就因此炸过 `leader` 字段） |
| 消息投递语义 | `notice`/`roster-update` → `inject`（**不唤醒**）；`task`/`question`/`report` → `queue`（唤醒）；`priority:'urgent'` → `steer`。要对方回复就别用 notice |
| 团队 preset **不含** `wait_agent`/`list_agents`/`send_message` | 那是子智能体通道，用了会"等同事回复"并把整轮堵死（1.7.0 已移除） |
| 一个 turn 一次只领 1 条 `next-turn` 消息 | 一条消息 = 一轮，FIFO |
| `git add -A` 会误收产物 | 用品 `git add -u` + 显式列新文件（`docs/git-workflow.md` §7） |
| 归档安全阀 | `setArchived` 只跳过 `agent.status === 'running'` 的会话 |
| 模型会拿自己的工具表当全集 | leader 与 worker 的工具**不对称**，别让它据此判断"某工具不存在"（`team_directory` 现在两边都有） |

---

## 9. 需要问用户的问题

1. 跨工作区 `team_post`：**拒绝**（推荐，口径干净）还是允许点对点？
2. 侧边栏徽章：只算当前工作区（推荐）还是汇总所有团队？
3. 是否需要"全局视图"（所有团队的待办合成一张表）？还是切换器就够？

**答（2026-11-21 15:23，用户已定，按推荐项）**：

1. **直接拒绝** —— 报「收件人不在本团队」；不做"允许跨团队点对点"；
2. **只算当前工作区** —— 下拉项上带小圆点标别的团队的待办数（`项目B ●3`）；
3. **先不做全局视图** —— 第 3 步只做切换器，范围最小、验收最容易。

---

## 10. 环境与验收

- DSH：**0.2.2-rc.5**，安装目录 `<DSH_HOME>`，profile `desktop`（已装：`link:` + junction + bundles）；
- 桌面端 GUI 端口每次重启会变，以本会话开头给的 URL 为准；
- 验收（判据是 `ok: true`，不是"看起来能开"）：

```bash
cd "<repo>"
export ELECTRON_RUN_AS_NODE=1
E="<dsh-exe>"
B="<dsh-bin>"
timeout -s KILL 220 env DSH_P2_AUTORUN=1 "$E" "$B" --profile p2-test \
  --patch "<repo>/agent-team/cordis.patch.yml" \
  --patch "<repo>/spike-p2/cordis.patch.yml" \
  --patch "<repo>/spike-p2/sandbox.patch.yml" \
  --port 0 --no-open
node -e "const r=require('./.p2/report.json');console.log(r.ok, Object.keys(r.checks).length, Object.keys(r.checks).filter(k=>!r.checks[k]))"

node scripts/gen-preset-tools.mjs --check     # exit 0
sh .githooks/pre-commit                        # 已接进 pre-commit
node scripts/desktop-bundle.mjs                # 看 installed: YES
```

- harness 注意：`sandbox.patch.yml` **必须是最后一个 `--patch`**；`check()` 不接受 Promise（异步用 `checkAsync`）；每次跑前 `rm -rf "<sandbox>/.team" .p2/report.json`。

---

## 11. 交接时的当前状态（2026-11-21 15:06）

- 团队 store **已清场**（`generation: 3`、岗位表空、计数器 10/79 保留），备份在 `.diag/tmp/team-final-backup-20261121-145103/`；
- 旧测试会话已由用户**手动归档**（不是脚本）；
- 工作区干净，`feat/multi-workspace` 与 `main` 都在 `5d5d501`；
- 桌面端当前加载的就是 1.8.0（未重启则仍是 1.7.x，重启即最新）。

**进展（接手会话记录）**

- 2026-11-21 15:18 **第 1 步完成**：commit `3674dc3`，tag `mw-step1-store`，`115/115` 全绿
  （首次 112/115：handler 调了不存在的 `api.panelState`，已改成 `store.panelState()`）；
  交接时「`feat/multi-workspace` 与 `main` 都在 `5d5d501`」已不成立 —— `main` 仍在 `5d5d501`，
  分支前进到 `3674dc3`；
- §9 的三个口径已由用户定下（见 §9 末尾）；
- 2026-11-21 15:42 **第 2 步完成**：`118/118` 全绿（新增 `twoWorkspacesKeepSeparateTeams` /
  `panelRouteSwitchesByWorkspace` / `legacyConfigFallsBackToDefaultRoot`），桌面端已由用户重启、
  `/agent-team/state` 实跑 200（第 1 步的"桌面端照常用"因此闭环）；
- 2026-11-21 16:05 **第 3 步完成**：面板工作区下拉 + 徽章口径（只算当前工作区、别的团队在选项上带 `●N`）；
  `121/121` 全绿（新增 `workspacesRouteListsRegistry` / `badgeCountMatchesPendingActions` /
  `workspacePeekDoesNotCreateDirs`），外加 `spike-p2/panel-probe.mjs` 用 CDP 真跑面板 13/13
  （截图与判据见 `docs/verification-frontend.md` §8）；
- 2026-11-21 16:13 **第 3 步修补**：用户桌面端实测"点下拉没反应"——原生 `<select>` 的弹层在
  Electron 里不开。换成 DOM 下拉，探针改成**真鼠标**点击（15/15），`mw-step3-panel` 已移到修补提交；
  第二轮补 `WebkitAppRegion:'no-drag'` + 列表 fixed 锚点 + 诊断开关（`?diag=1`）后**用户确认可用**；
  根因与教训写在 `docs/verification-frontend.md` §8.4；
- 2026-11-21 16:36 **第 4 步完成 / 1.9.0 发布**：`GUIDE.md` 加 §6.16 多工作区并更新 §8/§9/§10/§11/§12/§14；
  `DETAIL.md` 加「多工作区（1.9.0）」；`CHANGELOG` 1.9.0；`package.json` 升 1.9.0；
  `npm pack` → `dist/dsh-agent-team-1.9.0.tgz`（10 个文件 / 62,328 字节）；
  新增 `scripts/snapshot.mjs`（里程碑整目录快照：只拷跟踪文件 + sha256 回读 + 生成清单 + 报过期副本）；
  121/121 全绿，打 `v1.9.0`。
- 改造已完成。后续若回到这条线：`git log --oneline v1.8.0..v1.9.0` 就是全部改动。
