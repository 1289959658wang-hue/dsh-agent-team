// Verify the P1b multicast run from the durable session logs.
//
// The preview plugin's own receipt scan had a matcher bug (it looked for
// [[MARKER]] while the envelope carried the bare marker). The delivery itself
// worked, so this script derives the authoritative delivery matrix from each
// recipient session's user messages and rewrites .p1b/report.json.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const root = process.cwd()
const sessionsDir = process.env.DSH_SESSIONS_DIR
  ?? path.join(os.homedir(), '.dsh', 'sessions', '--C-Work~0020Place-AgentWorkTeam--')
const stateFile = path.join(root, '.p1b', 'state.json')
const reportFile = path.join(root, '.p1b', 'report.json')

const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
const sessions = ['at-lead-1', 'at-w-01', 'at-w-02', 'at-w-03']
const markers = [...new Set(state.messages.map((message) => message.marker))]

function readLog(sessionId) {
  const file = path.join(sessionsDir, sessionId, 'session.v4.jsonl.zstd')
  const buffer = fs.readFileSync(file)
  const magic = [0x28, 0xb5, 0x2f, 0xfd]
  const starts = []
  for (let i = 0; i < buffer.length - 3; i += 1) {
    if (buffer[i] === magic[0] && buffer[i + 1] === magic[1] && buffer[i + 2] === magic[2] && buffer[i + 3] === magic[3]) starts.push(i)
  }
  let text = ''
  for (let index = 0; index < starts.length; index += 1) {
    const end = index + 1 < starts.length ? starts[index + 1] : buffer.length
    try { text += zlib.zstdDecompressSync(buffer.subarray(starts[index], end)).toString('utf8') } catch { /* skip torn frame */ }
  }
  return text
}

const checks = {}
let ok = true
for (const sessionId of sessions) {
  const text = readLog(sessionId)
  const userText = text.split('\n')
    .filter((line) => line.includes('"type":"user/message"'))
    .join('\n')
  const expected = state.messages.filter((message) => message.to.includes(sessionId)).map((message) => message.marker)
  const actual = markers.filter((marker) => userText.includes(marker))
  const pass = expected.length === actual.length && expected.every((marker) => actual.includes(marker))
  const extra = actual.filter((marker) => !expected.includes(marker))
  const missing = expected.filter((marker) => !actual.includes(marker))
  checks[sessionId] = { pass, expected, actual, extra, missing }
  if (!pass) ok = false
}

const report = {
  startedAt: state.messages[0]?.ts ?? null,
  finishedAt: new Date().toISOString(),
  ok,
  source: 'durable session logs (user/message)',
  sessionsDir,
  checks,
  messages: state.messages.map((message) => ({
    id: message.id,
    from: message.from,
    toExpr: message.toExpr,
    to: message.to,
    marker: message.marker,
    delivery: message.delivery,
  })),
  errors: [],
}
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8')
fs.writeFileSync(path.join(root, '.p1b', 'demo.done'), report.finishedAt, 'utf8')

for (const [sessionId, check] of Object.entries(checks)) {
  console.log(`${check.pass ? 'PASS' : 'FAIL'} ${sessionId} expected=[${check.expected.join(',')}] actual=[${check.actual.join(',')}]`)
}
console.log(ok ? 'P1B OK' : 'P1B FAILED')
process.exit(ok ? 0 : 1)
