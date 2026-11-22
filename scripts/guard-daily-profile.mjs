#!/usr/bin/env node
// guard-daily-profile.mjs — stop a test plugin from breaking the daily DSH profile.
//
// Two incident-shaped checks (2026-11-20: a `*-spike` bundle shipped in the
// desktop profile registered an `agent/pre-step` listener whose pass-through was
// a bare `return`; that voided the waterfall decision and every turn in every
// session died with `Cannot read properties of undefined (reading 'kind')`).
//
//   A. activation: a spike/test plugin, or a `link:` into this workspace, listed
//      in a profile's `dsh.profile.bundles` (that is what makes it run at launch)
//   B. listener shape: a waterfall listener (`agent/pre-step`,
//      `system-prompt/assemble`) that has no `next` parameter and returns
//      without a value — it cannot pass through, so it voids the decision
//
// Exit codes: 0 = pass (WARNs allowed), 1 = at least one ERROR, 2 = usage error.
//
// Usage:
//   node scripts/guard-daily-profile.mjs                 # every profile under ~/.dsh
//   node scripts/guard-daily-profile.mjs --profile desktop
//   node scripts/guard-daily-profile.mjs --scan spike-p1c2 --scan .diag/backup-x
//   node scripts/guard-daily-profile.mjs --json
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const WATERFALL_EVENTS = ['agent/pre-step', 'system-prompt/assemble']
const TEST_NAME = /-(spike|test)$/
const WARN_NAME = /-preview$/
const WORKSPACE_HINTS = [path.resolve(process.cwd()), path.resolve(import.meta.dirname, '..')]
const HOOK_WINDOW = 1400

const argv = process.argv.slice(2)
const flags = { json: false, profile: null, scans: [] }
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  if (arg === '--json') flags.json = true
  else if (arg === '--profile') flags.profile = argv[++i]
  else if (arg === '--scan') flags.scans.push(argv[++i])
  else if (arg === '--help' || arg === '-h') {
    console.log('node scripts/guard-daily-profile.mjs [--profile <name>] [--scan <dir>]... [--json]')
    process.exit(0)
  } else {
    console.error('unknown argument: ' + arg)
    process.exit(2)
  }
}
if (flags.profile !== null && flags.profile === undefined) {
  console.error('--profile needs a value')
  process.exit(2)
}
if (flags.scans.some((dir) => dir === undefined)) {
  console.error('--scan needs a directory')
  process.exit(2)
}

const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const findings = []
const record = (level, check, subject, detail) => findings.push({ level, check, subject, detail })

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/** Whether a dependency spec is a `link:`/`file:` pointing inside this workspace. */
function isWorkspaceLink(spec) {
  if (!spec.startsWith('link:') && !spec.startsWith('file:')) return false
  const target = path.resolve(spec.replace(/^(link|file):/, '')).toLowerCase().replaceAll('\\', '/')
  return WORKSPACE_HINTS.some((root) => {
    const base = path.resolve(root).toLowerCase().replaceAll('\\', '/')
    return target === base || target.startsWith(base + '/')
  })
}

// ---------------------------------------------------------------- check A
function profilesToInspect() {
  if (flags.profile) {
    const dir = path.join(dshHome, 'profiles', flags.profile)
    return fs.existsSync(dir) ? [dir] : []
  }
  const root = path.join(dshHome, 'profiles')
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
}

function checkActivation(profileDir) {
  const manifest = readJson(path.join(profileDir, 'package.json'))
  if (manifest === null) return
  const name = path.basename(profileDir)
  const bundles = manifest?.dsh?.profile?.bundles ?? []
  const deps = manifest?.dependencies ?? {}
  for (const bundle of bundles) {
    const spec = String(deps[bundle] ?? '')
    const linked = isWorkspaceLink(spec)
    if (TEST_NAME.test(bundle)) {
      record('ERROR', 'A.activation', `${name}:${bundle}`, 'a *-spike/-test package is in dsh.profile.bundles — it runs on every app launch')
    } else if (linked || WARN_NAME.test(bundle)) {
      record('WARN', 'A.activation', `${name}:${bundle}`, 'a preview/workspace-linked package is active in this daily profile; confirm that is intended')
    }
  }
  // Sleeping (installed, not activated) test plugins are acceptable but worth naming.
  for (const dep of Object.keys(deps)) {
    if (!TEST_NAME.test(dep) || bundles.includes(dep)) continue
    record('INFO', 'A.activation', `${name}:${dep}`, 'installed but not in bundles — dormant, no launch-time effect')
  }
}

