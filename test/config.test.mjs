import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig, tokenEnvName, assertIdentifier } from '../lib/config.js'

const ACCOUNT_A = 'a'.repeat(32)
const ACCOUNT_B = 'b'.repeat(32)
const UUID_0 = '00000000-0000-0000-0000-000000000000'
const UUID_1 = '11111111-1111-1111-1111-111111111111'

test('resolveConfig(null) is read-only first with no databases', () => {
  const cfg = resolveConfig(null, {})
  assert.equal(cfg.readOnly, true)
  assert.equal(cfg.writeApproval, true)
  assert.deepEqual(cfg.databases, [])
  assert.equal(cfg.maxRows, 1000)
  assert.equal(cfg.queryTimeoutMs, 60000)
  assert.equal(cfg.execTimeoutMs, 120000)
  assert.equal(cfg.accountId, '')
})

test('resolveConfig(undefined) matches null', () => {
  assert.deepEqual(resolveConfig(undefined, {}), resolveConfig(null, {}))
})

test('readOnly only turns off when explicitly false', () => {
  assert.equal(resolveConfig({}, {}).readOnly, true)
  assert.equal(resolveConfig({ readOnly: true }, {}).readOnly, true)
  assert.equal(resolveConfig({ readOnly: false }, {}).readOnly, false)
  // truthy-but-not-false values stay safe
  assert.equal(resolveConfig({ readOnly: undefined }, {}).readOnly, true)
})

test('writeApproval only turns off when explicitly false', () => {
  assert.equal(resolveConfig({}, {}).writeApproval, true)
  assert.equal(resolveConfig({ writeApproval: false }, {}).writeApproval, false)
})

test('account resolves from config, then env, and must be 32 hex characters', () => {
  assert.equal(resolveConfig({ accountId: ACCOUNT_A }, {}).accountId, ACCOUNT_A)
  assert.equal(resolveConfig({}, { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_B }).accountId, ACCOUNT_B)
  // config wins over env
  assert.equal(resolveConfig({ accountId: ACCOUNT_A }, { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_B }).accountId, ACCOUNT_A)
  assert.throws(() => resolveConfig({ accountId: 'x/../../zones/evil' }, {}), /invalid Cloudflare account id/)
  assert.throws(() => resolveConfig({}, { CLOUDFLARE_ACCOUNT_ID: 'acct-123' }), /CLOUDFLARE_ACCOUNT_ID.*invalid/)
  assert.throws(() => resolveConfig({ databases: [{ name: 'x', databaseId: UUID_0, accountId: 'nope' }] }, {}), /database x accountId.*invalid/)
})

test('databases resolve and inherit the global account', () => {
  const cfg = resolveConfig(
    {
      accountId: ACCOUNT_A,
      databases: [
        { name: 'prod', databaseId: UUID_0 },
        { name: 'other', databaseId: UUID_1, accountId: ACCOUNT_B },
      ],
    },
    {},
  )
  assert.equal(cfg.databases.length, 2)
  assert.equal(cfg.databases[0].accountId, ACCOUNT_A)
  assert.equal(cfg.databases[1].accountId, ACCOUNT_B)
})

test('invalid database configs throw', () => {
  assert.throws(() => resolveConfig({ databases: [{ name: '', databaseId: UUID_0 }] }, {}), /non-empty/)
  assert.throws(() => resolveConfig({ databases: [{ name: 'x' }] }, {}), /databaseId/)
  assert.throws(() => resolveConfig({ databases: [{ name: 'x', databaseId: 'not-a-uuid' }] }, {}), /invalid/)
  assert.throws(
    () =>
      resolveConfig(
        {
          databases: [
            { name: 'dup', databaseId: UUID_0 },
            { name: 'DUP', databaseId: UUID_1 },
          ],
        },
        {},
      ),
    /duplicate/,
  )
})

test('database names that map to the same token env var are rejected', () => {
  assert.throws(
    () =>
      resolveConfig(
        {
          databases: [
            { name: 'prod-eu', databaseId: UUID_0 },
            { name: 'prod_eu', databaseId: UUID_1 },
          ],
        },
        {},
      ),
    /both map to the token env var DSH_D1_TOKEN_PROD_EU/,
  )
})

test('maxRows / timeouts validate and clamp', () => {
  assert.equal(resolveConfig({ maxRows: 50 }, {}).maxRows, 50)
  assert.equal(resolveConfig({ maxRows: 999999 }, {}).maxRows, 10000)
  assert.throws(() => resolveConfig({ maxRows: 0 }, {}), /positive integer/)
  assert.throws(() => resolveConfig({ maxRows: 1.5 }, {}), /positive integer/)
  assert.equal(resolveConfig({ queryTimeoutMs: 1000 }, {}).queryTimeoutMs, 5000) // clamped up to floor
  assert.equal(resolveConfig({ queryTimeoutMs: 999999999 }, {}).queryTimeoutMs, 600000)
  assert.throws(() => resolveConfig({ execTimeoutMs: -1 }, {}), /positive number/)
})

test('tokenEnvName sanitizes the database name', () => {
  assert.equal(tokenEnvName('prod'), 'DSH_D1_TOKEN_PROD')
  assert.equal(tokenEnvName('my-db.1'), 'DSH_D1_TOKEN_MY_DB_1')
})

test('assertIdentifier accepts any plausible SQLite name and rejects impossible ones', () => {
  assert.equal(assertIdentifier('users', 'table'), 'users')
  assert.equal(assertIdentifier('  users_2 ', 'table'), 'users_2')
  assert.equal(assertIdentifier('user accounts', 'table'), 'user accounts')
  assert.equal(assertIdentifier('a"b', 'table'), 'a"b')
  assert.throws(() => assertIdentifier('', 'table'), /invalid/)
  assert.throws(() => assertIdentifier('a\0b', 'table'), /invalid/)
  assert.throws(() => assertIdentifier('x'.repeat(300), 'table'), /invalid/)
})
