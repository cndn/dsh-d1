// Harness-contract tests: render() totality, the empty values returned on
// cancellation, timeout derivation, and — when the real dsh-tools package is
// reachable — dsh's own JSON-schema acceptance of every tool definition.
//
// dsh-tools is not a dependency of this package. Point DSH_TOOLS_ENTRY at an
// installed copy (e.g. <profile>/node_modules/@deepseek-ai/dsh-tools/lib/index.js)
// to run the schema tests; otherwise they are skipped.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildD1Tools } from '../lib/tools.js'
import { resolveConfig } from '../lib/config.js'

const ENV = { CLOUDFLARE_API_TOKEN: 'test-token', CLOUDFLARE_ACCOUNT_ID: 'd'.repeat(32) }
const cfg = (overrides = {}) => resolveConfig({ databases: [{ name: 'prod', databaseId: '00000000-0000-0000-0000-000000000000' }], ...overrides }, ENV)

async function loadDshTools() {
  const candidates = [process.env.DSH_TOOLS_ENTRY, '@deepseek-ai/dsh-tools'].filter(Boolean)
  for (const spec of candidates) {
    try {
      return await import(spec)
    } catch {
      // not installed here — try the next candidate
    }
  }
  return null
}
const dshTools = await loadDshTools()

/** Drive every tool through an aborted signal so cancellable() returns its empty value. */
async function emptyValues() {
  const original = globalThis.fetch
  const controller = new AbortController()
  controller.abort()
  globalThis.fetch = async () => {
    throw new Error('fetch must not be reached with a pre-aborted signal')
  }
  try {
    const { tools } = buildD1Tools(cfg(), ENV)
    const out = {}
    for (const tool of tools) {
      const args = tool.name === 'd1_query' ? { sql: 'SELECT 1' } : tool.name === 'd1_exec' ? { sql: 'DELETE FROM t' } : {}
      const def = tool.name === 'd1_exec' ? buildD1Tools(cfg({ readOnly: false }), ENV).tools.find((t) => t.name === 'd1_exec') : tool
      out[tool.name] = await def.execute(args, { signal: controller.signal })
    }
    return out
  } finally {
    globalThis.fetch = original
  }
}

test('render() is total: never throws for undefined/null/{}/[]/string/partial values', () => {
  const { tools } = buildD1Tools(cfg(), ENV)
  for (const tool of tools) {
    for (const value of [undefined, null, {}, [], 'str', 42, { rows: 'not-an-array' }, { databases: [null, 3, {}] }, { tables: [{ name: 't' }, null], columns: [null] }]) {
      const blocks = tool.output.render({}, value)
      assert.ok(Array.isArray(blocks) && blocks.length > 0, tool.name + ' renders a block for ' + JSON.stringify(value))
      assert.equal(blocks[0].type, 'text')
      assert.equal(typeof blocks[0].text, 'string')
    }
  }
})

test('every tool declares a timeoutMs and the read tools a concurrency classifier', () => {
  const c = cfg({ queryTimeoutMs: 7000, execTimeoutMs: 9000 })
  const { tools } = buildD1Tools(c, ENV)
  const by = Object.fromEntries(tools.map((t) => [t.name, t]))
  assert.equal(by.d1_query.timeoutMs, 7000)
  assert.equal(by.d1_exec.timeoutMs, 9000)
  assert.equal(by.d1_stats.timeoutMs, Math.min(600000, 7000 * 4), 'd1_stats budget is 4×queryTimeoutMs')
  assert.equal(buildD1Tools(cfg({ queryTimeoutMs: 600000 }), ENV).tools.find((t) => t.name === 'd1_stats').timeoutMs, 600000, 'clamped at 10 min')
  for (const name of ['d1_list', 'd1_query', 'd1_schema', 'd1_stats', 'd1_health']) assert.equal(by[name].isConcurrencySafe({}), true)
  assert.equal(by.d1_exec.isConcurrencySafe, undefined)
})

test('the empty value returned on cancellation carries every key the output schema requires', async () => {
  const empties = await emptyValues()
  const { tools } = buildD1Tools(cfg(), ENV)
  for (const tool of tools) {
    const required = tool.output.schema.required ?? []
    assert.ok(required.length > 0, tool.name + ' declares required output keys')
    for (const key of required) assert.ok(key in empties[tool.name], tool.name + ' empty value has ' + key)
  }
})

test('dsh-tools accepts every parameters/output schema and validates the cancellation empties', { skip: dshTools === null && 'set DSH_TOOLS_ENTRY to run against an installed dsh-tools' }, async () => {
  const { assertObjectJsonSchema, assertSupportedJsonSchema, validateJsonSchemaValue } = dshTools
  const { tools } = buildD1Tools(cfg(), ENV)
  const empties = await emptyValues()
  for (const tool of tools) {
    assert.doesNotThrow(() => assertObjectJsonSchema(tool.parameters), tool.name + ' parameters')
    assert.doesNotThrow(() => assertSupportedJsonSchema(tool.output.schema), tool.name + ' output schema')
    const violations = validateJsonSchemaValue(tool.output.schema, empties[tool.name], tool.name)
    assert.deepEqual(violations, [], tool.name + ' empty value validates')
  }
})