// ---------------------------------------------------------------- check B
function jsFilesUnder(dir, depth = 0, out = []) {
  if (depth > 3) return out
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === 'backup' || entry.name === 'dist') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) jsFilesUnder(full, depth + 1, out)
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) out.push(full)
  }
  return out
}

function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1
  return line
}

// Parse the callback that follows `.on('<event>', ` and report its `next` usage.
function inspectListener(text, at) {
  const window = text.slice(at, at + HOOK_WINDOW)
  const arrow = /^\s*(?:async\s+)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*=>/.exec(window)
  const fn = /^\s*(?:async\s+)?function\s*[^(]*\(([^)]*)\)/.exec(window)
  const params = arrow ? (arrow[1] ?? arrow[2] ?? '') : (fn ? fn[1] : null)
  if (params === null) return { known: false }
  const names = params.split(',').map((part) => part.trim().replace(/=.*$/, '').trim()).filter(Boolean)
  const nextName = names.find((name) => name === 'next' || name === 'proceed' || name === 'continue_')
  const bodyStart = arrow ? arrow[0].length : fn[0].length
  const body = window.slice(bodyStart, bodyStart + 900)
  const callsNext = nextName !== undefined && new RegExp(`\\b${nextName}\\s*\\(`).test(body)
  // A value-less `return` is the fatal shape: it voids the decision.
  const bareReturn = /return\s*(?:;|\}|$)/m.test(body) || /return\s*\n\s*\}/m.test(body)
  return { known: true, names, nextName, callsNext, bareReturn }
}

function checkListeners(label, dir) {
  for (const file of jsFilesUnder(dir)) {
    let text
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    for (const event of WATERFALL_EVENTS) {
      const pattern = new RegExp(`\.on\\(\\s*['"]${event.replace('/', '\\/')}['"]\\s*,`, 'g')
      let match
      while ((match = pattern.exec(text)) !== null) {
        const info = inspectListener(text, match.index + match[0].length)
        const where = `${path.relative(process.cwd(), file).replaceAll('\\', '/')}:${lineOf(text, match.index)}`
        if (!info.known) {
          record('WARN', 'B.listener', `${label}:${where}`, `${event} listener could not be parsed — review it by hand`)
          continue
        }
        if (info.nextName === undefined) {
          if (info.bareReturn) {
            record('ERROR', 'B.listener', `${label}:${where}`, `${event} listener has no \`next\` parameter and returns without a value — it voids the decision (every turn fails)`)
          } else {
            record('WARN', 'B.listener', `${label}:${where}`, `${event} listener never takes \`next\`, so it can never pass through — confirm it always returns a decision`)
          }
        } else if (!info.callsNext) {
          record('WARN', 'B.listener', `${label}:${where}`, `${event} listener declares \`${info.nextName}\` but never calls it — fine only if it always decides itself`)
        }
      }
    }
  }
}

function bundleDirs(profileDir) {
  const manifest = readJson(path.join(profileDir, 'package.json'))
  const bundles = manifest?.dsh?.profile?.bundles ?? []
  const modules = path.join(profileDir, 'node_modules')
  return bundles
    .filter((bundle) => !bundle.startsWith('@deepseek-ai/'))
    .map((bundle) => path.join(modules, bundle))
    .filter((dir) => fs.existsSync(dir))
}

// ---------------------------------------------------------------- run
if (flags.scans.length > 0) {
  for (const dir of flags.scans) {
    const abs = path.resolve(dir)
    if (!fs.existsSync(abs)) {
      console.error('no such directory: ' + dir)
      process.exit(2)
    }
    checkListeners(path.basename(abs), abs)
  }
} else {
  const profiles = profilesToInspect()
  if (profiles.length === 0) {
    console.error('no profiles found under ' + path.join(dshHome, 'profiles'))
    process.exit(2)
  }
  for (const profileDir of profiles) {
    checkActivation(profileDir)
    for (const dir of bundleDirs(profileDir)) checkListeners(path.basename(profileDir), dir)
  }
}

const errors = findings.filter((item) => item.level === 'ERROR')
const warns = findings.filter((item) => item.level === 'WARN')
const infos = findings.filter((item) => item.level === 'INFO')

if (flags.json) {
  console.log(JSON.stringify({ ok: errors.length === 0, errors, warns, infos }, null, 2))
} else {
  const rows = [...errors, ...warns, ...infos]
  for (const item of rows) console.log(`${item.level.padEnd(5)} ${item.check.padEnd(12)} ${item.subject}\n      ${item.detail}`)
  console.log(`\n${errors.length} error(s), ${warns.length} warning(s), ${infos.length} info`)
  console.log(errors.length === 0 ? 'PASS — daily profiles are clear' : 'FAIL — fix the errors above before launching')
}
process.exit(errors.length === 0 ? 0 : 1)
