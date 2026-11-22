#!/usr/bin/env node
// 里程碑整目录快照（`docs/git-workflow.md` §6 / §8：git 管"改了什么"，快照防误删与盘坏）。
//
// 做什么：
//   1. 把 **git 跟踪的文件**（`git ls-files`）逐个拷到 `.diag/snapshot-<label>-<stamp>/`；
//   2. 每个文件拷完**回读算 sha256**，与源文件比对 —— 不一致就整次失败（exit 1）；
//   3. 生成 `MANIFEST.md`（清单**生成**，不手写：谁在什么时候、从哪个 commit、拷了哪些文件、各自多大多少字节哈希）；
//   4. 报出**比这次更旧**的快照目录（"过期的副本"）—— 一份过期的备份比没有更坏；
//   5. 退出码即结论：0 = 全部拷贝并校验通过；1 = 有失败（哪一条打在哪一行）。
//
// 为什么只拷跟踪文件：`.team/`（团队运行期数据）、`.p2-sandbox/`（验收沙箱）、`dist/`（打包产物）、
//   `.diag/`（历史现场）都不是"源"，混进来只会让快照变成一坨不可读的东西。
//
// 用法：
//   node scripts/snapshot.mjs v1.9.0          # → .diag/snapshot-v1.9.0-20261121-163000/
//   node scripts/snapshot.mjs v1.9.0 --dry    # 只看会拷哪些文件、有没有过期快照
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '..')
const DIAG = path.join(REPO, '.diag')
const label = (process.argv[2] ?? 'snapshot').replace(/[^\w.-]/g, '-')
const dryRun = process.argv.includes('--dry')

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const stamp = () => {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}
const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim()

// ---- 1. 源清单：只有 git 跟踪的文件（-z 防中文/空格路径） ----
const files = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' })
  .split('\0')
  .filter((name) => name !== '')
  .sort()
if (files.length === 0) {
  console.error('没有任何 git 跟踪文件 —— 是不是在错误的目录里跑？')
  process.exit(1)
}
const head = git('rev-parse', '--short', 'HEAD')
const dirty = git('status', '--porcelain')

// ---- 2. 旧快照：比这次更旧的就是"过期副本"，要报出来 ----
const existing = fs.existsSync(DIAG)
  ? fs.readdirSync(DIAG, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith('snapshot-'))
  : []
const stale = existing
  .map((entry) => ({ name: entry.name, at: fs.statSync(path.join(DIAG, entry.name)).mtimeMs }))
  .sort((left, right) => left.at - right.at)

if (dryRun) {
  console.log(`会拷贝 ${files.length} 个跟踪文件（HEAD ${head}${dirty === '' ? '' : '，**工作区不干净**'}）`)
  for (const group of ['.team/', '.p2-sandbox/', 'dist/']) {
    console.log(`  跳过 ${group}（运行期数据/沙箱/产物）`)
  }
  if (stale.length > 0) console.log(`已有快照 ${stale.length} 份（最旧 ${stale[0].name}）；按存储纪律只留最新 1 份`)
  else console.log('还没有任何快照')
  process.exit(0)
}

// ---- 3. 拷贝 + 回读校验 ----
const target = path.join(DIAG, `snapshot-${label}-${stamp()}`)
fs.mkdirSync(target, { recursive: true })
const rows = []
const failures = []
for (const name of files) {
  const source = path.join(REPO, name)
  const copy = path.join(target, name)
  fs.mkdirSync(path.dirname(copy), { recursive: true })
  try {
    fs.copyFileSync(source, copy)
    const before = sha256(source)
    const after = sha256(copy)
    const bytes = fs.statSync(copy).size
    if (before !== after) {
      failures.push(`${name}: 哈希不一致（源 ${before.slice(0, 12)} / 副本 ${after.slice(0, 12)}）`)
      continue
    }
    rows.push({ name, bytes, hash: before })
  } catch (error) {
    failures.push(`${name}: ${String(error && error.message ? error.message : error)}`)
  }
}

// ---- 4. 生成清单（不手写） ----
const totalBytes = rows.reduce((sum, row) => sum + row.bytes, 0)
const manifest = [
  `# 快照清单：${path.basename(target)}`,
  '',
  `- 生成时间：${new Date().toISOString()}`,
  `- 源：\`${REPO}\` · HEAD \`${head}\`${dirty === '' ? '（工作区干净）' : '（**工作区当时不干净**）'}`,
  `- 文件数：${rows.length} / 应拷 ${files.length} · 合计 ${totalBytes} 字节`,
  `- 校验方式：逐个文件拷完回读 sha256，与源文件比对（不一致即失败）`,
  `- 跳过：\`.team/\`、\`.p2-sandbox/\`、\`dist/\`、\`.diag/\`、\`node_modules/\`（运行期数据/沙箱/产物/历史现场）`,
  '',
  '| 文件 | 字节 | sha256 |',
  '|---|---|---|',
  ...rows.map((row) => `| \`${row.name}\` | ${row.bytes} | \`${row.hash}\` |`),
  '',
]
if (dirty !== '') {
  manifest.push('## 工作区当时不干净（未提交的改动不在快照里）', '', '```', dirty, '```', '')
}
if (stale.length > 0) {
  manifest.push('## 更旧的快照（过期副本）', '', ...stale.map((entry) => `- \`${entry.name}\``), '')
}
fs.writeFileSync(path.join(target, 'MANIFEST.md'), manifest.join('\n'), 'utf8')

// ---- 5. 结论 ----
console.log(`快照：${target}`)
console.log(`文件：${rows.length}/${files.length} · 字节：${totalBytes} · HEAD ${head}${dirty === '' ? '' : '（工作区不干净）'}`)
if (stale.length > 0) {
  console.log(`更旧的快照 ${stale.length} 份（过期副本，按纪律只留最新一份）：`)
  for (const entry of stale) console.log(`  - ${entry.name}`)
}
if (failures.length > 0) {
  console.error(`校验失败 ${failures.length} 条：`)
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exit(1)
}
console.log('校验：全部文件 sha256 回读一致 → PASS')
