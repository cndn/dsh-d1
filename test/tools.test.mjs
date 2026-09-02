import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildD1Tools, toCsv, withRowCap } from '../lib/tools.js'
import { resolveConfig } from '../lib/config.js'

const ACCOUNT = 'b'.repeat(32)
const ENV = { CLOUDFLARE_API_TOKEN: 'test-token', CLOUDFLARE_ACCOUNT_ID: ACCOUNT }
const DB_ID = '00000000-0000-0000-0000-000000000000'

function cfg(overrides = {}) {
  return resolveConfig({ databases: [{ name: 'prod', databaseId: DB_ID }], ...overrides }, ENV)
}

/**
 * Route fetch by the SQL in the request body. The handler returns
 * { rows: [rowObject...], columns?, meta?, error? }; rows are converted to the
 * D1 /raw shape ({ columns, rows: [[...]] }).
 */
function routeFetch(handler) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ ...body, signal: init.signal })
    const out = handler(body.sql, body.params)
    if (out.error) {
      return new Response(JSON.stringify({ success: false, result: [], errors: [{ message: out.error }] }), { status: 200 })
    }
    const objects = out.rows ?? []
    const columns = out.columns ?? (objects.length > 0 ? Object.keys(objects[0]) : [])
    const rows = objects.map((o) => columns.map((c) => o[c]))
    return new Response(JSON.stringify({ success: true, result: [{ results: { columns, rows }, success: true, meta: out.meta ?? {} }], errors: [] }), { status: 200 })
  }
  return { calls, restore: () => (globalThis.fetch = original) }
}

function findTool(tools, n) {
  const tool = tools.find((t) => t.name === n)
  assert.ok(tool, 'missing tool ' + n)
  return tool
}

test('builds the six tools with timeouts and concurrency classifiers', () => {
  const { tools } = buildD1Tools(cfg(), ENV)
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ['d1_exec', 'd1_health', 'd1_list', 'd1_query', 'd1_schema', 'd1_stats'],
  )
  assert.equal(findTool(tools, 'd1_query').timeoutMs, 60000)
  assert.equal(findTool(tools, 'd1_exec').timeoutMs, 120000)
  for (const name of ['d1_list', 'd1_query', 'd1_schema', 'd1_stats', 'd1_health']) {
    assert.equal(findTool(tools, name).isConcurrencySafe({}), true, name + ' is concurrency-safe')
  }
  assert.equal(findTool(tools, 'd1_exec').isConcurrencySafe, undefined, 'd1_exec stays exclusive')
})

test('no databases configured → tools throw a helpful error at execute time (with the config error, if any)', async () => {
  const { tools } = buildD1Tools(resolveConfig(null, {}), {}, 'maxRows must be a positive integer.')
  await assert.rejects(() => findTool(tools, 'd1_query').execute({ sql: 'SELECT 1' }), /no D1 databases are configured.*maxRows must be a positive integer/)
})

test('d1_query wraps SELECTs in a LIMIT cap and reports truncation', async () => {
  const stub = routeFetch(() => ({ rows: [{ id: 1 }, { id: 2 }, { id: 3 }] }))
  try {
    const { tools } = buildD1Tools(cfg({ maxRows: 2 }), ENV)
    const out = await findTool(tools, 'd1_query').execute({ sql: 'SELECT id FROM t -- trailing comment' })
    assert.equal(stub.calls[0].sql, 'SELECT * FROM (\nSELECT id FROM t -- trailing comment\n) LIMIT 3')
    assert.equal(out.rowCount, 2)
    assert.equal(out.rows.length, 2)
    assert.equal(out.truncated, true)
    assert.equal(out.database, 'prod')
    assert.deepEqual(out.columns, ['id'])
  } finally {
    stub.restore()
  }
})

test('d1_query does not wrap PRAGMA or EXPLAIN', async () => {
  const stub = routeFetch(() => ({ rows: [{ x: 1 }] }))
  try {
    const { tools } = buildD1Tools(cfg(), ENV)
    await findTool(tools, 'd1_query').execute({ sql: 'PRAGMA table_info(t)' })
    await findTool(tools, 'd1_query').execute({ sql: 'EXPLAIN QUERY PLAN SELECT 1;' })
    assert.equal(stub.calls[0].sql, 'PRAGMA table_info(t)')
    assert.equal(stub.calls[1].sql, 'EXPLAIN QUERY PLAN SELECT 1')
  } finally {
    stub.restore()
  }
})

