# 防坑文档 #1：`agent/pre-step` 是 waterfall —— 裸 `return` 会击穿所有会话

> 事故编号：INC-2026-11-20-PRESTEP（P1c.2 验证插件上线当晚）
> 影响面：桌面端 profile 的**全部会话、每一轮**；暴露时长达数小时
> 现状：已修复并重启验证；`spike-p1c2` 已从日常 profile 的 bundles 移出
> 核查环境：DSH `0.2.0-rc.2`（npm 安装）；桌面端为 Electron 打包安装，代码语义相同但行号可能漂移 —— **定位用代码形状，不要用行号**

---

## 0. 一句话规则

**挂在 waterfall 事件上的监听器，必须声明 `next` 参数；要放行就 `return next()`，禁止裸 `return`。**
裸 `return` 不是"放行"，而是"把 `undefined` 当成决策返回"。

---

## 1. 症状：怎么一眼认出是这个坑

| 现象 | 说明 |
|---|---|
| GUI 里红字：`本轮运行失败 Cannot read properties of undefined (reading 'kind')` | 中文文案来自 `message.turnError`；英文是真正抛出的 TypeError |
| **同一宿主上的所有会话**都中招 | 新会话、老会话的新一轮消息、子会话全炸 —— 这是"全局钩子"而非"某个会话数据坏了" |
| 另一个 profile（如 `web`）完全正常 | 因为那个 profile 没装肇事插件 |
| 会话日志里查不到这条错误文本 | 它在回合开始前的决策阶段抛出，不进会话事件流，别在 jsonl 里白找 |

排查顺序（照做，不要先怀疑模型/网络）：
1. 是不是**所有**会话都这样？→ 是 = 全局钩子/全局插件问题。
2. 最近动过哪个 profile？`~/.dsh/profiles/<name>/package.json` 的 `dsh.profile.bundles` 里有没有新东西？
3. 在那个 profile 的 `node_modules` 里 grep `agent/pre-step`。

---

## 2. 机制：waterfall 到底怎么取值

cordis 的 waterfall（`@deepseek-ai/cordis/lib/index.js:317-325`，0.2.0-rc.2）：

```js
waterfall(...args) {
  const cbs = this.dispatch('waterfall', args)
  const inner = args.pop()          // 最内层的兜底实现
  const next = () => (cbs.shift() ?? inner)(...args)
  args.push(next)
  return next()                     // 返回"最外层监听器"的返回值
}
```

三条推论（这就是全部坑源）：

1. **返回值 = 最外层监听器的返回值**，不是"最后改过的值"。
2. **不调 `next()` 就是否决整条链**，包括内置兜底行为。
3. 否决时必须**自己返回一个合法决策对象**；返回 `undefined` 等于交了个空决策。

宿主侧怎么用这个结果（`dsh-agent-loop/lib/index.js:902-925`，0.2.0-rc.2）：

```js
const decision = await this.dispatch.waterfall('agent/pre-step', {...},
  () => Promise.resolve({ kind: 'enter', messages: ... }))   // ← 内置兜底
signal.throwIfAborted()
if (decision.kind === 'reject') return decision              // ← 第 920 行，undefined 就在这炸
return { ...decision, assembly }
```

**两张代码对不上，就是事故。**

---

## 3. 事故代码 vs 正确代码

事故版（`spike-p1c2/index.js`，原始备份 `.diag/backup-20261120-205043/index.js`）：

```js
ctx.on('agent/pre-step', (payload) => {          // ✗ 没有 next 参数
  if (!state.latch.has(id)) return               // ✗ 未上闩 = 绝大多数会话 → 返回 undefined
  if (human) return                              // ✗ 上闩后人工放行 → 同样 undefined
  return { kind: 'reject' }                      // ✓ 只有这条是对的
})
```

正确版：

```js
ctx.on('agent/pre-step', (payload, next) => {    // ✓ 声明 next
  if (!state.latch.has(id)) return next()        // ✓ 放行 = 走 next
  if (human) return next()                       // ✓
  return { kind: 'reject' }                      // ✓ 否决 = 明确返回决策
})
```

