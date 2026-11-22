#!/usr/bin/env node
// 从 shipped 的 `standard` preset **生成**两个团队 preset 的通用工具清单。
//
// 为什么需要它：preset 的 `config.plugins` 是完整清单（没有"继承 standard"这种写法），
// 所以 team preset 只能把 standard 的那 20 多个插件逐字抄一份。DSH 升级时 standard
// 会动（加工具、改 config），抄本不会自动跟着动 —— 那就是**静默漂移**：
// 会话看起来正常，实际少了/多了工具，没人会发现。
//
// 做法：standard 是唯一事实源（从安装目录的 app.asar 里读），team preset 只声明
// **差异**：
//   - CURATED：团队会话要的插件白名单（standard 新增的不会自动进来）
//   - override：`persona`（团队自己的系统提示）、`delegation`（去掉 tool-subagent-control：
//     它注册的 wait_agent / list_agents / send_message 是子智能体通道，会让人误用它去"等团队回复"，
//     结果整轮阻塞、团队消息排在队列里 —— 2026-11-21 实测）
//   - append：`tool-agent-team-leader` / `tool-agent-team-worker`（团队工具）
//   - remove：`tool-plugin-manager` / `tool-plugin-market`（不该自己装卸插件）、
//     `agent-instructions`（AGENTS.md 14.6k 字符，团队会话靠 persona + 交接单）、
//     `tool-schedule` / `command-goal` / `tool-goal`（排期与目标工具与团队任务无关）
// 其余全部按 standard 当前的样子写进去。
//
// 用法：
//   node scripts/gen-preset-tools.mjs --check   # 漂移即 exit 1（pre-commit 用这个）
//   node scripts/gen-preset-tools.mjs --write   # 重写两份清单（升级 DSH 之后跑）
//   node scripts/gen-preset-tools.mjs --diff    # 只打印差异，不改文件
//
// 退出码：0 = 一致 / 1 = 有漂移（--check 时）/ 2 = 读不到 standard 或结构对不上
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const PATCH = path.join(ROOT, 'agent-team', 'cordis.patch.yml')
const ASAR = process.env.DSH_ASAR ?? 'C:/Software/DSH/resources/app.asar'
const IN_ASAR = 'dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml'

/**
 * **策展清单**（1.8.0）：团队会话要用哪些插件，写死在这里。
 *
 * 以前的做法是"抄 standard 的整份清单、再减几项"，于是 standard 加插件我们跟着加、
 * standard 删/改名我们就引用到不存在的包（启动即报错）。现在改成白名单：
 *   - 只认这里列出的 id；条目正文仍从 standard 取（config 跟着新版走）；
 *   - 这里的 id 在 standard 里找不到 → **立刻报错**（那是改名/删除，必须人来改这行清单）；
 *   - standard 新增的插件不会自动进来（要就加进这张表）。
 * 好处：换 DSH 版本时"安装即可用"，工具表稳定，上下文也更省。
 */
const CURATED = [
  'time-context',
  'tool-bash',
  'tool-pwsh',
  'tool-fs',
  'tool-fs-search',
  'tool-jobs',
  'skill-filesystem',
  'tool-skill',
  'planning',
  'compaction',
  'delegation',
  'tool-ask-user',
  'tool-todo',
  'tool-web',
  'present',
  'tool-office',
]

/** 两个 preset 的差异声明：override 用我们自己的条目，append 是我们独有、standard 没有的。 */
const SLOTS = [
  {
    slot: 'preset-agent-team',
    override: ['persona', 'delegation'],
    append: ['tool-agent-team-leader'],
  },
  {
    slot: 'preset-agent-team-worker',
    override: ['persona', 'delegation'],
    append: ['tool-agent-team-worker'],
  },
]

const ENTRY_INDENT = ' '.repeat(10) // `          - id: …`
const PLUGINS_INDENT = ' '.repeat(8) // `        plugins:`

