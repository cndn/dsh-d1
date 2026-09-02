/**
 * Cloudflare D1 adapter: speaks the D1 HTTP API
 * (`POST /accounts/{account}/d1/database/{db}/raw`). D1 is serverless SQLite
 * over HTTP — there is no socket to pool and nothing to close.
 *
 * The `/raw` endpoint (rather than `/query`) is used because it returns
 * `results: { columns, rows }`, which keeps column headers for empty result
 * sets and preserves duplicate column names; `/query` serializes rows as
 * objects and loses both.
 *
 * The API token is resolved from the environment on every request and is never
 * stored on the adapter, logged, or included in any thrown error. Every request
 * observes the caller's AbortSignal (the harness's cancellation / timeout
 * signal) fused with the adapter's own per-request timeout.
 *
 * @module dsh-d1/adapters
 */
import { assertIdentifier, tokenEnvName, type ResolvedD1Database } from './config.js'

/** Query result: column names + rows (arrays of values). */
export interface QueryResult {
  columns: string[]
  rows: unknown[][]
}

/** Column info for a table. */
export interface ColumnInfo {
  name: string
  type: string
  notNull: boolean
  primaryKey: boolean
}

/** One statement's result inside a D1 `/raw` API response. */
interface D1StatementResult {
  columns: string[]
  rows: unknown[][]
  success: boolean
  meta: Record<string, unknown>
}

/** Per-adapter timeouts (ms). */
export interface D1AdapterTimeouts {
  queryTimeoutMs: number
  execTimeoutMs: number
}

/** Per-call options: the caller's cancellation signal (forwarded to fetch). */
export interface CallOptions {
  signal?: AbortSignal
}

const CF_API_BASE = 'https://api.cloudflare.com/client/v4'

/** Printable ASCII only: a token with whitespace/control characters is a paste error, never sent. */
const TOKEN_RE = /^[\x21-\x7E]+$/

/** Quote a SQLite identifier (`"` → `""`). Shared by the adapter and the tools. */
export function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"'
}

/** Drop request-path echoes (account / database ids) from an upstream message. */
function scrubPaths(message: string): string {
  return message.replace(/\/accounts\/[^/\s]+/g, '/accounts/<redacted>').replace(/\/database\/[^/\s]+/g, '/database/<redacted>')
}

/** Redact a message from any source: the token (wherever it appears) and request-path ids. */
function redact(message: string, token: string): string {
  return scrubPaths(token === '' ? message : message.split(token).join('<redacted>'))
}

/** Narrow the untrusted D1 JSON response; throw a redacted error on failure. */
function parseStatements(payload: unknown, httpStatus: number, token: string): D1StatementResult[] {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('D1 API returned a non-object response (HTTP ' + httpStatus + ').')
  }
  const body = payload as Record<string, unknown>
  if (body.success !== true) {
    const errs = Array.isArray(body.errors) ? body.errors : []
    const msg = errs
      .map((e) => (typeof e === 'object' && e !== null && 'message' in e ? String((e as Record<string, unknown>).message) : String(e)))
      .filter((m) => m !== '')
      .join('; ')
    // The body is untrusted: an intercepting proxy could echo request headers, so it is token-scrubbed too.
    throw new Error('D1 query failed (HTTP ' + httpStatus + '): ' + (msg !== '' ? redact(msg, token) : 'unknown error'))
  }
  const result = Array.isArray(body.result) ? body.result : []
  return result.map((raw) => {
    const rec = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const results = (typeof rec.results === 'object' && rec.results !== null ? rec.results : {}) as Record<string, unknown>
    const columns = Array.isArray(results.columns) ? results.columns.map((c) => String(c)) : []
    const rows = Array.isArray(results.rows) ? results.rows.map((row) => (Array.isArray(row) ? row : [row])) : []
    return {
      columns,
      rows,
      success: rec.success === true,
      meta: typeof rec.meta === 'object' && rec.meta !== null ? (rec.meta as Record<string, unknown>) : {},
    }
  })
}

/** D1 HTTP adapter (stateless). */
export class D1Adapter {
  readonly engine = 'd1' as const

  constructor(
    private readonly db: ResolvedD1Database,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly timeouts: D1AdapterTimeouts = { queryTimeoutMs: 60000, execTimeoutMs: 120000 },
  ) {}

  /** Resolve the API token from env at call time. Never stored on the adapter. */
  private resolveToken(): string {
    const perDb = this.env[tokenEnvName(this.db.name)]
    const token =
      typeof perDb === 'string' && perDb.trim() !== ''
        ? perDb.trim()
        : typeof this.env.CLOUDFLARE_API_TOKEN === 'string'
          ? this.env.CLOUDFLARE_API_TOKEN.trim()
          : ''
    if (token === '') {
      throw new Error(
        'missing Cloudflare API token for database "' +
          this.db.name +
          '". Set ' +
          tokenEnvName(this.db.name) +
          ' or CLOUDFLARE_API_TOKEN in the environment (never in config).',
      )
    }
    if (!TOKEN_RE.test(token)) {
      throw new Error(
        'the Cloudflare API token for database "' +
          this.db.name +
          '" contains whitespace or control characters; check the value of ' +
          tokenEnvName(this.db.name) +
          ' / CLOUDFLARE_API_TOKEN.',
      )
    }
    return token
  }

  private resolveAccount(): string {
    const account = this.db.accountId.trim()
    if (account === '') {
      throw new Error(
        'missing Cloudflare account id for database "' +
          this.db.name +
          '". Set accountId in config or CLOUDFLARE_ACCOUNT_ID in the environment.',
      )
    }
    return account
  }

