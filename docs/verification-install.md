<a id="zh"></a>

# 安装实测（对外发布用，2026-11-22）

> 中文 ｜ [English](#en)
>
> 目的：证明"别人拿到这个插件，用官方安装命令装上就能用"，而不是只有本机能跑。
> 判据是**命令输出 + 组合后的配置 + 运行时路由**，不是"看起来装上了"。

> **当前对外只开放 GitHub 安装。** npm 包尚未发布（账号环节未完成），
> 所以"从 registry 安装"这一条**不是待验证，而是暂时不存在**；发布后再补测并勾掉。

## 1. 环境

| 项 | 值 |
|---|---|
| DSH | `0.2.2-rc.5`（桌面端 Electron 打包版） |
| OS | Windows 10.0.26200 |
| pnpm | `12.21.0`（`npm i -g pnpm` 装；`dsh plugin` 内部会 spawn 它） |
| 被测产物 | `agent-team/`（源码目录）与 `dist/dsh-agent-team-1.10.0.tgz`（npm pack 产物，10 个文件；**尚未发布到 registry**） |

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
+ dsh-agent-team <- <repo>/agent-team
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
| `GET /agent-team/workspaces` | **200** |
| `GET /agent-team/workspaces` → `default` | 主工作区（会话最多的那个，见 §5） |

`/agent-team/*` 是本插件注册的同源路由：能返回 200，说明 Host 侧插件**真的激活了**，不是只写进了配置。

## 5. 实测四：没配 `workspaceRoot` 时的默认工作区

第一次实现取的是"注册表第一个工作区"，实测发现它被解析成最近新建的临时工作区
（`<sandbox>\ws-e`）——因为 DSH 把新工作区排在注册表最前。

改成**会话最多的工作区**后再测：`default` = 主工作区（当时 11 个会话，最多），符合预期。
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

- **真实 npm registry 安装**：npm 包**尚未发布**（账号环节未完成），这条现在不成立；发布后需要补测 `dsh plugin ... add dsh-agent-team`。
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

---

<a id="en"></a>

# Install verification (for public release, 2026-11-22)

> [中文](#zh) ｜ English
>
> Goal: prove that "someone else can take this plugin, install it with the official command and use
> it" — not merely that it runs on the author's machine.
> The criteria are **command output + the composed config + runtime routes**, not "it looked installed".

> **Only the GitHub install is public right now.** The npm package is not published yet (the account
> setup is unfinished), so "install from the registry" is **not pending verification — it does not
> exist yet**; it will be tested and ticked once published.

## 1. Environment

| Item | Value |
|---|---|
| DSH | `0.2.2-rc.5` (Electron desktop build) |
| OS | Windows 10.0.26200 |
| pnpm | `12.21.0` (installed with `npm i -g pnpm`; `dsh plugin` spawns it) |
| Artifacts tested | `agent-team/` (source directory) and `dist/dsh-agent-team-1.10.0.tgz` (npm pack output, 10 files; **not published to the registry**) |

## 2. Test 1: install **directly from GitHub** (2026-11-22, re-tested after publishing)

Repository: `github.com/1289959658wang-hue/dsh-agent-team` (public, `main` branch, tag `v1.10.0`)

```bash
dsh --profile ghcheck --from-default-profile web --dump-config
dsh plugin --profile ghcheck add "github:1289959658wang-hue/dsh-agent-team#path:/agent-team"
```

Output (7.9 s):

```
Packages: +1
dependencies:
+ dsh-agent-team 1.10.0
Done in 7.9s using pnpm v12.21.0
```

Checks:

| Check | Result |
|---|---|
| profile `dependencies` | `github:1289959658wang-hue/dsh-agent-team#path:/agent-team` |
| profile `dsh.profile.bundles` | `dsh-agent-team` appended automatically |
| `--dump-config` | `agent-team-host` / `preset-agent-team` / `preset-agent-team-worker` all present |
| `GET /agent-team/state` after boot | **200** |
| `GET /agent-team/workspaces` | **200**, `default` = the main workspace |

**Conclusion: the `#path:/<subdir>` syntax works** — the plugin does not need to be moved to the
repository root.

## 3. Test 2: install from a **local directory** (equivalent path, reproducible offline)

```bash
# fresh profile
dsh --profile oss-web --from-default-profile web --dump-config
# install the plugin (equivalent syntax: github:<owner>/<repo>#path:/agent-team)
dsh plugin --profile oss-web add "<repo>/agent-team"
```

Output:

```
dependencies:
+ dsh-agent-team <- <repo>/agent-team
Done in 38ms using pnpm v12.21.0
```

**Key observation**: `dsh plugin add` **also writes the bundle into the profile's selection list** —
no extra step needed:

```
before: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
after : ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-agent-team']
```

The composed config (`dsh --profile oss-web --dump-config`) contains:

```
- id: agent-team-host             name: dsh-agent-team      ← host plugin
- id: preset-agent-team                                        ← Leader mode
- id: preset-agent-team-worker                                 ← Worker mode
- id: tool-agent-team-leader      name: dsh-agent-team/tools
- id: tool-agent-team-worker      name: dsh-agent-team/tools
```

> This settles the earlier open question: "`dsh plugin add` only installs the package and the bundle
> must be selected separately" — **measured false**; it does both in one step.

## 4. Test 3: it really is mounted at runtime

After booting web on that profile (`--port 0 --no-open`):

| Request | Result |
|---|---|
| `GET /agent-team/state` | **200** |
| `GET /agent-team/workspaces` | **200** |
| `GET /agent-team/workspaces` → `default` | the main workspace (the one with most sessions, see §5) |

`/agent-team/*` are same-origin routes registered by this plugin: a 200 means the host-side plugin
**is genuinely active**, not merely written into a config file.

## 5. Test 4: default workspace when `workspaceRoot` is unset

The first implementation used "the first workspace in the registry"; measurement showed it resolved to
the most recently created scratch workspace (`<sandbox>\ws-e`), because DSH puts new workspaces at the
front of the registry.

After switching to **the workspace with the most sessions** it resolved to the main workspace (11
sessions at the time, the highest), as expected. Only when no workspace has sessions does it fall back
to the first one, and finally to the process cwd.

## 6. npm package contents (no tests in the published package)

```bash
cd agent-team && npm pack --pack-destination ../dist
tar -tzf ../dist/dsh-agent-team-1.10.0.tgz
```

10 files, the plugin itself only:

```
package/LICENSE          package/index.js          package/tools.js
package/client.js        package/package.json      package/cordis.patch.yml
package/icon.svg         package/docs/DETAIL.md
package/locale/en.json   package/locale/zh.json
```

No `spike-*` / `test` / `spec` inside (`tar -tzf | grep -E "test|spike|spec"` is empty).

## 7. Not verified (do not claim these as supported)

- **Installing from the real npm registry**: the package **is not published** (account setup
  unfinished), so this does not apply yet; test `dsh plugin ... add dsh-agent-team` after publishing.
- **macOS / Linux**: only run on Windows; `scripts/desktop-bundle.mjs` assumes `%USERPROFILE%`.
- **A brand-new machine**: this was the author's machine plus a fresh profile, not a fresh OS.

## 8. Reproducing

```bash
# 1) pnpm must be on PATH (dsh plugin spawns it)
npm i -g pnpm

# 2) create a clean web profile and install the plugin
dsh --profile oss-web --from-default-profile web --dump-config
dsh plugin --profile oss-web add "<repo>/agent-team"     # or dist/dsh-agent-team-1.10.0.tgz

# 3) boot and verify the plugin is actually active
dsh --profile oss-web --port 0 --no-open &
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:<port>/agent-team/state   # expect 200
```

Delete the test profile afterwards: `rm -rf ~/.dsh/profiles/oss-web` (it only links the plugin in and
never touches real data).