function fail(code, message) {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

/**
 * 从 app.asar 里读 shipped 的 standard preset 文本。
 *
 * **走临时文件而不是 stdout**：Windows 上 Python 的 stdout 编码是控制台代码页（cp936），
 * 非 ASCII 字符（plan-mode 那段里的长破折号 —）会被替换成 U+FFFD 写回 YAML，
 * 看起来只是"格式差异"，实际把内容弄坏了。`x` 子命令是二进制落地，绕开编码。
 */
function readStandard() {
  const temp = path.join(ROOT, '.diag', 'tmp', 'standard.patch.yml')
  try {
    execFileSync('python', [path.join(ROOT, 'scripts', 'asar-extract.py'), 'x', ASAR, IN_ASAR, temp], {
      encoding: 'utf8',
      maxBuffer: 8 << 20,
    })
    return fs.readFileSync(temp, 'utf8')
  } catch (error) {
    fail(2, `读不到 asar 里的 standard preset：${ASAR}\n${IN_ASAR}\n${String(error && error.message ? error.message : error)}`)
  }
}

/**
 * 按缩进切出 `- id:` 条目：一条从 ENTRY_INDENT + "- id:" 开始，到下一条同缩进的
 * `- id:` 或缩进小于 10 的非空行为止。每条带自己的行号区间 [start, end)：
 * 写回时按区间替换，不靠"条目数 × 行数"去猜（那样一有空白差异就会重复插入）。
 */
function splitEntries(lines, from, to) {
  const entries = []
  let current = null
  const stop = Math.min(to, lines.length)
  const close = (at) => {
    if (current === null) return
    // 去掉条目尾部的空行：空行是条目之间的分隔，不属于条目。
    let end = at
    while (end - 1 > current.start && lines[end - 1] !== undefined && lines[end - 1].trim() === '') end -= 1
    current.end = end
    current.lines = lines.slice(current.start, current.end)
    entries.push(current)
    current = null
  }
  for (let index = from; index < stop; index += 1) {
    const line = lines[index]
    if (line.startsWith(`${ENTRY_INDENT}- id:`)) {
      close(index)
      current = { id: line.slice(ENTRY_INDENT.length + 6).trim(), start: index, end: index + 1, lines: [] }
      continue
    }
    if (current === null) continue
    const blank = line.trim() === ''
    const indent = line.length - line.trimStart().length
    if (!blank && indent < ENTRY_INDENT.length) {
      close(index)
      break
    }
  }
  close(stop)
  return entries
}

/** 解析整份 patch，返回每个 slot 的插件区间 [start, end) 与条目。 */
function parsePatch(text) {
  const lines = text.split('\n')
  const slots = new Map()
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^ {4}- id: (preset-[\w-]+)$/.exec(lines[index])
    if (match === null) continue
    const slotId = match[1]
    // 该行块内找 plugins:
    let pluginsAt = -1
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^ {4}- id: /.test(lines[cursor])) break
      if (lines[cursor] === `${PLUGINS_INDENT}plugins:`) {
        pluginsAt = cursor
        break
      }
    }
    if (pluginsAt === -1) continue
    const entries = splitEntries(lines, pluginsAt + 1, lines.length)
    if (entries.length === 0) continue
    const start = pluginsAt + 1
    const end = entries[entries.length - 1].end
    slots.set(slotId, { lines, start, end, entries })
  }
  return slots
}

/** 生成期望的插件条目文本（含条目之间的空行分隔）。 */
function expectedEntries(standardEntries, slot, ours) {
  const standardIds = new Set(standardEntries.map((entry) => entry.id))
  const own = new Map(ours.entries.map((entry) => [entry.id, entry]))

  const missing = CURATED.filter((id) => !standardIds.has(id))
  if (missing.length > 0) {
    fail(2, `${slot.slot}：standard 里找不到这些插件 id：${missing.join(', ')}\n` +
      '（新版 DSH 大概改名或删除了它们 —— 请改 scripts/gen-preset-tools.mjs 里的 CURATED 列表）')
  }
  for (const id of [...slot.append, ...slot.override]) {
    if (!own.has(id)) fail(2, `${slot.slot}：当前文件里找不到条目 ${id}（它应当是团队自己的，不该被覆盖）`)
  }
  const declared = new Set([...CURATED, ...slot.override, ...slot.append])
  for (const entry of ours.entries) {
    if (!declared.has(entry.id)) {
      fail(2, `${slot.slot}：条目 ${entry.id} 既不在 CURATED 里，也没声明为 override/append —— ` +
        '要就加进 CURATED，不要就删掉（手写的抄本会随 DSH 升级静默过期）')
    }
  }

  const byId = new Map(standardEntries.map((entry) => [entry.id, entry]))
  const out = []
  const push = (lines) => {
    if (out.length > 0) out.push('')
    out.push(...lines)
  }
  // override 里不在 CURATED 的条目（如 persona）排在最前面，用自己的正文
  for (const id of slot.override.filter((name) => !CURATED.includes(name))) {
    push(own.get(id).lines)
  }
  for (const id of CURATED) {
    push(slot.override.includes(id) ? own.get(id).lines : byId.get(id).lines)
  }
  for (const id of slot.append) push(own.get(id).lines)
  return out
}

