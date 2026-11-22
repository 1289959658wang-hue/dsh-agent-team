# 版本控制与开发流程

> 建立于 2026-11-21。此前本仓库没有 `.git`，版本靠 `.diag/` 目录拷贝（见 `handover.md` §3）。
> 本文只讲**怎么在这个仓库里干活**；里程碑状态看 `handover.md`，阶段证据看各 `verification-*.md`。

## 1. 一次性设置（克隆后必做）

```bash
git config core.hooksPath .githooks   # 启用 pre-commit 守卫
```

仓库已设 `core.autocrlf false`、`core.quotepath false`（Windows 下不折腾换行、中文路径正常显示）。

**作者身份是占位值**，第一次提交前改成你自己的：

```bash
git config user.name  "你的名字"
git config user.email "你的邮箱"
```

## 2. pre-commit 守卫

`.githooks/pre-commit` 每次提交前跑两道检查，任一不过就拒绝提交：

1. `node scripts/guard-daily-profile.mjs` —— 日常 profile 有没有被测试插件污染、waterfall 监听器有没有裸 `return`；
2. 对 `plugin/`、`spike-*` 逐目录 `--scan` —— 静态查同一个坑。

这就是 2026-11-20 那次事故（`INC-2026-11-20-PRESTEP`）的防线：**错误进不了仓库**，而不是靠人记得跑体检。

绕过只能 `git commit --no-verify`，并且要在 commit message 里写清为什么。

## 3. 提交与 tag 约定

- **一步一提交**：一次「确定无误」的可验收动作 = 一个 commit。
- **阶段打 tag**：`p1c2-pass`（已有）、`p2-step1-presets`、`p2-step2-tools`、`p2-complete`……出问题 `git checkout <tag>` 就回到那一刻。
- **`main` 永远可运行**：拿不准的改动开分支（`p2`、`feat/frontend-drawer`），验证通过再合。
- commit message 首行写**做了什么**，正文写**判据**（哪条命令、退出码多少），见基线提交 `e652a68` 的写法。

## 4. 不进仓库的东西

`.gitignore` 已排除：`node_modules/`、`*.log`、`.diag/dsh-src-*/`（可由 `scripts/asar-extract.py` 从 app.asar 重新生成）、`.diag/tmp/`、运行锁。

**永远不要提交**：profile 的 `cordis.yml`/`package.json`（每台机器不同）、任何 `sk-*` / token / cookie。

## 5. 开源前待办（尚未决定，别当成已完成）

- [ ] `LICENSE` —— 许可证选择由项目所有者定，未定前不要对外声明授权。
- [ ] `README.md` —— 仓库根还没有；现在只有 `docs/README.md`（是文档索引，不是项目介绍）。
- [ ] `CONTRIBUTING.md` —— 把本文 §1–§3 提炼成贡献者流程。
- [x] **清理机器痕迹**：公开仓库不含 `.diag/`、`.p1a/`–`.p1c2/`、`.p2/` 与 `spike-*`；文档里的绝对路径已替换成 `<repo>` / `<DSH_HOME>` 占位。
- [ ] 确认无第三方代码版权问题：`.diag/dsh-src-*` 已排除；`scripts/asar-extract.py` 为自写。

## 6. 与旧备份机制的关系

`.diag/backup-*`、`.diag/fixed-*`、`.diag/verified-*` 是 git 之前的历史现场，**保留**（`docs/pitfall-pre-step-waterfall.md` §3、§8 有引用，删了引用就断）。

今后：**git 管「改了什么」**，`.diag/` 只在里程碑做一次「整个目录拷出去」——那是防误删/盘坏，git 做不到。

## 7. 提交纪律：不要 `git add -A`

2026-11-21 踩过一次：`git add -A` 把 worker 实测写的 `probe-a.md` / `probe-b.md` 一起收进了 1.6.0 的提交，
而用户早就定了「测试产物不入库」。现在的做法：

