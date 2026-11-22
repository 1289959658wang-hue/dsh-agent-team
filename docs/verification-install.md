# 安装实测（对外发布用，2026-11-22）

> 目的：证明"别人拿到这个插件，用官方安装命令装上就能用"，而不是只有本机能跑。
> 判据是**命令输出 + 组合后的配置 + 运行时路由**，不是"看起来装上了"。

## 1. 环境

| 项 | 值 |
|---|---|
| DSH | `0.2.2-rc.5`（桌面端 Electron 打包版，`C:/Software/DSH`） |
| OS | Windows 10.0.26200 |
| pnpm | `12.21.0`（`npm i -g pnpm` 装；`dsh plugin` 内部会 spawn 它） |
| 被测产物 | `agent-team/`（源码目录）与 `dist/dsh-agent-team-1.10.0.tgz`（npm 包，10 个文件） |

## 2. 实测一：从 **GitHub 直接安装**（2026-11-22，发布后复测）

仓库：`github.com/1289959658wang-hue/dsh-agent-team`（公开，`main` 分支，tag `v1.10.0`）

```bash
dsh --profile ghcheck --from-default-profile web --dump-config
dsh plugin --profile ghcheck add "github:1289959658wang-hue/dsh-agent-team#path:/agent-team"
```

输出（7.9 秒）：

```
Packages: +1
dependencies:
+ dsh-agent-team 1.10.0
Done in 7.9s using pnpm v12.21.0
```

核对：

| 检查 | 结果 |
|---|---|
| profile `dependencies` | `github:1289959658wang-hue/dsh-agent-team#path:/agent-team` |
| profile `dsh.profile.bundles` | 自动追加 `dsh-agent-team` |
| `--dump-config` | `agent-team-host` / `preset-agent-team` / `preset-agent-team-worker` 都在 |
| 起服务后 `GET /agent-team/state` | **200** |
| `GET /agent-team/workspaces` | **200**，`default` = 主工作区 |

**结论：`#path:/<子目录>` 语法可用**，不需要把插件提到仓库根。

## 3. 实测二：从**本地目录**安装（等价路径，离线可复现）

```bash
# 全新 profile
dsh --profile oss-web --from-default-profile web --dump-config
# 装插件（等价语法：github:<owner>/<repo>#path:/agent-team）
dsh plugin --profile oss-web add "<repo>/agent-team"
```

输出：

```
dependencies:
+ dsh-agent-team <- ../../../../../Work Place/AgentWorkTeam/agent-team
Done in 38ms using pnpm v12.21.0
```

**关键观察**：`dsh plugin add` **会同时把 bundle 写进 profile 的选择列表**，不需要额外一步：

```
before: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
after : ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-agent-team']
```

组合后的配置（`dsh --profile oss-web --dump-config`）里出现：

```
- id: agent-team-host             name: dsh-agent-team      ← Host 插件
- id: preset-agent-team                                        ← Leader 模式
- id: preset-agent-team-worker                                 ← Worker 模式
- id: tool-agent-team-leader      name: dsh-agent-team/tools
- id: tool-agent-team-worker      name: dsh-agent-team/tools
```

> 这一条纠正了之前的悬念：`dsh plugin add` 只做包安装、bundle 要另选——**实测不成立**，它一步到位。

## 4. 实测三：运行时真的挂上了

用该 profile 起 web（`--port 0 --no-open`）后：

| 请求 | 结果 |
|---|---|
| `GET /agent-team/state` | **200** |
| `GET /agent-team/workspaces` | **200**（返回 8 个工作区） |
| `GET /agent-team/workspaces` → `default` | `C:\Work Place\AgentWorkTeam`（会话最多的那个，见下） |

`/agent-team/*` 是本插件注册的同源路由：能返回 200，说明 Host 侧插件**真的激活了**，不是只写进了配置。

## 5. 实测四：没配 `workspaceRoot` 时的默认工作区

第一次实现取的是"注册表第一个工作区"，实测发现它被解析成最近新建的临时工作区
（`…\AT-Sandbox\ws-e`）——因为 DSH 把新工作区排在注册表最前。

改成**会话最多的工作区**后再测：`default = C:\Work Place\AgentWorkTeam`（11 个会话，最多），符合预期。
一个会话都没有时才退回第一个，最后才退回进程 cwd。

## 6. npm 包内容（发布包不含测试）

```bash
cd agent-team && npm pack --pack-destination ../dist
tar -tzf ../dist/dsh-agent-team-1.10.0.tgz
```

10 个文件，全部是插件本体：

```
package/LICENSE          package/index.js          package/tools.js
package/client.js        package/package.json      package/cordis.patch.yml
package/icon.svg         package/docs/DETAIL.md
package/locale/en.json   package/locale/zh.json
```

包内没有 `spike-*` / `test` / `spec`（`tar -tzf | grep -E "test|spike|spec"` 为空）。

## 7. 未验证项（不要在文档里写成"支持"）

- **真实 npm registry 安装**：只验证了 GitHub、本地目录与 `npm pack` 产物，**还没从 registry 拉过**（等 `npm publish` 之后补）。
- **macOS / Linux**：只在 Windows 上跑过；`scripts/desktop-bundle.mjs` 假设 `%USERPROFILE%`。
- **全新机器**：本次是本机 + 全新 profile，不是全新系统。

## 8. 复现

```bash
# 1) 需要 pnpm 在 PATH（dsh plugin 会 spawn 它）
npm i -g pnpm

# 2) 造一个干净的 web profile 并装插件
dsh --profile oss-web --from-default-profile web --dump-config
dsh plugin --profile oss-web add "<repo>/agent-team"     # 或 dist/dsh-agent-team-1.10.0.tgz

# 3) 起服务并验证插件真的激活
dsh --profile oss-web --port 0 --no-open &
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:<port>/agent-team/state   # 期望 200
```

验证完可以把测试 profile 删掉：`rm -rf ~/.dsh/profiles/oss-web`（它只是把插件 link 进来，不碰真实数据）。
