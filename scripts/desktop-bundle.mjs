#!/usr/bin/env node
// 把 agent-team bundle 装进 / 卸出 desktop profile。
//
// 为什么要有这个脚本：P3 的六步里"改两行 + 建链接"手工做容易漏、也难回滚。
// 这里把三件事做成一条命令，并且**每次改动前先备份**（package.json + cordis.patch.yml + SHA256）。
//
// 用法：
//   node scripts/desktop-bundle.mjs status      # 只看当前状态
//   node scripts/desktop-bundle.mjs install     # 装（改 package.json + 建 junction）
//   node scripts/desktop-bundle.mjs uninstall   # 卸（删两行 + 删 junction）
//
// 装/卸之后都要跑：node scripts/guard-daily-profile.mjs（exit 0 才重启桌面端）。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const HOME = process.env.USERPROFILE ?? process.env.HOME
const PROFILE = path.join(HOME, '.dsh', 'profiles', 'desktop')
const MANIFEST = path.join(PROFILE, 'package.json')
const PATCH = path.join(PROFILE, 'cordis.patch.yml')
const NODE_MODULES = path.join(PROFILE, 'node_modules')
const NAME = 'dsh-agent-team'
const REPO = path.resolve(import.meta.dirname, '..')
const SOURCE = path.join(REPO, 'agent-team')
const DIAG = path.join(REPO, '.diag')

const readManifest = () => JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
const bundlesOf = (manifest) => manifest?.dsh?.profile?.bundles ?? []
const isLinked = () => {
  try {
    return fs.lstatSync(path.join(NODE_MODULES, NAME)).isSymbolicLink()
  } catch {
    return false
  }
}

function status() {
  const manifest = readManifest()
  const linked = isLinked()
  const inDeps = manifest.dependencies?.[NAME] !== undefined
  const inBundles = bundlesOf(manifest).includes(NAME)
  console.log(`profile: ${PROFILE}`)
  console.log(`dependencies: ${inDeps ? 'yes' : 'no'}`)
  console.log(`bundles:      ${inBundles ? 'yes' : 'no'}`)
  console.log(`node_modules: ${linked ? 'junction' : 'absent'}`)
  console.log(`installed:    ${inDeps && inBundles && linked ? 'YES' : 'NO'}`)
  return inDeps && inBundles && linked
}

function backup(label) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const dir = path.join(DIAG, `backup-desktop-${label}-${stamp}`)
  fs.mkdirSync(dir, { recursive: true })
  const lines = []
  for (const file of [MANIFEST, PATCH]) {
    const target = path.join(dir, path.basename(file))
    fs.copyFileSync(file, target)
    const body = fs.readFileSync(target)
    lines.push(`${crypto.createHash('sha256').update(body).digest('hex')}  ${path.basename(file)}  ${body.length}B`)
  }
  fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), lines.join('\n') + '\n', 'utf8')
  console.log(`backup: ${path.relative(REPO, dir)}`)
  return dir
}

function install() {
  backup('preinstall')
  const manifest = readManifest()
  manifest.dependencies ??= {}
  manifest.dependencies[NAME] = `link:${SOURCE}`
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  manifest.dsh.profile.bundles ??= []
  if (!manifest.dsh.profile.bundles.includes(NAME)) manifest.dsh.profile.bundles.push(NAME)
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  const link = path.join(NODE_MODULES, NAME)
  try {
    fs.rmSync(link, { recursive: true, force: true })
  } catch {}
  fs.symlinkSync(SOURCE, link, 'junction')
  console.log('installed; now run: node scripts/guard-daily-profile.mjs  (expect exit 0), then restart the desktop app')
}

function uninstall() {
  backup('preuninstall')
  const manifest = readManifest()
  if (manifest.dependencies) delete manifest.dependencies[NAME]
  const bundles = bundlesOf(manifest)
  if (manifest.dsh?.profile && Array.isArray(manifest.dsh.profile.bundles)) {
    manifest.dsh.profile.bundles = bundles.filter((name) => name !== NAME)
  }
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  const link = path.join(NODE_MODULES, NAME)
  try {
    fs.rmSync(link, { recursive: true, force: true })
  } catch {}
  console.log('uninstalled; now run: node scripts/guard-daily-profile.mjs  (expect exit 0), then restart the desktop app')
}

const command = process.argv[2] ?? 'status'
if (command === 'status') status()
else if (command === 'install') install()
else if (command === 'uninstall') uninstall()
else {
  console.error('usage: node scripts/desktop-bundle.mjs [status|install|uninstall]')
  process.exit(2)
}