三种写法的实际结果（用真 cordis 实测，见 §9）：

| 写法 | `await ctx.waterfall(...)` 得到 | 后果 |
|---|---|---|
| `return`（无值） | `undefined` | 宿主读 `.kind` → TypeError → **整轮失败** |
| `return next()` | 兜底决策 `{ kind: 'enter', … }` | 正常 |
| `return { kind: 'reject' }` | 决策对象 | 正常拦截本步 |

---

## 4. 为什么是"所有会话"，而不是"测试会话"

- 插件在**根 ctx** 上 `ctx.on(...)`，钩子对**该宿主进程内所有 agent** 生效。
- 守卫的第一句是 `if (!state.latch.has(id)) return`：**未上闩的会话是默认路径**，而默认路径正好写错。
- 于是"平时没事"的假设不成立 —— 它从加载的那一刻起，对所有会话的每一轮都是致命路径。
- 更隐蔽的是：**自动运行**。该插件 `apply()` 里有 `setTimeout(2500, run)`，启动即跑一套测试并往 GUI 里建会话，把"测试流量"和"真实会话"混在一起。

---

## 5. 本机哪些事件是 waterfall（0.2.0-rc.2 实测）

| 事件 | 派发方式 | 说明 |
|---|---|---|
| `agent/pre-step` | waterfall | 每轮每步都走；返回 `{ kind: 'enter' \| 'reject' }` |
| `agent/request` | waterfall | 组请求参数 |
| `agent/request-error` | waterfall | 错误处置决策 |
| `system-prompt/assemble` | waterfall | 组装系统提示；**也在 pre-step 里被调用**，写坏它同样让每轮必炸 |
| `agent/turn-stopping` | **serial** | 语义不同：返回值是"第一个 bail 值"，不返回就是继续 |

⚠️ **waterfall 与 serial/bail 语义不要混**：serial 里"不返回"= 继续；waterfall 里"不返回"= 交空决策。同一份代码里两种都有。

**不要背名单**：判断依据是回调签名 —— 有 `next` 参数的就是 waterfall（或 serial），就必须显式表态。

---

## 6. 五条硬规则（可直接抄进评审清单）

1. 任何 `on('<waterfall 事件>', ...)` 的回调必须声明 `next`；放行一律 `return next()`，全文禁止裸 `return`。
2. 否决必须返回合法决策对象（如 `{ kind: 'reject' }`），不许用"返回值缺失"表达否决。
3. 验证用插件（`*-spike` / `*-test`）**不得**进入任何日常 profile 的 `dsh.profile.bundles`；要跑用独立 profile 或 `--patch` 临时叠加。
4. `apply()` 里任何 `setTimeout` 自动干活的动作，必须有显式开关（env 或 config），默认不跑。
5. 改完 profile / 装完插件，先跑 `node scripts/guard-daily-profile.mjs`，**exit 0 才允许重启**。

---

## 7. 装插件前必须回答的 7 个问题

- [ ] 它挂的是哪些事件？其中有没有 waterfall（`agent/pre-step`、`system-prompt/assemble`）？
- [ ] 每个 waterfall 监听器都有 `next` 参数、且放行路径都调了 `next()` 吗？
- [ ] 有没有 `setTimeout(…, run)` 之类的**启动即干活**？开关是什么？
- [ ] 它会创建会话/发 prompt 吗？会的话在哪个 profile 里跑，会不会混进用户日常会话列表？
- [ ] 它进的是哪个 profile 的 `bundles`？这个 profile 是不是用户每天都开？
- [ ] 出问题时的**一键止损**是什么？（本次：从 bundles 删一行 + 重启）
- [ ] 装之前备份了 profile 的 `package.json` 吗？

---

## 8. 自动化防坑：`scripts/guard-daily-profile.mjs`

两条检查，判据是**退出码**：