  private async callAll(sql: string, params: unknown[] | undefined, timeoutMs: number, options: CallOptions = {}): Promise<D1StatementResult[]> {
    const caller = options.signal
    if (caller?.aborted) throw new Error('D1 request for "' + this.db.name + '" cancelled before it started.')
    const token = this.resolveToken()
    const account = this.resolveAccount()
    const url = CF_API_BASE + '/accounts/' + encodeURIComponent(account) + '/d1/database/' + encodeURIComponent(this.db.databaseId) + '/raw'
    const timer = new AbortController()
    const handle = setTimeout(() => timer.abort(), timeoutMs)
    const signal = caller !== undefined ? AbortSignal.any([timer.signal, caller]) : timer.signal
    let status = 0
    let text = ''
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(params !== undefined && params.length > 0 ? { sql, params } : { sql }),
        signal,
      })
      status = response.status
      // The timer stays armed through the body read: a stalled body must time out too.
      text = await response.text()
    } catch (error) {
      throw new Error('D1 request failed for "' + this.db.name + '": ' + this.describeFailure(error, token, timeoutMs, caller, timer.signal))
    } finally {
      clearTimeout(handle)
    }
    let payload: unknown
    try {
      payload = text === '' ? {} : JSON.parse(text)
    } catch {
      throw new Error('D1 API returned invalid JSON (HTTP ' + status + ').')
    }
    return parseStatements(payload, status, token)
  }

  /**
   * Redacted failure reason: never the token, never request headers. Aborts are
   * classified by signal state (the authoritative fact), not by the thrown value,
   * so a non-Error abort reason cannot produce "[object Object]".
   */
  private describeFailure(error: unknown, token: string, timeoutMs: number, caller: AbortSignal | undefined, timer: AbortSignal): string {
    if (caller?.aborted === true) return 'cancelled by the caller'
    if (timer.aborted) return 'request timed out after ' + timeoutMs + 'ms'
    const cause = error instanceof Error && typeof error.cause === 'object' && error.cause !== null ? (error.cause as Record<string, unknown>) : undefined
    const code = cause !== undefined && typeof cause.code === 'string' ? cause.code : undefined
    const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : 'unexpected failure'
    return (code !== undefined ? code + ': ' : '') + redact(raw, token)
  }

  /** Last statement's result (D1 returns one entry per statement). */
  private async callOne(sql: string, params: unknown[] | undefined, timeoutMs: number, options: CallOptions): Promise<D1StatementResult> {
    const statements = await this.callAll(sql, params, timeoutMs, options)
    return statements.length > 0 ? statements[statements.length - 1] : { columns: [], rows: [], success: true, meta: {} }
  }

  async query(sql: string, params?: unknown[], options: CallOptions = {}): Promise<QueryResult> {
    const { columns, rows } = await this.callOne(sql, params, this.timeouts.queryTimeoutMs, options)
    return { columns, rows }
  }

  async exec(sql: string, params?: unknown[], options: CallOptions = {}): Promise<number> {
    const statements = await this.callAll(sql, params, this.timeouts.execTimeoutMs, options)
    let changes = 0
    for (const statement of statements) {
      const n = Number(statement.meta.changes ?? 0)
      if (Number.isFinite(n)) changes += n // a hostile/odd meta must not turn the count into NaN
    }
    return changes
  }

  /** User tables, excluding SQLite's `sqlite_*` and D1's `_cf_*` internals (literal underscores). */
  async listTables(options: CallOptions = {}): Promise<string[]> {
    const { rows } = await this.callOne(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name",
      undefined,
      this.timeouts.queryTimeoutMs,
      options,
    )
    return rows.map((row) => String(row[0]))
  }

  /** Columns of a table via `PRAGMA table_info`; returns [] when the table does not exist. */
  async describeTable(table: string, options: CallOptions = {}): Promise<ColumnInfo[]> {
    const name = assertIdentifier(table, 'table name')
    const { columns, rows } = await this.callOne('PRAGMA table_info(' + quoteIdent(name) + ')', undefined, this.timeouts.queryTimeoutMs, options)
    const col = (row: unknown[], key: string): unknown => row[columns.indexOf(key)]
    return rows.map((row) => ({
      name: String(col(row, 'name')),
      type: String(col(row, 'type') ?? ''),
      notNull: Number(col(row, 'notnull')) === 1,
      primaryKey: Number(col(row, 'pk')) === 1,
    }))
  }

  /**
   * Database size in bytes. D1 blocks `PRAGMA page_count` (SQLITE_AUTH), so the
   * size is read from `meta.size_after`, which D1 returns on every query. Returns
   * -1 if the field is absent.
   */
  async databaseSize(options: CallOptions = {}): Promise<number> {
    const { meta } = await this.callOne('SELECT 1', undefined, this.timeouts.queryTimeoutMs, options)
    const size = Number(meta.size_after ?? -1)
    return Number.isFinite(size) ? size : -1
  }

  async ping(options: CallOptions = {}): Promise<void> {
    await this.callOne('SELECT 1', undefined, this.timeouts.queryTimeoutMs, options)
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function -- HTTP is stateless; nothing to close.
  async close(): Promise<void> {}
}

/** Build an adapter for a resolved database binding. */
export function createAdapter(db: ResolvedD1Database, env: NodeJS.ProcessEnv = process.env, timeouts?: D1AdapterTimeouts): D1Adapter {
  return new D1Adapter(db, env, timeouts)
}
