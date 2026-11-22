<a id="zh"></a>

# 参与开发

> 中文 ｜ [English](#en)
>
> 先读 [`README.md`](README.md) 了解这是什么，再读 [`docs/handover.md`](docs/handover.md) 了解当前进度。

## 环境

- DSH **0.2.2-rc.5**（桌面端）。源码在 `C:\Software\DSH\resources\app.asar` 里，普通 Node 读不进去——
  用 `python scripts/asar-extract.py` 抽取（用法见脚本头部注释）。
- **需要 pnpm**：`dsh plugin` 内部会 spawn 它，打包也走它。`npm i -g pnpm` 装一个。
- **没有自动化测试框架**：所有验收都是"脚本 + 退出码 / 报告 JSON"，见各 `docs/verification-*.md`。

## 提交前必须做的三件事

```bash
node scripts/guard-daily-profile.mjs        # exit 0（测试插件没污染日常 profile、没有裸 return）
node scripts/repro-pre-step-waterfall.mjs   # 输出与文档一致
node scripts/desktop-bundle.mjs status      # 若改过 profile 装卸
```

`.githooks/pre-commit` 会自动跑前两项，**ERROR 直接拒绝提交**。新克隆先启用：

```bash
git config core.hooksPath .githooks
```

## 三条硬规则（都是踩出来的）

1. **waterfall 事件必须 `return next()`**：`agent/pre-step`、`agent/request`、`agent/request-error`、
   `system-prompt/assemble`。裸 `return` 不是"放行"，是"把 undefined 当决策"，会让所有会话每一轮崩溃。
   详见 [`docs/pitfall-pre-step-waterfall.md`](docs/pitfall-pre-step-waterfall.md)。
2. **`*-spike` / `*-test` 永不进日常 profile 的 `bundles`**。要跑用独立 profile 或 `--patch` 叠加。
3. **`apply()` 里不许"启动即干活"**：任何 `setTimeout` 自动跑的动作必须有显式开关（env），默认关闭。

## 验证一个改动

```bash
# 1) 静态体检
node scripts/guard-daily-profile.mjs

# 2) 全量验收（独立 profile + 仓库外的沙箱工作区；不碰真实团队）
#    完整命令见 docs/verification-p2.md §7
node scripts/desktop-bundle.mjs status
```

验收 harness 的会话与团队 store 都在**仓库外**的独立工作区（不污染本仓库工作区），
`DSH_P2_WORKSPACE` 可覆盖。**绝不要把 harness 指向真实工作区**——两边会互相覆盖团队数据。

## 提交与回退

- 一次可验收的改动 = 一个 commit；阶段打 tag。
- commit message 首行写**做了什么**，正文写**判据**（哪条命令、退出码、报告里的哪个字段）。
- 需要回退：`git reset --hard <tag>`；profile 改动回退用 `node scripts/desktop-bundle.mjs uninstall`。
- 改动 `~/.dsh/profiles/*` 之前，先备份并记录 SHA256（`desktop-bundle.mjs` 会自动做）。

## 目录约定

| 目录 | 放什么 |
|---|---|
| `agent-team/` | 插件本体：Host 状态机、preset 声明、作用域工具、抽屉前端 |
| `scripts/` | 体检、复现、装卸、asar 抽取、里程碑快照 |
| `docs/` | 设计、实测、防坑文档 |
| `spike-*/`、`.p1a/`…`.p2/`、`.diag/` | **维护者本地的验收现场**，已在 `.gitignore` 里，不进公开仓库 |
| `.team/` `dist/` | 运行期数据与产物，**不入库** |

## 文档双语规则（2026-11-22 起）

**面向用户与贡献者的文档一律中英双语，放在同一个文件里**：中文在上、`---` 分隔、英文在下，
顶部用 `<a id="zh">` / `<a id="en">` 锚点互相跳转（见 `README.md` 的写法）。

- 适用：`README.md`、`CONTRIBUTING.md`、`docs/README.md`、`docs/panels.md`、
  `docs/verification-install.md`、`docs/GUIDE.md`（英文导读版）、以及**以后新增的同类文档**；
- 不适用：`docs/verification-*.md` 这类实测记录与 `CHANGELOG.md` —— 它们是过程证据，保持单语，
  只在顶部写一句英文摘要；
- **改了中文就必须同步改英文**，否则 PR 不合并。评审时把"英文段是否与中文段同义"当成一条判据。

## 许可

本仓库以 **MIT** 发布（见 [`LICENSE`](LICENSE)）。**提交 PR 即视为同意以 MIT 授权你的贡献**（inbound = outbound），不需要额外签 CLA。

> `agent-team/LICENSE` 是根 `LICENSE` 的副本：npm 打包只认包内的 `LICENSE`（`files` 是白名单，
> 根目录那份不会被自动带进 tarball）。改许可证时**两份必须同时改**；`diff LICENSE agent-team/LICENSE` 应无输出。
> 如果你不接受这一点，请不要提交 PR，改为开 issue 描述问题。

## 提交前自检清单

- [ ] `guard` exit 0
- [ ] 改动涉及的判据跑过，并在 commit message 里引用了报告字段
- [ ] 没有把测试会话/测试团队写进用户真实工作区
- [ ] 文档同步（改了行为就改 `docs/` 对应章节 + 变更记录）
- [ ] **双语同步**：面向用户/贡献者的文档必须中英同改（用户 2026-11-22 定的规则，见下）
- [ ] 没有提交密钥、绝对路径等个人信息

---

<a id="en"></a>

# Contributing

> [中文](#zh) ｜ English
>
> Read [`README.md`](README.md) first to learn what this is, then [`docs/handover.md`](docs/handover.md)
> for the current state of the project.

## Environment

- DSH **0.2.2-rc.5** (desktop). The sources live inside `C:\Software\DSH\resources\app.asar`, which
  plain Node cannot read — extract them with `python scripts/asar-extract.py` (usage in the script header).
- **pnpm is required**: `dsh plugin` spawns it internally, and packaging uses it. Install it with
  `npm i -g pnpm`.
- **There is no test framework**: every acceptance criterion is "a script plus an exit code / report
  JSON", documented in the `docs/verification-*.md` files.

## Three things to run before committing

```bash
node scripts/guard-daily-profile.mjs        # exit 0 (no test plugin polluted the daily profile, no bare return)
node scripts/repro-pre-step-waterfall.mjs   # output matches the documentation
node scripts/desktop-bundle.mjs status      # if you changed profile install/uninstall
```

`.githooks/pre-commit` runs the first two automatically and **rejects the commit on ERROR**. Enable it
in a fresh clone:

```bash
git config core.hooksPath .githooks
```

## Three hard rules (all learned the hard way)

1. **Waterfall events must `return next()`**: `agent/pre-step`, `agent/request`,
   `agent/request-error`, `system-prompt/assemble`. A bare `return` is not "allow" — it hands
   `undefined` back as the decision and makes every session on the host crash on every turn. See
   [`docs/pitfall-pre-step-waterfall.md`](docs/pitfall-pre-step-waterfall.md).
2. **`*-spike` / `*-test` never go into a daily profile's `bundles`.** Run them in a dedicated profile
   or via `--patch`.
3. **No "work at startup" inside `apply()`**: any `setTimeout`-driven action must sit behind an
   explicit env switch, off by default.

## Verifying a change

```bash
# 1) Static health check
node scripts/guard-daily-profile.mjs

# 2) Full acceptance (dedicated profile + a sandbox workspace outside this repo; never touches a real team)
#    Full command in docs/verification-p2.md §7
node scripts/desktop-bundle.mjs status
```

The acceptance harness keeps its sessions and team store in a **separate workspace outside this
repository**, so the repository's own workspace stays clean; override it with `DSH_P2_WORKSPACE`.
**Never point the harness at a real workspace** — the two would overwrite each other's team data.

## Commits and rollbacks

- One verifiable change = one commit; tag milestones.
- The first line of a commit message says **what changed**; the body states the **criterion** (which
  command, which exit code, which report field).
- To roll back: `git reset --hard <tag>`. To roll back profile changes:
  `node scripts/desktop-bundle.mjs uninstall`.
- Before touching `~/.dsh/profiles/*`, back up and record SHA256 (`desktop-bundle.mjs` does this
  automatically).

## Directory layout

| Directory | Contents |
|---|---|
| `agent-team/` | The plugin itself: host state machine, preset declarations, scoped tools, drawer UI |
| `scripts/` | Health checks, reproductions, install/uninstall, asar extraction, milestone snapshots |
| `docs/` | Design, verification and pitfall documents |
| `spike-*/`, `.p1a/`…`.p2/`, `.diag/` | **Maintainer-local acceptance fixtures**, already in `.gitignore`; not part of the public repo |
| `.team/` `dist/` | Runtime data and build output, **never committed** |

## Documentation language rule (since 2026-11-22)

**User-facing and contributor-facing documents are bilingual in a single file**: Chinese first, then a
`---` separator, then English, with `<a id="zh">` / `<a id="en">` anchors at the top so the two versions
can jump to each other (see `README.md`).

- Applies to: `README.md`, `CONTRIBUTING.md`, `docs/README.md`, `docs/panels.md`,
  `docs/verification-install.md`, `docs/GUIDE.md` (English guide), and any **new document of the same
  kind**;
- Does not apply to: verification records such as `docs/verification-*.md` and `CHANGELOG.md` — they are
  process evidence, stay monolingual, with a one-line English summary at the top;
- **Changing the Chinese text means changing the English text in the same commit**, otherwise the PR is
  not merged. Treat "the English section says the same thing as the Chinese one" as a review criterion.

## License

This repository is released under **MIT** (see [`LICENSE`](LICENSE)). **Opening a PR means you agree to
license your contribution under MIT** (inbound = outbound); no CLA to sign.

> `agent-team/LICENSE` is a copy of the root `LICENSE`: npm packaging only honours the `LICENSE`
> inside the package (`files` is a whitelist, so the root copy is not included in the tarball).
> When changing the license, **both files must change together**; `diff LICENSE agent-team/LICENSE`
> should print nothing. If you are not comfortable with that, please open an issue instead of a PR.

## Pre-commit checklist

- [ ] `guard` exits 0
- [ ] The criteria affected by your change were run, and the commit message cites the report fields
- [ ] No test session or test team was written into a user's real workspace
- [ ] Docs updated (behaviour change ⇒ the matching `docs/` section + changelog entry)
- [ ] **Both languages updated**: user-facing and contributor-facing docs must change in Chinese *and* English (rule set 2026-11-22, see below)
- [ ] No secrets, absolute paths or other personal information in the diff
