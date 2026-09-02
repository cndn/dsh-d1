/**
 * dsh-d1 config resolution: Cloudflare account, D1 database bindings, row cap,
 * read-only-first mode and write-approval policy.
 *
 * The Cloudflare API token is NEVER part of the config — it is read from the
 * environment at call time (see {@link tokenEnvName}). This keeps secrets out
 * of profile files, patches, logs and serialized state.
 *
 * @module dsh-d1/config
 */

/** One D1 database binding (config row). */
export interface D1DatabaseConfig {
  /** Friendly name the model refers to (e.g. "prod"). */
  name: string
  /** D1 database UUID (from the Cloudflare dashboard / `wrangler d1 list`). */
  databaseId: string
  /** Optional per-database account override; falls back to the global account. */
  accountId?: string
}

/** Raw plugin config (as authored in cordis.patch.yml). */
export interface D1Config {
  accountId?: string
  databases?: D1DatabaseConfig[]
  maxRows?: number
  readOnly?: boolean
  writeApproval?: boolean
  queryTimeoutMs?: number
  execTimeoutMs?: number
}

/** A database binding after resolution (accountId filled from global/env). */
export interface ResolvedD1Database {
  name: string
  databaseId: string
  accountId: string
}

/** Fully resolved, validated config. */
export interface ResolvedD1Config {
  accountId: string
  databases: ResolvedD1Database[]
  maxRows: number
  readOnly: boolean
  writeApproval: boolean
  queryTimeoutMs: number
  execTimeoutMs: number
}

/**
 * Per-database token env var name: `DSH_D1_TOKEN_<NAME>` where NAME is the
 * database name uppercased with every non `[A-Z0-9_]` character replaced by
 * `_` (so `my-db` → `DSH_D1_TOKEN_MY_DB`). {@link resolveConfig} rejects two
 * databases whose names map to the same variable.
 */
export function tokenEnvName(name: string): string {
  return 'DSH_D1_TOKEN_' + name.toUpperCase().replace(/[^A-Z0-9_]/g, '_')
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Cloudflare account ids are 32 hex characters. */
const ACCOUNT_RE = /^[0-9a-f]{32}$/i

/** Validate an account id so it can only ever select an `/accounts/{id}` path segment. */
function checkAccount(value: string, where: string): string {
  const trimmed = value.trim()
  if (trimmed === '') return ''
  if (!ACCOUNT_RE.test(trimmed)) throw new Error(where + ': invalid Cloudflare account id (expected 32 hex characters).')
  return trimmed
}

/**
 * Parse and validate config. Read-only is the default (read-only first): a
 * missing `readOnly` resolves to `true`, so `d1_exec` is disabled unless the
 * operator explicitly opts into writes. With no databases the plugin still
 * loads (tools register; d1_health reports "no databases configured").
 */
export function resolveConfig(config: D1Config | undefined | null, env: NodeJS.ProcessEnv = process.env): ResolvedD1Config {
  const cfg = config ?? {}
  const envAccount = typeof env.CLOUDFLARE_ACCOUNT_ID === 'string' ? checkAccount(env.CLOUDFLARE_ACCOUNT_ID, 'CLOUDFLARE_ACCOUNT_ID') : ''
  const cfgAccount = typeof cfg.accountId === 'string' ? checkAccount(cfg.accountId, 'accountId') : ''
  const globalAccount = cfgAccount !== '' ? cfgAccount : envAccount

  const rawDatabases = Array.isArray(cfg.databases) ? cfg.databases : []
  const databases: ResolvedD1Database[] = []
  const seenNames = new Set<string>()
  const seenTokenVars = new Map<string, string>()
  for (const raw of rawDatabases) {
    if (typeof raw !== 'object' || raw === null) continue
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    if (name === '') throw new Error('databases: every entry needs a non-empty "name".')
    if (seenNames.has(name.toLowerCase())) throw new Error('duplicate database name: ' + name + '.')
    seenNames.add(name.toLowerCase())
    const tokenVar = tokenEnvName(name)
    const clash = seenTokenVars.get(tokenVar)
    if (clash !== undefined) {
      throw new Error('database names "' + clash + '" and "' + name + '" both map to the token env var ' + tokenVar + '; rename one of them.')
    }
    seenTokenVars.set(tokenVar, name)
    const databaseId = typeof raw.databaseId === 'string' ? raw.databaseId.trim() : ''
    if (databaseId === '') throw new Error('database ' + name + ' is missing "databaseId".')
    if (!UUID_RE.test(databaseId)) throw new Error('database ' + name + ' has an invalid "databaseId" (expected a D1 UUID).')
    const ownAccount = typeof raw.accountId === 'string' ? checkAccount(raw.accountId, 'database ' + name + ' accountId') : ''
    databases.push({ name, databaseId: databaseId.toLowerCase(), accountId: ownAccount !== '' ? ownAccount : globalAccount })
  }

  let maxRows = 1000
  if (cfg.maxRows !== undefined) {
    if (typeof cfg.maxRows !== 'number' || !Number.isInteger(cfg.maxRows) || cfg.maxRows <= 0) throw new Error('maxRows must be a positive integer.')
    maxRows = Math.min(10000, cfg.maxRows)
  }
  let queryTimeoutMs = 60000
  if (cfg.queryTimeoutMs !== undefined) {
    if (typeof cfg.queryTimeoutMs !== 'number' || !Number.isFinite(cfg.queryTimeoutMs) || cfg.queryTimeoutMs <= 0) throw new Error('queryTimeoutMs must be a positive number (milliseconds).')
    queryTimeoutMs = Math.min(600000, Math.max(5000, Math.round(cfg.queryTimeoutMs)))
  }
  let execTimeoutMs = 120000
  if (cfg.execTimeoutMs !== undefined) {
    if (typeof cfg.execTimeoutMs !== 'number' || !Number.isFinite(cfg.execTimeoutMs) || cfg.execTimeoutMs <= 0) throw new Error('execTimeoutMs must be a positive number (milliseconds).')
    execTimeoutMs = Math.min(600000, Math.max(5000, Math.round(cfg.execTimeoutMs)))
  }

  const readOnly = cfg.readOnly !== false // default true — read-only first
  const writeApproval = cfg.writeApproval !== false // default true

  return { accountId: globalAccount, databases, maxRows, readOnly, writeApproval, queryTimeoutMs, execTimeoutMs }
}

/**
 * Check a table name before it is double-quoted into SQL. Quoting (`"` → `""`)
 * is what makes the name safe; this only rejects values that can never be a
 * SQLite identifier (empty, NUL bytes, absurd length), so tables with spaces,
 * dashes or dots — legal in SQLite and listed by d1_schema — remain describable.
 */
export function assertIdentifier(name: string, label: string): string {
  const trimmed = name.trim()
  if (trimmed === '' || trimmed.length > 256 || trimmed.includes('\0')) {
    throw new Error(label + ' is invalid (must be 1-256 characters with no NUL bytes).')
  }
  return trimmed
}