- **A. 激活检查**：profile 的 `bundles` 里有没有 `*-spike`/`*-test`（ERROR）、有没有指向工作区的 `link:`（WARN）、`-preview`（WARN）；装了但没进 bundles 的（INFO）。
- **B. 监听器检查**：扫每个已激活插件（以及 `--scan` 指定目录）的 js，找出 `agent/pre-step` / `system-prompt/assemble` 注册点；**没有 `next` 参数且存在裸 `return`** → ERROR。

```bash
node scripts/guard-daily-profile.mjs                  # 全部 profile，日常体检
node scripts/guard-daily-profile.mjs --profile desktop
node scripts/guard-daily-profile.mjs --scan spike-p1c2 # 只查某个插件目录
node scripts/guard-daily-profile.mjs --json            # 给脚本用
```

**本次实测**（2026-11-20）：

| 输入 | 输出 | 退出码 |
|---|---|---|
| `--scan spike-p1c2`（修复后） | `0 error(s)` / `PASS` | 0 |
| `--scan .diag/backup-20261120-205043`（修复前） | `ERROR B.listener … index.js:40` / `FAIL` | 1 |
| 全量（修复后） | 1 WARN（preview 仍激活）+ 1 INFO（p1c2 休眠） / `PASS` | 0 |

**它抓不到什么**（必须知道，否则会误以为有护栏了）：
- 只做静态形状匹配，不执行代码：语义错误（比如 `next()` 调了但结果被丢弃）抓不到。
- 只认 `agent/pre-step` 与 `system-prompt/assemble`；新增的 waterfall 事件要往 `WATERFALL_EVENTS` 里加。
- 压缩/转译过的产物可能解析失败（会给 WARN，要求人工看）。
- 不检查"插件是否会自己建会话"这类行为，只看名字与激活状态。

---

## 9. 离线复现（不用起宿主，10 秒出结论）

`scripts/repro-pre-step-waterfall.mjs`：用真 cordis 起一个 `Context`，注册一个"裸 return"的监听器，跑 `waterfall`（脚本自己找本机 cordis，找不到就用 `DSH_CORDIS` 指路）。

期望输出：

```
not latched -> undefined
CRASH: TypeError: Cannot read properties of undefined (reading 'kind')
latched     -> { kind: 'reject' }
fixed       -> { kind: 'enter', messages: [ 'claimed' ] }
```

判据：第一行是 `undefined`、第二行 TypeError → 复现成立；`fixed` 那行正常 → 修法成立。
这个脚本可以随时改造成"给候选插件做行为测试"的模板：把监听器换成待测实现即可。

---

## 10. 事故档案（2026-11-20）

| 时间 | 事件 |
|---|---|
| 20:28 | P1c 验证 spike 装进 desktop profile 的 node_modules（未进 bundles） |
| 20:42 | P1c.2 spike 被写进 desktop profile 的 `bundles` ⇒ 钩子对所有会话生效 |
| 20:46 | 用户报"桌面端所有新会话/新消息都报 `Cannot read properties of undefined (reading 'kind')`，只有网页端能用" |
| 20:50 | 离线复现成立（cordis waterfall 语义 + 事故代码形状） |
| 20:52 | 修钩子（`next()`）、加自动运行开关、从 bundles 移出、文档留痕 |
| 20:52:54 | 桌面端重启；`hub.log` 记录新 `system.start`；之后本会话各轮正常 ⇒ 修复实测生效 |

**连带损失（必须记住）**：
- `.p1c2/report.json` 五项全 `false` **不能当作"交接协议失败"的证据** —— 那是这个 bug 导致的（`humanGuard.humanMessagePersisted: false` 就是被崩掉的回合吞掉的消息）。P1c.2 结论作废，需重跑。
- 用户当晚的桌面端不可用；靠 web profile 才能继续工作。
- 教训：**验证插件的失败面 = 它挂的事件链 × 它被激活的 profile**。挂到每轮必走的链上还装进日常 profile，等于给整个 App 上地雷。

---

## 11. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-20 | 建立本文档；记录 INC-2026-11-20-PRESTEP；加入 `scripts/guard-daily-profile.mjs` 与 `scripts/repro-pre-step-waterfall.mjs` |