function shortDiff(current, want, label) {
  const a = current.split('\n')
  const b = want.split('\n')
  // 掐掉公共前后缀再输出：否则一个 1 行的插入会把后面每一行都显示成"看起来一样的 -/+ 对"。
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1
  const removed = a.slice(head, a.length - tail).map((line) => `- ${line}`)
  const added = b.slice(head, b.length - tail).map((line) => `+ ${line}`)
  const shown = [...removed, ...added]
  if (shown.length > 40) shown.splice(40, shown.length - 40, '…（还有更多差异，未全列）')
  return `${label}（第 ${head + 1} 行起）\n${shown.join('\n')}`
}

const mode = process.argv.includes('--write') ? 'write' : process.argv.includes('--diff') ? 'diff' : 'check'
const standardEntries = splitEntries(
  readStandard().split('\r\n').join('\n').split('\n'),
  0,
  Number.MAX_SAFE_INTEGER,
)
if (standardEntries.length === 0) fail(2, 'standard preset 里没解析出任何插件条目 —— 抽取或缩进假设坏了')

const text = fs.readFileSync(PATCH, 'utf8')
// 仓库里的 YAML 是 CRLF（Windows 上 git 的默认行为），asar 里是 LF：
// 不归一化的话每一行都"看起来一样但不等"，diff 全是假差异。
const eol = text.includes('\r\n') ? '\r\n' : '\n'
const normalized = text.split('\r\n').join('\n')
const parsed = parsePatch(normalized)
if (parsed.size === 0) fail(2, `${PATCH} 里没找到 preset 插块`)

let drifted = false
const replacements = []
for (const slot of SLOTS) {
  const ours = parsed.get(slot.slot)
  if (ours === undefined) fail(2, `${PATCH} 里没有 ${slot.slot}（或它没有 plugins:）`)
  const want = expectedEntries(standardEntries, slot, ours).join('\n')
  const current = ours.entries.flatMap((entry, index) => (index === 0 ? entry.lines : ['', ...entry.lines])).join('\n')
  if (current === want) continue
  drifted = true
  if (mode !== 'write') process.stderr.write(`${shortDiff(current, want, `${slot.slot}：与 standard 不一致`)}\n\n`)
  replacements.push({ slot: slot.slot, start: ours.start, end: ours.end, lines: want.split('\n') })
}

if (mode === 'check') {
  if (drifted) fail(1, 'preset 工具清单与 standard 漂移了：跑 `node scripts/gen-preset-tools.mjs --write` 同步，再重新安装 bundle')
  process.stdout.write(`preset 工具清单与 standard 一致（standard ${standardEntries.length} 项，${SLOTS.length} 个 slot）\n`)
  process.exit(0)
}
if (mode === 'diff') {
  process.stdout.write(drifted ? '有漂移（未改文件）\n' : '没有漂移\n')
  process.exit(drifted ? 1 : 0)
}

const lines = normalized.split('\n')
for (const replacement of [...replacements].sort((a, b) => b.start - a.start)) {
  lines.splice(replacement.start, replacement.end - replacement.start, ...replacement.lines)
}
const out = lines.join('\n')
// 保留原来的 EOL 与末尾换行（git 的 core.autocrlf 依赖它）。
fs.writeFileSync(PATCH, (out.includes('\n') && text.endsWith('\n') ? `${out}\n` : out).split('\n').join(eol), 'utf8')
process.stdout.write(`已按 standard 重写 ${replacements.length} 个 slot：${replacements.map((item) => item.slot).join(', ') || '（无变化）'}\n`)