test('d1_query csv and json formats', async () => {
  const stub = routeFetch(() => ({ rows: [{ id: 1, name: 'ada' }] }))
  try {
    const { tools } = buildD1Tools(cfg(), ENV)
    const csv = await findTool(tools, 'd1_query').execute({ sql: 'SELECT id, name FROM t', format: 'csv' })
    assert.equal(csv.format, 'csv')
    assert.equal(csv.formatted, 'id,name\n1,ada')
    const json = await findTool(tools, 'd1_query').execute({ sql: 'SELECT id, name FROM t', format: 'json' })
    assert.deepEqual(JSON.parse(json.formatted), [{ id: 1, name: 'ada' }])
  } finally {
    stub.restore()
  }
})

test('d1_query forwards bound params and the exec signal', async () => {
  const stub = routeFetch(() => ({ rows: [] }))
  try {
    const { tools } = buildD1Tools(cfg(), ENV)
    const controller = new AbortController()
    await findTool(tools, 'd1_query').execute({ sql: 'SELECT * FROM t WHERE id = ?', params: [7] }, { signal: controller.signal })
    assert.deepEqual(stub.calls[0].params, [7])
    assert.ok(stub.calls[0].signal instanceof AbortSignal)
    controller.abort()
    assert.equal(stub.calls[0].signal.aborted, true, 'the fetch signal follows the exec signal')
  } finally {
    stub.restore()
  }
})

test('d1_query rejects a write before any request', async () => {
  const stub = routeFetch(() => ({ rows: [] }))
  try {
    const { tools } = buildD1Tools(cfg(), ENV)
    await assert.rejects(() => findTool(tools, 'd1_query').execute({ sql: 'DELETE FROM t' }), /read-only/)
    await assert.rejects(() => findTool(tools, 'd1_query').execute({ sql: "SELECT '\\'; DROP TABLE t; --'" }), /single statement/)
    assert.equal(stub.calls.length, 0)
  } finally {
    stub.restore()
  }
})

test('d1_query requires a non-empty sql string', async () => {
  const { tools } = buildD1Tools(cfg(), ENV)
  await assert.rejects(() => findTool(tools, 'd1_query').execute({}), /required/)
})

test('d1_exec is blocked under readOnly (the default)', async () => {
  const stub = routeFetch(() => ({ rows: [], meta: { changes: 1 } }))
  try {
    const { tools } = buildD1Tools(cfg(), ENV) // readOnly defaults true
    await assert.rejects(() => findTool(tools, 'd1_exec').execute({ sql: 'DELETE FROM t' }), /readOnly/)
    assert.equal(stub.calls.length, 0)
  } finally {
    stub.restore()
  }
})

test('d1_exec runs when readOnly is off, reports changes and forwards the signal', async () => {
  const stub = routeFetch(() => ({ rows: [], meta: { changes: 4 } }))
  try {
    const { tools } = buildD1Tools(cfg({ readOnly: false }), ENV)
    const out = await findTool(tools, 'd1_exec').execute({ sql: 'DELETE FROM t WHERE id = ?', params: [1] }, { signal: new AbortController().signal })
    assert.equal(out.changes, 4)
    assert.equal(out.readOnly, false)
    assert.deepEqual(stub.calls[0].params, [1])
    assert.ok(stub.calls[0].signal instanceof AbortSignal)
  } finally {
    stub.restore()
  }
})

