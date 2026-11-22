# 参与开发

> 先读 [`README.md`](README.md) 了解这是什么，再读 [`docs/handover.md`](docs/handover.md) 了解当前进度。

## 环境

- DSH **0.2.2-rc.5**（桌面端）。源码在 `C:\Software\DSH\resources\app.asar` 里，普通 Node 读不进去——
  用 `python scripts/asar-extract.py` 抽取（用法见脚本头部注释）。
- 本机没有 pnpm；打包用 `npm pack ./agent-team --pack-destination dist`。
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

# 2) 全量验收（独立 profile + 沙箱工作区；不碰真实团队）
#    完整命令见 docs/verification-p2.md §7
node scripts/desktop-bundle.mjs status
```

验收 harness 的会话与团队 store 都在仓库外的独立工作区（不污染本仓库工作区），
`DSH_P2_WORKSPACE` 可覆盖。**绝不要把 harness 指向真实工作区**——两边会互相覆盖团队数据。

## 提交与回退

- 一次可验收的改动 = 一个 commit；阶段打 tag（`p0`…`p3`、`abc-fix`、`p4-start`……）。
- commit message 首行写**做了什么**，正文写**判据**（哪条命令、退出码、报告里的哪个字段）。
- 需要回退：`git reset --hard <tag>`；profile 改动回退用 `node scripts/desktop-bundle.mjs uninstall`。
- 改动 `~/.dsh/profiles/*` 之前，先备份并记录 SHA256（`desktop-bundle.mjs` 会自动做）。

## 目录约定

| 目录 | 放什么 |
|---|---|
| `agent-team/` | 插件本体：Host 状态机、preset 声明、作用域工具、抽屉前端 |
| `spike-*/` | 各阶段验收 harness（不参与运行） |
| `scripts/` | 体检、复现、装卸、asar 抽取 |
| `.p1a/`…`.p2/` | 运行证据（report.json 等），入库 |
| `.team/` `dist/` | 运行期数据与产物，**不入库** |

## 许可

本仓库以 **MIT** 发布（见 [`LICENSE`](LICENSE)）。**提交 PR 即视为同意以 MIT 授权你的贡献**（inbound = outbound），不需要额外签 CLA。

> `agent-team/LICENSE` 是根 `LICENSE` 的副本：npm 打包只认包内的 `LICENSE`（`files` 是白名单，
> 根目录那份不会被自动带进 tarball）。改许可证时**两份必须同时改**；`diff LICENSE agent-team/LICENSE` 应无输出。
如果你不接受这一点，请不要提交 PR，改为开 issue 描述问题。

## 提交前自检清单

- [ ] `guard` exit 0
- [ ] 改动涉及的判据跑过，并在 commit message 里引用了报告字段
- [ ] 没有把测试会话/测试团队写进用户真实工作区
- [ ] 文档同步（改了行为就改 `docs/` 对应章节 + 变更记录）
- [ ] 没有提交密钥、绝对路径泄漏之外的个人信息（开源前还要过一遍 `docs/git-workflow.md` §5）
