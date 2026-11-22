// Proof-of-mechanism: a waterfall listener (like an `agent/pre-step` hook) that
// returns `undefined` without calling `next()` swallows the decision, and the
// agent loop then throws `Cannot read properties of undefined (reading 'kind')`.
//
// Expected output:
//   not latched -> undefined
//   CRASH: TypeError: Cannot read properties of undefined (reading 'kind')
//   latched     -> { kind: 'reject' }
//   fixed       -> { kind: 'enter', messages: [ 'claimed' ] }
//
// Use it as a template: swap the listener body for a candidate plugin's hook.
// It loads the real cordis from a local DSH install; point `DSH_CORDIS` at
// `.../node_modules/@deepseek-ai/cordis/lib/index.js` if auto-detection fails.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

function findCordis() {
  const candidates = []
  if (process.env.DSH_CORDIS) candidates.push(process.env.DSH_CORDIS)
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'))
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    candidates.push(path.join(root, '@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'))
  } catch { /* npm not on PATH */ }
  for (const candidate of candidates) if (candidate && fs.existsSync(candidate)) return candidate
  throw new Error('cordis not found; set DSH_CORDIS to .../@deepseek-ai/cordis/lib/index.js')
}

const cordisPath = findCordis()
const { Context } = await import('file://' + cordisPath.replaceAll('\\', '/'))
console.log('cordis:', cordisPath)

const ctx = new Context()

// Same shape as the pre-fix spike: the "not latched" branch just returns.
ctx.on('agent/pre-step', (payload) => {
  if (!payload.latched) return          // ← pass-through written as a bare return
  return { kind: 'reject' }
})

const fallback = () => Promise.resolve({ kind: 'enter', messages: ['claimed'] })

const notLatched = await ctx.waterfall('agent/pre-step', { latched: false }, fallback)
console.log('not latched ->', notLatched)
try {
  // This is agent-loop's `if (decision.kind === "reject")`.
  if (notLatched.kind === 'reject') console.log('rejected')
} catch (error) {
  console.log('CRASH:', error.constructor.name + ': ' + error.message)
}

console.log('latched     ->', await ctx.waterfall('agent/pre-step', { latched: true }, fallback))

// Fixed listener: pass-through calls next().
const ctx2 = new Context()
ctx2.on('agent/pre-step', (payload, next) => {
  if (!payload.latched) return next()
  return { kind: 'reject' }
})
console.log('fixed       ->', await ctx2.waterfall('agent/pre-step', { latched: false }, fallback))