test('d1_schema lists tables, describes a table, and errors on an unknown table', async () => {
  const stub = routeFetch((sql) => {
    if (sql.includes('sqlite_master')) return { rows: [{ name: 'users' }, { name: 'posts' }] }
    if (sql.includes('table_info("users")')) return { rows: [{ cid: 0, name: 'id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 1 }] }
    if (sql.includes('table_info')) return { columns: ['cid', 'name', 'type', 'notnull', 'dflt_value', 'pk'], rows: [] }
    return { rows: [] }
  })
  try {
    const { tools } = buildD1Tools(cfg(), ENV)
    const list = await findTool(tools, 'd1_schema').execute({})
    assert.deepEqual(list.tables, ['users', 'posts'])
    const desc = await findTool(tools, 'd1_schema').execute({ table: 'users' })
    assert.equal(desc.table, 'users')
    assert.deepEqual(desc.columns, [{ name: 'id', type: 'INTEGER', notNull: true, primaryKey: true }])
    await assert.rejects(() => findTool(tools, 'd1_schema').execute({ table: 'ghost' }), /no such table: ghost/)
    const blocks = findTool(tools, 'd1_schema').output.render({}, desc)
    assert.match(blocks[0].text, /columns of users/)
  } finally {
    stub.restore()
  }
})

test('d1_stats counts rows in one batched round trip', async () => {
  const stub = routeFetch((sql) => {
    if (sql.includes('sqlite_master')) return { rows: [{ name: 'users' }, { name: 'posts' }] }
    if (sql.trim() === 'SELECT 1') return { rows: [{ 1: 1 }], meta: { size_after: 40960 } }
    if (sql.includes('UNION ALL')) return { rows: [{ name: 'users', n: 42 }, { name: 'posts', n: 7 }] }
    return { rows: [] }
  })
  try {
    const { tools } = buildD1Tools(cfg(), ENV)
    const out = await findTool(tools, 'd1_stats').execute({})
    assert.equal(out.tableCount, 2)
    assert.deepEqual(out.tables, [
      { name: 'users', rowCount: 42 },
      { name: 'posts', rowCount: 7 },
    ])
    assert.equal(out.sizeBytes, 40960)
    const batched = stub.calls.filter((c) => c.sql.includes('COUNT(*)'))
    assert.equal(batched.length, 1, 'one COUNT request for two tables')
    assert.equal(batched[0].sql, `SELECT 'users' AS name, COUNT(*) AS n FROM "users" UNION ALL SELECT 'posts' AS name, COUNT(*) AS n FROM "posts"`)
  } finally {
    stub.restore()
  }
})

test('d1_stats falls back to per-table counts when a batch fails, isolating the bad table', async () => {
  const stub = routeFetch((sql) => {
    if (sql.includes('sqlite_master')) return { rows: [{ name: 'ok' }, { name: 'broken' }] }
    if (sql.trim() === 'SELECT 1') return { rows: [{ 1: 1 }] }
    if (sql.includes('UNION ALL')) return { error: 'no such table: broken' }
    if (sql.includes('"ok"')) return { rows: [{ n: 3 }] }
    return { error: 'no such table: broken' }
  })
  try {
    const { tools } = buildD1Tools(cfg(), ENV)
    const out = await findTool(tools, 'd1_stats').execute({})
    assert.deepEqual(out.tables[0], { name: 'ok', rowCount: 3 })
    assert.equal(out.tables[1].name, 'broken')
    assert.match(out.tables[1].error, /no such table/)
    assert.equal(out.sizeBytes, -1)
  } finally {
    stub.restore()
  }
})

test('d1_stats stops issuing requests once the exec signal is aborted and settles quietly (runtime reports ABORTED)', async () => {
  const controller = new AbortController()
  const stub = routeFetch((sql) => {
    if (sql.includes('sqlite_master')) {
      controller.abort() // cancel right after the table list arrives
      return { rows: [{ name: 'a' }, { name: 'b' }] }
    }
    return { rows: [{ 1: 1 }] }
  })
  try {
    const { tools } = buildD1Tools(cfg(), ENV)
    const out = await findTool(tools, 'd1_stats').execute({}, { signal: controller.signal })
    assert.deepEqual(out, { database: 'prod', tableCount: 0, tables: [], sizeBytes: -1 })
    assert.equal(stub.calls.filter((c) => c.sql.includes('COUNT')).length, 0, 'no COUNT requests after abort')
  } finally {
    stub.restore()
  }
})

test('a cancelled d1_query settles with an empty value instead of throwing; other errors still throw', async () => {
  const controller = new AbortController()
  const stub = routeFetch(() => {
    controller.abort()
    return { error: 'simulated failure after abort' }
  })
  try {
    const { tools } = buildD1Tools(cfg(), ENV)
    const out = await findTool(tools, 'd1_query').execute({ sql: 'SELECT 1' }, { signal: controller.signal })
    assert.equal(out.rowCount, 0)
    assert.equal(out.database, 'prod')
  } finally {
    stub.restore()
  }
  const failing = routeFetch(() => ({ error: 'no such table: t' }))
  try {
    const { tools } = buildD1Tools(cfg(), ENV)
    await assert.rejects(() => findTool(tools, 'd1_query').execute({ sql: 'SELECT * FROM t' }, { signal: new AbortController().signal }), /no such table: t/)
  } finally {
    failing.restore()
  }
})

test('d1_list and d1_health probe each database', async () => {
  const stub = routeFetch(() => ({ rows: [{ 1: 1 }] }))
  try {
    const { tools } = buildD1Tools(cfg(), ENV)
    const list = await findTool(tools, 'd1_list').execute({})
    assert.equal(list.databases.length, 1)
    assert.equal(list.databases[0].ok, true)
    const health = await findTool(tools, 'd1_health').execute({})
    assert.equal(health.ok, true)
    assert.equal(health.readOnly, true)
    assert.equal(health.plugin, 'dsh-d1')
    assert.equal(health.configError, undefined)
  } finally {
    stub.restore()
  }
})

test('d1_health reports unhealthy when a probe fails, and surfaces a config error', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ success: false, result: [], errors: [{ message: 'bad token' }] }), { status: 200 })
  try {
    const { tools } = buildD1Tools(cfg(), ENV, 'databases: every entry needs a non-empty "name".')
    const health = await findTool(tools, 'd1_health').execute({})
    assert.equal(health.ok, false)
    assert.equal(health.databases[0].ok, false)
    assert.match(health.configError, /non-empty "name"/)
    const text = findTool(tools, 'd1_health').output.render({}, health)[0].text
    assert.match(text, /config error: databases/)
  } finally {
    globalThis.fetch = original
  }
})

