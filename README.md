# Agent Team 模式（DeepSeek Harness 插件）

给 DSH 增加两个工作模式：**`Agent Team · Leader`** 与 **`Agent Team · Worker`**。
只有选了这两个模式的会话才会进入团队流程；标准模式等其它模式**看不到任何团队工具**。

> 当前版本 **1.10.0**。功能边界与已知限制见 [CHANGELOG.md](./CHANGELOG.md)，完整说明见 [docs/GUIDE.md](./docs/GUIDE.md)。
> 宿主：DSH **0.2.2-rc.5**（桌面端 Electron 打包版）实测通过。

## 安装

两种方式都是 DSH 官方支持的插件安装路径（`dsh plugin` 装包 + bundle 选择），装完**重启桌面端**。

```bash
# 前置：dsh plugin 会调用 pnpm（没装先装一个）
npm i -g pnpm

# 方式一：npm
dsh plugin --profile desktop add dsh-agent-team

# 方式二：GitHub（直接从仓库的 agent-team/ 子目录安装）
dsh plugin --profile desktop add "github:1289959658wang-hue/dsh-agent-team#path:/agent-team"
```

> **GitHub 方式已实测通过**（2026-11-22）：`#path:/agent-team` 语法可用，装完 `dsh --dump-config` 能看到两个 preset，运行时 `/agent-team/state` 返回 200。
> 完整记录（含组合配置、默认工作区推导、未验证项）：[docs/verification-install.md](./docs/verification-install.md)

装完重启桌面端，新建会话时在模式选择器里选 **Agent Team · Leader** 即可。

卸载：

```bash
dsh plugin --profile desktop remove dsh-agent-team
```

> 包里只有插件本身（`index.js` / `tools.js` / `client.js` / `cordis.patch.yml` / `locale` / `docs/DETAIL.md` / `icon.svg` / `LICENSE`），
> 不含任何测试用例或验收脚本。

## 它是什么

| 角色 | 能做什么 |
|---|---|
| **Leader** | 看岗位表、派发新 worker、组播消息、审批交接。团队里**只有一个人**能当 leader |
| **Worker** | 接任务、向 leader 汇报、在 leader 允许范围内与同事协同；不能派发、不能群发 |
| **Host 侧** | 岗位表、组播消息、派发/交接申请的唯一写者（落 `<工作区>/.team/`，**一个工作区一份**） |

审批路径是固定的，不靠提示词自觉：

- **派发**（开新 worker）：leader 申请 → **用户批准**（或用户切到「完全权限」，leader 直接派）；
- **交接**（同岗位换人）：worker 申请 → **leader 批准**；只有 leader 不可用时才由用户代批；
- **移交**（leader 归档/宕机后）：在抽屉的 leader 卡片里指定接任会话，一次写盘内卸任+任命，留 `leaderHistory`；模型没有这条路径。

侧边栏底部有一个 **Agent Team** 按钮（有待办时显示角标），点开是右侧抽屉：**待办**（批准/拒绝/移交 leader）
与**消息**（组播只读审计，四个筛选 + SSE 实时，断开退回轮询）。抽屉头部有**工作区下拉**：
团队按工作区划分，切换只换视图，不影响任何正在跑的会话。

## 多工作区

1.9.0 起每个工作区有**自己的团队**：工具按调用方会话反查它属于哪个工作区，面板用 `?workspace=` 取数，
跨工作区投递直接拒绝（`收件人不在本团队`）。已有团队零迁移——store 本来就在各自工作区的 `.team/` 里。

`workspaceRoot` 不用配：留空就用 DSH 注册表里的默认工作区。要钉死某个目录再在
`agent-team/cordis.patch.yml` 的 `config.workspaceRoot` 里写绝对路径。

## 安全须知

1. **`agent/pre-step` 是 waterfall**：监听器必须声明 `next`，放行一律 `return next()`。
   裸 `return` 会让**宿主上所有会话每一轮都报错**（历史上真发生过，见 [docs/pitfall-pre-step-waterfall.md](./docs/pitfall-pre-step-waterfall.md)）。
2. 守卫监听器只注册在 **worker preset 的作用域**里，标准会话进不了它的视野。
3. `apply()` 里没有任何自动运行：插件启动时只读写自己的 store，不建会话、不发消息。

## 文档

| 想了解 | 看 |
|---|---|
| **完整说明（装/用/架构/流程/功能/接口/排错）** | [docs/GUIDE.md](./docs/GUIDE.md) |
| 插件内部结构（给你要改代码时） | [agent-team/docs/DETAIL.md](./agent-team/docs/DETAIL.md) |
| 版本与已知边界 | [CHANGELOG.md](./CHANGELOG.md) |
| 团队章程 | [docs/charter-default.md](./docs/charter-default.md) |
| 面板规格 | [docs/panels.md](./docs/panels.md) |
| 设计调研与组播协议 | [docs/reusable-solutions.md](./docs/reusable-solutions.md) |
| 写钩子前必读 | [docs/pitfall-pre-step-waterfall.md](./docs/pitfall-pre-step-waterfall.md) |
| 安装实测 | [docs/verification-install.md](./docs/verification-install.md) |
| 索引 | [docs/README.md](./docs/README.md) |

## 开发与贡献

```bash
git clone <repo> && cd <repo>
node scripts/guard-daily-profile.mjs     # 体检：exit 0
node scripts/gen-preset-tools.mjs --check  # preset 工具清单没跟 DSH 的 standard 漂移
node scripts/desktop-bundle.mjs install  # 装进本机 desktop profile（会先备份）
```

验收与测试用例**不随包发布**，只在维护者仓库里跑（见 [CONTRIBUTING.md](./CONTRIBUTING.md)）。

## 许可证

MIT，见 [LICENSE](./LICENSE)。
