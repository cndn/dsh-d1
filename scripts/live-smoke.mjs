// Live smoke test against a real D1 database with a READ-ONLY token.
// Prints counts and pass/fail only: no table names, rows, ids or tokens.
//
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... SMOKE_DB_ID=<uuid> npm run smoke
//
// Requires `npm run build` first (imports the compiled lib/).
import { apply } from '../lib/index.js'

const DB_ID = process.env.SMOKE_DB_ID
if (!DB_ID) {
  console.error('SMOKE_DB_ID (a D1 database uuid) is required; CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set too.')
  process.exit(2)
}

function boot(config) {
  const registered = new Map()
  let gate = null
  const ctx = {
    tools: { register(def) { registered.set(def.name, def); return () => {} } },
    on(event, listener) { if (event === 'tools/pre-execute') gate = listener },
  }
  apply(ctx, { databases: [{ name: 'smoke', databaseId: DB_ID }], maxRows: 20, ...config })
  return { tool: (name) => registered.get(name), gate }
}

const { tool, gate } = boot({ readOnly: true, writeApproval: true })
const exec = () => ({ signal: new AbortController().signal })
const redact = (s) => String(s).replace(/[0-9a-f]{32}/g, '<account>').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<database>')

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) pass += 1
  else fail += 1
  console.log((cond ? '  ok   ' : '  FAIL ') + label + (extra ? ' — ' + extra : ''))
}

console.log('registration')
ok(['d1_list', 'd1_query', 'd1_exec', 'd1_schema', 'd1_stats', 'd1_health'].every((n) => tool(n)), 'six d1_* tools registered')
ok(typeof gate === 'function', 'pre-execute gate installed')

console.log('\nlive D1 (read-only token; counts only)')
try {
  const health = await tool('d1_health').execute({}, exec())
  ok(health.ok === true, 'd1_health', 'readOnly=' + health.readOnly)
  const schema = await tool('d1_schema').execute({}, exec())
  ok(Array.isArray(schema.tables), 'd1_schema lists tables', schema.tables.length + ' tables')
  if (schema.tables[0]) {
    const cols = await tool('d1_schema').execute({ table: schema.tables[0] }, exec())
    ok(cols.columns.length > 0, 'd1_schema describes the first table', cols.columns.length + ' columns')
  }
  const q = await tool('d1_query').execute({ sql: 'SELECT type, COUNT(*) AS n FROM sqlite_master GROUP BY type' }, exec())
  ok(q.rowCount >= 0 && q.truncated === false, 'd1_query (LIMIT-wrapped)', q.rowCount + ' rows')
  const empty = await tool('d1_query').execute({ sql: 'SELECT name, type FROM sqlite_master WHERE 1 = 0' }, exec())
  ok(empty.columns.length === 2 && empty.rowCount === 0, 'empty result keeps column headers')
  const p = await tool('d1_query').execute({ sql: 'SELECT ? AS answer', params: [42] }, exec())
  ok(p.rows?.[0]?.[0] === 42, 'bound params round-trip')
  const started = Date.now()
  const stats = await tool('d1_stats').execute({}, exec())
  const errors = stats.tables.filter((t) => t.error).length
  ok(stats.tableCount >= 0 && errors === 0, 'd1_stats batched counts + size', stats.tableCount + ' tables, ' + Math.round(stats.sizeBytes / 1048576) + ' MB, ' + (Date.now() - started) + ' ms')
} catch (err) {
  fail += 1
  console.log('  FAIL live call threw: ' + redact(err.message))
}

console.log('\nread-only posture (no network)')
for (const [sql, re, label] of [
  ['DELETE FROM t', /read-only/, 'd1_query rejects a write'],
  ['SELECT 1; DROP TABLE t', /single statement/, 'd1_query rejects multi-statement input'],
  ["SELECT '\\'; DROP TABLE t; --'", /single statement/, 'd1_query rejects the backslash desync payload'],
  ['SELECT * FROM t) /*', /unterminated|unbalanced/, 'd1_query rejects an unbalanced statement'],
]) {
  try {
    await tool('d1_query').execute({ sql }, exec())
    ok(false, label)
  } catch (err) {
    ok(re.test(err.message), label)
  }
}
try {
  await tool('d1_exec').execute({ sql: 'DELETE FROM t' }, exec())
  ok(false, 'd1_exec refused under readOnly')
} catch (err) {
  ok(/readOnly/.test(err.message), 'd1_exec refused under readOnly')
}
const denied = await gate({ name: 'd1_exec', arguments: { sql: 'DELETE FROM t' } }, async () => ({ kind: 'allow' }))
ok(denied.kind === 'deny', 'gate denies d1_exec under readOnly')
const rw = boot({ readOnly: false, writeApproval: true })
const asked = await rw.gate({ name: 'd1_exec', arguments: { sql: 'DELETE FROM t WHERE id = 1' } }, async () => ({ kind: 'allow' }))
ok(asked.kind === 'ask' && /DELETE FROM t WHERE id = 1/.test(asked.reason), 'gate asks with a SQL preview when writes are enabled')

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