test('unknown database name is rejected', async () => {
  const { tools } = buildD1Tools(cfg(), ENV)
  await assert.rejects(() => findTool(tools, 'd1_query').execute({ sql: 'SELECT 1', database: 'ghost' }), /no database named ghost/)
})

test('tool outputs are JSON-serializable and render objects/NULLs readably', async () => {
  const stub = routeFetch(() => ({ rows: [{ id: 1, blob: [1, 2, 3], note: null, meta: { a: 1 } }] }))
  try {
    const { tools } = buildD1Tools(cfg(), ENV)
    const q = findTool(tools, 'd1_query')
    const out = await q.execute({ sql: 'SELECT id, blob, note, meta FROM t' })
    assert.doesNotThrow(() => JSON.stringify(out))
    const blocks = q.output.render({}, out)
    assert.ok(Array.isArray(blocks))
    assert.equal(blocks[0].type, 'text')
    assert.match(blocks[0].text, /- 1 \| \[1,2,3\] \| NULL \| \{"a":1\}/)
  } finally {
    stub.restore()
  }
})

test('toCsv escapes commas, quotes and newlines and neutralises formula prefixes in strings', () => {
  assert.equal(toCsv(['a', 'b'], [['x', 'y']]), 'a,b\nx,y')
  assert.equal(toCsv(['a'], [['has,comma']]), 'a\n"has,comma"')
  assert.equal(toCsv(['a'], [['has"quote']]), 'a\n"has""quote"')
  assert.equal(toCsv(['a'], [[null]]), 'a\n')
  assert.equal(toCsv(['a'], [['=HYPERLINK("x")']]), 'a\n"\'=HYPERLINK(""x"")"')
  assert.equal(toCsv(['a'], [['+1', '-2', '@x']]), 'a\n"\'+1","\'-2","\'@x"')
  assert.equal(toCsv(['n'], [[-5]]), 'n\n-5', 'numbers are not touched')
})

test('withRowCap wraps with newlines so trailing comments cannot swallow the wrapper', () => {
  assert.equal(withRowCap('SELECT 1 -- x', 10), 'SELECT * FROM (\nSELECT 1 -- x\n) LIMIT 11')
})
