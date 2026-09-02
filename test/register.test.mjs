import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, describeWrite, name, inject } from '../lib/index.js'

function makeFakeCtx() {
  const registered = []
  const listeners = new Map()
  const ctx = {
    tools: {
      register(def) {
        registered.push(def)
        return () => {}
      },
    },
    on(event, listener) {
      listeners.set(event, listener)
    },
  }
  return { ctx, registered, listeners }
}

const next = async () => ({ kind: 'allow' })

test('plugin metadata', () => {
  assert.equal(name, 'd1')
  assert.deepEqual(inject, ['tools'])
})

test('apply registers all six d1 tools and only the pre-execute listener', () => {
  const { ctx, registered, listeners } = makeFakeCtx()
  apply(ctx, null)
  const names = registered.map((d) => d.name).sort()
  assert.deepEqual(names, ['d1_exec', 'd1_health', 'd1_list', 'd1_query', 'd1_schema', 'd1_stats'])
  assert.deepEqual([...listeners.keys()], ['tools/pre-execute'])
})

test('every registered tool has the expected shape', () => {
  const { ctx, registered } = makeFakeCtx()
  apply(ctx, null)
  for (const def of registered) {
    assert.equal(typeof def.name, 'string')
    assert.equal(typeof def.description, 'string')
    assert.equal(def.parameters.type, 'object')
    assert.equal(typeof def.parameters.properties, 'object')
    assert.equal(typeof def.output.schema, 'object')
    assert.equal(typeof def.output.render, 'function')
    assert.equal(typeof def.execute, 'function')
  }
})

test('the gate reads the ToolExecution "arguments" field and previews the SQL in the ask reason', async () => {
  const { ctx, listeners } = makeFakeCtx()
  apply(ctx, { readOnly: false, writeApproval: true })
  const gate = listeners.get('tools/pre-execute')
  assert.equal(typeof gate, 'function')

  const verdict = await gate({ name: 'd1_exec', arguments: { sql: 'DELETE FROM t WHERE id = ?', params: [1], database: 'prod' } }, next)
  assert.equal(verdict.kind, 'ask')
  assert.match(verdict.reason, /requires interactive approval/)
  assert.match(verdict.reason, /database prod/)
  assert.match(verdict.reason, /1 bound param/)
  assert.match(verdict.reason, /DELETE FROM t WHERE id = \?/)
})

test('the gate waterfalls every other tool', async () => {
  const { ctx, listeners } = makeFakeCtx()
  apply(ctx, { readOnly: false, writeApproval: true })
  const gate = listeners.get('tools/pre-execute')
  let nextCalled = false
  const verdict = await gate({ name: 'd1_query', arguments: { sql: 'SELECT 1' } }, async () => {
    nextCalled = true
    return { kind: 'allow' }
  })
  assert.equal(verdict.kind, 'allow')
  assert.equal(nextCalled, true)
})

test('under readOnly (the default) the gate denies d1_exec instead of prompting', async () => {
  const { ctx, listeners } = makeFakeCtx()
  apply(ctx, null)
  const gate = listeners.get('tools/pre-execute')
  const verdict = await gate({ name: 'd1_exec', arguments: { sql: 'DELETE FROM t' } }, next)
  assert.equal(verdict.kind, 'deny')
  assert.match(verdict.reason, /readOnly/)
})

test('readOnly:true with writeApproval:false still denies d1_exec at the gate', async () => {
  const { ctx, listeners } = makeFakeCtx()
  apply(ctx, { readOnly: true, writeApproval: false })
  const verdict = await listeners.get('tools/pre-execute')({ name: 'd1_exec', arguments: { sql: 'DELETE FROM t' } }, next)
  assert.equal(verdict.kind, 'deny')
})

test('a long statement is previewed head + tail, and multi-statement input is counted', async () => {
  const { ctx, listeners } = makeFakeCtx()
  apply(ctx, { readOnly: false, writeApproval: true })
  const gate = listeners.get('tools/pre-execute')
  const padding = 'x'.repeat(2000)
  const sql = "UPDATE t SET note = '" + padding + "' WHERE id = 1; DROP TABLE users"
  const verdict = await gate({ name: 'd1_exec', arguments: { sql } }, next)
  assert.equal(verdict.kind, 'ask')
  assert.match(verdict.reason, /2 statements/)
  assert.match(verdict.reason, /^d1_exec write requires interactive approval — database default, 2 statements: UPDATE t SET note = 'xxx/)
  assert.match(verdict.reason, /DROP TABLE users$/, 'the tail (where a smuggled statement would hide) is shown')
  assert.match(verdict.reason, / … /)
  assert.ok(verdict.reason.length < 700)
})

test('describeWrite copes with missing or malformed arguments', () => {
  assert.match(describeWrite(undefined), /\(no sql provided\)/)
  assert.match(describeWrite({ sql: 42 }), /\(no sql provided\)/)
  assert.match(describeWrite({ sql: '  DELETE   FROM t  ' }), /: DELETE FROM t$/)
})

test('writeApproval:false with readOnly:false registers no pre-execute gate', () => {
  const { ctx, listeners } = makeFakeCtx()
  const warnings = []
  const original = console.warn
  console.warn = (msg) => warnings.push(String(msg))
  try {
    apply(ctx, { readOnly: false, writeApproval: false })
  } finally {
    console.warn = original
  }
  assert.equal(listeners.has('tools/pre-execute'), false)
  assert.ok(warnings.some((w) => /no approval gate/.test(w)), 'warns at boot that writes are ungated')
})

test('invalid config falls back to safe defaults and d1_health reports the reason', async () => {
  const { ctx, registered } = makeFakeCtx()
  const original = console.warn
  console.warn = () => {}
  try {
    assert.doesNotThrow(() => apply(ctx, { maxRows: 0 }))
  } finally {
    console.warn = original
  }
  assert.equal(registered.length, 6)
  const health = await registered.find((d) => d.name === 'd1_health').execute({})
  assert.equal(health.readOnly, true)
  assert.deepEqual(health.databases, [])
  assert.match(health.configError, /maxRows/)
})
