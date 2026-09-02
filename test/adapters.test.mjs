import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAdapter } from '../lib/adapters.js'

const ACCOUNT = 'a'.repeat(32) // placeholder 32-hex account id
const DB = { name: 'prod', databaseId: '00000000-0000-0000-0000-000000000000', accountId: ACCOUNT }
const SECRET = 'cf-token-SUPERSECRET-should-never-leak'

/** Install a fake fetch that returns `response` and records the request. */
function stubFetch(response) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    if (typeof response === 'function') return response(url, init)
    return response
  }
  return { calls, restore: () => (globalThis.fetch = original) }
}

/** A D1 `/raw` response: results are { columns, rows }. */
function d1Raw(columns, rows, meta = {}) {
  return new Response(JSON.stringify({ success: true, result: [{ results: { columns, rows }, success: true, meta }], errors: [], messages: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function abortError() {
  const err = new Error('The operation was aborted')
  err.name = 'AbortError'
  return err
}

test('query builds the correct D1 /raw request with a Bearer token from env', async () => {
  const stub = stubFetch(d1Raw(['id', 'name'], [[1, 'ada']]))
  try {
    const adapter = createAdapter(DB, { CLOUDFLARE_API_TOKEN: SECRET })
    const result = await adapter.query('SELECT id, name FROM users')
    assert.equal(stub.calls.length, 1)
    const { url, init } = stub.calls[0]
    assert.equal(url, 'https://api.cloudflare.com/client/v4/accounts/' + ACCOUNT + '/d1/database/' + DB.databaseId + '/raw')
    assert.equal(init.method, 'POST')
    assert.equal(init.headers.Authorization, 'Bearer ' + SECRET)
    assert.equal(init.headers['Content-Type'], 'application/json')
    assert.deepEqual(JSON.parse(init.body), { sql: 'SELECT id, name FROM users' })
    assert.ok(init.signal instanceof AbortSignal, 'fetch always receives an AbortSignal')
    assert.deepEqual(result.columns, ['id', 'name'])
    assert.deepEqual(result.rows, [[1, 'ada']])
  } finally {
    stub.restore()
  }
})

test('empty results keep their column headers and duplicate columns survive', async () => {
  const stub = stubFetch((url, init) => {
    const { sql } = JSON.parse(init.body)
    return sql.includes('1=0') ? d1Raw(['name', 'type'], []) : d1Raw(['id', 'id'], [[1, 2]])
  })
  try {
    const adapter = createAdapter(DB, { CLOUDFLARE_API_TOKEN: SECRET })
    const empty = await adapter.query('SELECT name, type FROM t WHERE 1=0')
    assert.deepEqual(empty, { columns: ['name', 'type'], rows: [] })
    const dup = await adapter.query('SELECT a.id, b.id FROM a, b')
    assert.deepEqual(dup, { columns: ['id', 'id'], rows: [[1, 2]] })
  } finally {
    stub.restore()
  }
})

test('bound params are forwarded to D1', async () => {
  const stub = stubFetch(d1Raw(['n'], [[1]]))
  try {
    const adapter = createAdapter(DB, { CLOUDFLARE_API_TOKEN: SECRET })
    await adapter.query('SELECT * FROM users WHERE id = ?', [42])
    assert.deepEqual(JSON.parse(stub.calls[0].init.body), { sql: 'SELECT * FROM users WHERE id = ?', params: [42] })
  } finally {
    stub.restore()
  }
})

test('per-database token overrides the global one', async () => {
  const stub = stubFetch(d1Raw(['1'], [[1]]))
  try {
    const adapter = createAdapter(DB, { CLOUDFLARE_API_TOKEN: 'global-token', DSH_D1_TOKEN_PROD: 'per-db-token' })
    await adapter.ping()
    assert.equal(stub.calls[0].init.headers.Authorization, 'Bearer per-db-token')
  } finally {
    stub.restore()
  }
})

test('a missing token throws and the message names the env var, not a token', async () => {
  const adapter = createAdapter(DB, {})
  await assert.rejects(
    () => adapter.query('SELECT 1'),
    (err) => {
      assert.match(err.message, /DSH_D1_TOKEN_PROD|CLOUDFLARE_API_TOKEN/)
      return true
    },
  )
})

test('a token with embedded whitespace or control characters is rejected before any request and never echoed', async () => {
  const stub = stubFetch(d1Raw(['1'], [[1]]))
  try {
    for (const bad of ['abc\r\ndef', 'abc def', 'abc\tdef']) {
      const adapter = createAdapter(DB, { CLOUDFLARE_API_TOKEN: bad })
      await assert.rejects(
        () => adapter.ping(),
        (err) => {
          assert.match(err.message, /whitespace or control characters/)
          assert.doesNotMatch(err.message, /abc/)
          return true
        },
      )
    }
    assert.equal(stub.calls.length, 0)
  } finally {
    stub.restore()
  }
})

test('exec sums meta.changes across statements', async () => {
  const stub = stubFetch(
    new Response(
      JSON.stringify({
        success: true,
        result: [
          { results: { columns: [], rows: [] }, success: true, meta: { changes: 3 } },
          { results: { columns: [], rows: [] }, success: true, meta: { changes: 2 } },
        ],
        errors: [],
      }),
      { status: 200 },
    ),
  )
  try {
    const adapter = createAdapter(DB, { CLOUDFLARE_API_TOKEN: SECRET })
    const changes = await adapter.exec('UPDATE t SET x = 1')
    assert.equal(changes, 5)
  } finally {
    stub.restore()
  }
})

test('a D1 error response throws a redacted error (no token, no headers, no request path ids)', async () => {
  const stub = stubFetch(
    new Response(
      JSON.stringify({
        success: false,
        result: [],
        errors: [{ code: 7003, message: 'Could not route to /client/v4/accounts/' + ACCOUNT + '/d1/database/' + DB.databaseId + '/raw, perhaps your object identifier is invalid?' }],
      }),
      { status: 404 },
    ),
  )
  try {
    const adapter = createAdapter(DB, { CLOUDFLARE_API_TOKEN: SECRET })
    await assert.rejects(
      () => adapter.query('SELECT * FROM ghost'),
      (err) => {
        assert.match(err.message, /Could not route/)
        assert.match(err.message, /HTTP 404/)
        assert.doesNotMatch(err.message, new RegExp(ACCOUNT))
        assert.doesNotMatch(err.message, new RegExp(DB.databaseId))
        assert.doesNotMatch(err.message, new RegExp(SECRET))
        assert.doesNotMatch(err.message, /Bearer/)
        return true
      },
    )
  } finally {
    stub.restore()
  }
})

test('a success:false body that echoes the token is scrubbed too (one redaction path for every failure)', async () => {
  const stub = stubFetch(
    new Response(JSON.stringify({ success: false, result: [], errors: [{ message: 'proxy rejected header Authorization: Bearer ' + SECRET }] }), { status: 502 }),
  )
  try {
    const adapter = createAdapter(DB, { CLOUDFLARE_API_TOKEN: SECRET })
    await assert.rejects(
      () => adapter.query('SELECT 1'),
      (err) => {
        assert.match(err.message, /HTTP 502/)
        assert.match(err.message, /<redacted>/)
        assert.doesNotMatch(err.message, new RegExp(SECRET))
        return true
      },
    )
  } finally {
    stub.restore()
  }
})

test('exec ignores a non-numeric meta.changes instead of producing NaN', async () => {
  const stub = stubFetch(
    new Response(
      JSON.stringify({
        success: true,
        result: [
          { results: { columns: [], rows: [] }, success: true, meta: { changes: 'abc' } },
          { results: { columns: [], rows: [] }, success: true, meta: { changes: '3' } },
          { results: { columns: [], rows: [] }, success: true, meta: {} },
        ],
        errors: [],
      }),
      { status: 200 },
    ),
  )
  try {
    const adapter = createAdapter(DB, { CLOUDFLARE_API_TOKEN: SECRET })
    assert.equal(await adapter.exec('UPDATE t SET x = 1'), 3)
  } finally {
    stub.restore()
  }
})

test('an abort with a non-Error reason is still reported as a cancellation (classified by signal state)', async () => {
  const stub = stubFetch(
    (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason))
      }),
  )
  try {
    const adapter = createAdapter(DB, { CLOUDFLARE_API_TOKEN: SECRET })
    const controller = new AbortController()
    const pending = adapter.query('SELECT 1', undefined, { signal: controller.signal })
    setTimeout(() => controller.abort({ kind: 'TOOL_TIMEOUT', ms: 5 }), 10)
    await assert.rejects(pending, /cancelled by the caller/)
  } finally {
    stub.restore()
  }
})

test('a network error never leaks the token, even when the underlying message contains it', async () => {
  const stub = stubFetch(() => {
    const err = new TypeError('fetch failed: header value "Bearer ' + SECRET + '" is invalid')
    err.cause = { code: 'ERR_INVALID_HTTP_TOKEN' }
    throw err
  })
  try {
    const adapter = createAdapter(DB, { CLOUDFLARE_API_TOKEN: SECRET })
    await assert.rejects(
      () => adapter.query('SELECT 1'),
      (err) => {
        assert.match(err.message, /D1 request failed for "prod"/)
        assert.match(err.message, /ERR_INVALID_HTTP_TOKEN/)
        assert.doesNotMatch(err.message, new RegExp(SECRET))
        return true
      },
    )
  } finally {
    stub.restore()
  }
})

test('listTables filters sqlite_ and _cf_ internals with literal underscores', async () => {
  const stub = stubFetch(d1Raw(['name'], [['acfg'], ['users'], ['posts']]))
  try {
    const adapter = createAdapter(DB, { CLOUDFLARE_API_TOKEN: SECRET })
    const tables = await adapter.listTables()
    assert.deepEqual(tables, ['acfg', 'users', 'posts'])
    const { sql } = JSON.parse(stub.calls[0].init.body)
    assert.match(sql, /NOT LIKE 'sqlite\\_%' ESCAPE '\\'/)
    assert.match(sql, /NOT LIKE '\\_cf\\_%' ESCAPE '\\'/)
  } finally {
    stub.restore()
  }
})

test('databaseSize reads meta.size_after (D1-native, not PRAGMA)', async () => {
  const stub = stubFetch(d1Raw(['1'], [[1]], { size_after: 333279232 }))
  try {
    const adapter = createAdapter(DB, { CLOUDFLARE_API_TOKEN: SECRET })
    const size = await adapter.databaseSize()
    assert.equal(size, 333279232)
    assert.equal(stub.calls.length, 1)
    assert.doesNotMatch(stub.calls[0].init.body, /PRAGMA/i)
  } finally {
    stub.restore()
  }
})

test('databaseSize returns -1 when meta.size_after is absent', async () => {
  const stub = stubFetch(d1Raw(['1'], [[1]], {}))
  try {
    const adapter = createAdapter(DB, { CLOUDFLARE_API_TOKEN: SECRET })
    assert.equal(await adapter.databaseSize(), -1)
  } finally {
    stub.restore()
  }
})

test('describeTable maps PRAGMA table_info rows by column name and quotes the table', async () => {
  const stub = stubFetch(
    d1Raw(
      ['cid', 'name', 'type', 'notnull', 'dflt_value', 'pk'],
      [
        [0, 'id', 'INTEGER', 1, null, 1],
        [1, 'email', 'TEXT', 0, null, 0],
      ],
    ),
  )
  try {
    const adapter = createAdapter(DB, { CLOUDFLARE_API_TOKEN: SECRET })
    const cols = await adapter.describeTable('user "accounts"')
    assert.deepEqual(cols, [
      { name: 'id', type: 'INTEGER', notNull: true, primaryKey: true },
      { name: 'email', type: 'TEXT', notNull: false, primaryKey: false },
    ])
    const { sql } = JSON.parse(stub.calls[0].init.body)
    assert.equal(sql, 'PRAGMA table_info("user ""accounts""")')
  } finally {
    stub.restore()
  }
})

test('describeTable rejects an impossible table name before any request', async () => {
  const stub = stubFetch(d1Raw([], []))
  try {
    const adapter = createAdapter(DB, { CLOUDFLARE_API_TOKEN: SECRET })
    await assert.rejects(() => adapter.describeTable('   '), /invalid/)
    await assert.rejects(() => adapter.describeTable('a\0b'), /invalid/)
    assert.equal(stub.calls.length, 0)
  } finally {
    stub.restore()
  }
})

test('a missing account throws before any request', async () => {
  const stub = stubFetch(d1Raw([], []))
  try {
    const adapter = createAdapter({ name: 'prod', databaseId: DB.databaseId, accountId: '' }, { CLOUDFLARE_API_TOKEN: SECRET })
    await assert.rejects(() => adapter.ping(), /account id/)
    assert.equal(stub.calls.length, 0)
  } finally {
    stub.restore()
  }
})

test("the caller's AbortSignal is forwarded: aborting mid-flight aborts the fetch", async () => {
  let sawAbort = false
  const stub = stubFetch(
    (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          sawAbort = true
          reject(abortError())
        })
        setTimeout(() => resolve(d1Raw(['1'], [[1]])), 2000)
      }),
  )
  try {
    const adapter = createAdapter(DB, { CLOUDFLARE_API_TOKEN: SECRET })
    const controller = new AbortController()
    const started = Date.now()
    const pending = adapter.query('SELECT 1', undefined, { signal: controller.signal })
    setTimeout(() => controller.abort(), 50)
    await assert.rejects(pending, /cancelled by the caller/)
    assert.ok(sawAbort, 'fetch observed the abort')
    assert.ok(Date.now() - started < 1500, 'did not wait for the slow response')
  } finally {
    stub.restore()
  }
})

test('an already-aborted signal issues no request at all', async () => {
  const stub = stubFetch(d1Raw(['1'], [[1]]))
  try {
    const adapter = createAdapter(DB, { CLOUDFLARE_API_TOKEN: SECRET })
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(() => adapter.query('SELECT 1', undefined, { signal: controller.signal }), /cancelled before it started/)
    assert.equal(stub.calls.length, 0)
  } finally {
    stub.restore()
  }
})

test('the request timeout covers the body phase, not only the headers', async () => {
  const stub = stubFetch((url, init) => {
    // Headers arrive immediately; the body never finishes unless the signal fires.
    const body = new ReadableStream({
      start(controller) {
        init.signal.addEventListener('abort', () => controller.error(abortError()))
      },
    })
    return new Response(body, { status: 200 })
  })
  try {
    const adapter = createAdapter(DB, { CLOUDFLARE_API_TOKEN: SECRET }, { queryTimeoutMs: 100, execTimeoutMs: 100 })
    const started = Date.now()
    await assert.rejects(() => adapter.query('SELECT 1'), /timed out after 100ms/)
    assert.ok(Date.now() - started < 1500)
  } finally {
    stub.restore()
  }
})