- 用 `git add -u`（只收已跟踪文件的改动）+ **显式列出**新文件；
- 已知产物模式写进 `.gitignore`：`README.outline.md`、`*.draft.md`、`docs/qa/`、`probe-*.md`；
- 提交前看 `git status --short` 的每一行——出现没预期的 `??`，先判断它该不该入库，再决定加不加。

## 8. 多工作区改造（2026-11-21 起）：提交与回退点阶梯

交接书是 `docs/handoff-multi-workspace.md`（自带全部背景）；这里只定**怎么走**，不重复设计。

**基线（永远可回）**：`v1.8.0` = `pre-multi-workspace` = `5d5d501`，`main` 停在这里不再动。
工作分支 `feat/multi-workspace`。**一步一提交 + 一步一个 tag**，tag 就是那一步的回退点。

| 步 | 内容 | 判据（退出码 / 字段即结论） | tag |
|---|---|---|---|
| 1 | store 拆成 `createTeamStore` 工厂 | `.p2/report.json` → `ok: true`，115/115 | `mw-step1-store` ✅ 2026-11-21 |
| 2 | 解析团队（`exec.agent.id` → 工作区）+ 跨区守卫 | `.p2/report.json` → `ok: true`，118/118（新增 3 条断言） | `mw-step2-resolve` ✅ 2026-11-21 |
| 3 | 面板工作区下拉 + 徽章口径 | `.p2/report.json` → `ok: true`，121/121；`spike-p2/panel-probe.mjs` → 15/15（真鼠标）；**桌面端实测可用（用户 16:2x 确认）** | `mw-step3-panel` ✅ 2026-11-21 |
| 4 | 文档 + 1.9.0 + `npm pack` | `.p2/report.json` → `ok: true`，121/121；`npm pack` 出 10 个文件；`.diag/` 整目录快照（`scripts/snapshot.mjs`）exit 0 | `v1.9.0` ✅ 2026-11-21 |

**每步的四道闸（任一不过就不提交）**：

1. `.p2/report.json` 的 `ok` 为 `true`（全量断言；不是"看起来能开"）；
2. `node scripts/gen-preset-tools.mjs --check` → exit 0；
3. `sh .githooks/pre-commit` → exit 0（提交时自动跑；`--no-verify` 要在 commit message 里写原因）；
4. `git status --short` 逐行看过：没有 `probe-*.md` / `.p2-sandbox/` / `.team/` / `dist/` 混进来（**不用 `git add -A`**，见 §7）。
   `.p2/report.json` 是例外——它是这一步的验收证据，1.5.0 起每个版本提交都带它。

**提交信息**：首行「多工作区 N/4：做了什么」，正文写**判据**（命令 + 结果）与被否掉的第一次尝试
（写进去的失败比"一次就过"更能证明判据真的会红）。

**回退**：

```bash
git reset --hard v1.9.0             # 发布版（= 第 4 步之后）
git reset --hard mw-step3-panel     # 回到第 3 步之后（丢掉第 4 步）
git reset --hard mw-step2-resolve   # 再往回到第 2 步之后
git reset --hard mw-step1-store     # 再往回到第 1 步之后
git checkout -- .                   # 只丢未提交改动
git checkout main                   # 整条线放弃（main 永远在 5d5d501）
```

**回退/改完必须重启桌面端**：插件在 desktop profile 里是 `link:` 到这个目录，仓库切到哪个分支、
重启后加载的就是哪个版本，**没有热更**（`scripts/desktop-bundle.mjs status` 看 `installed: YES`）。

**备份的边界**（承 §6）：git tag 管"改了什么"，防误删误改；整目录拷贝只在里程碑做一次，那次是防盘坏。
工具是 `node scripts/snapshot.mjs <label>`：只拷 git 跟踪的文件、逐个回读 sha256 校验、生成 `MANIFEST.md`、
报出更旧的快照，退出码即结论（v1.9.0 那次：114 个文件，数字以 `.diag/snapshot-*/MANIFEST.md` 为准 —— 不在这里硬编码）。
**每一步都要求工作区干净**（`git status --porcelain` 为空）——干净 + tag + 全绿，这三样凑齐才叫"这一步确定无误"。
