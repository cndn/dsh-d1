import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(root + 'package.json', 'utf8'))

test('package identity', () => {
  assert.equal(pkg.name, 'dsh-d1')
  assert.equal(pkg.type, 'module')
  assert.equal(typeof pkg.version, 'string')
  assert.equal(pkg.license, 'MIT')
})

test('dsh bundle patch points at the shipped cordis.patch.yml', () => {
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.ok(existsSync(root + 'cordis.patch.yml'), 'cordis.patch.yml must exist')
})

test('marketplace keywords are present', () => {
  assert.ok(Array.isArray(pkg.keywords))
  for (const kw of ['dsh-plugin', 'deepseek-harness', 'cloudflare', 'd1']) {
    assert.ok(pkg.keywords.includes(kw), 'missing keyword ' + kw)
  }
})

test('exports and files are wired for publish', () => {
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.types, 'lib/index.d.ts')
  // "." is a conditions map: { types, default }.
  const rootExport = pkg.exports['.']
  const rootDefault = typeof rootExport === 'string' ? rootExport : rootExport.default
  assert.equal(rootDefault, './lib/index.js')
  if (typeof rootExport === 'object') assert.equal(rootExport.types, './lib/index.d.ts')
  assert.equal(pkg.exports['./cordis.patch.yml'], './cordis.patch.yml')
  for (const entry of ['lib', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
    assert.ok(pkg.files.includes(entry), 'files must include ' + entry)
  }
  // lib/ is gitignored, so git-hosted installs must build it on install.
  assert.equal(pkg.scripts.prepare, 'tsc -p tsconfig.json')
  assert.equal(pkg.scripts.prepublishOnly, 'tsc -p tsconfig.json')
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), [], 'zero runtime dependencies')
  assert.equal(typeof pkg.bugs?.url, 'string')
})

test('the README documents the id-targeted config override and the -w install flag', () => {
  const readme = readFileSync(root + 'README.md', 'utf8')
  assert.match(readme, /dsh plugin --profile web add -w dsh-d1/)
  assert.match(readme, /- id: d1\n  name: 'dsh-d1'\n  config:/)
  assert.doesNotMatch(readme, /^- insert:/m, 'README must not tell users to insert a second d1 row')
})

test('the bundled patch carries no secrets and no real database ids', () => {
  const patch = readFileSync(root + 'cordis.patch.yml', 'utf8')
  assert.doesNotMatch(patch, /Bearer\s+\S/i)
  assert.doesNotMatch(patch, /CLOUDFLARE_API_TOKEN\s*[:=]\s*\S/)
  // Any UUID present must be the all-zeros placeholder — never a real databaseId.
  const uuids = patch.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? []
  for (const uuid of uuids) {
    assert.equal(uuid.replace(/[0-]/g, ''), '', 'unexpected real-looking UUID in bundled patch: ' + uuid)
  }
})
