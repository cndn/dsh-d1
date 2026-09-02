/**
 * Six model-facing Cloudflare D1 tools:
 * d1_list / d1_query / d1_exec / d1_schema / d1_stats / d1_health.
 *
 * Every tool forwards the harness's `exec.signal` into the adapter so that a
 * cancelled or timed-out call actually aborts the in-flight D1 request(s).
 *
 * @module dsh-d1/tools
 */
import { createAdapter, quoteIdent, type D1Adapter } from './adapters.js'
import { type ResolvedD1Config } from './config.js'

/** A model-visible content block. */
export interface ContentBlock {
  type: 'text'
  text: string
}

/** The raw tool definition passed to ctx.tools.register. */
export interface D1ToolDefinition {
  name: string
  description: string
  parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): ContentBlock[]
  }
  execute(args: unknown, exec: unknown): Promise<unknown>
  timeoutMs?: number
  /** Opt-in to the harness's parallel tool-call scheduling (reads only). */
  isConcurrencySafe?(args: unknown): boolean
}

interface ParamSpec {
  type?: string
  description?: string
  required?: boolean
  items?: unknown
}

function compileParameters(spec: Record<string, ParamSpec>): { type: 'object'; properties: Record<string, unknown>; required?: string[] } {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, prop] of Object.entries(spec)) {
    if (prop.required === true) required.push(key)
    const node: Record<string, unknown> = {}
    if (typeof prop.type === 'string') node.type = prop.type
    if (typeof prop.description === 'string') node.description = prop.description
    if (prop.items !== undefined) node.items = prop.items
    properties[key] = node
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/** The harness's cancellation signal from the second execute() argument, when present. */
function signalOf(exec: unknown): AbortSignal | undefined {
  const signal = asRecord(exec).signal
  return signal instanceof AbortSignal ? signal : undefined
}

/**
 * Run a tool body under the harness's cancellation signal. When the harness
 * aborted the call, the body settles with `empty` instead of throwing: dsh
 * classifies a body that resolves after its signal aborted as its canonical
 * ABORTED outcome (and discards the value), whereas a thrown error would
 * surface as a generic tool error. Any other failure propagates unchanged.
 */
async function cancellable<T>(signal: AbortSignal | undefined, empty: T, body: () => Promise<T>): Promise<T> {
  try {
    return await body()
  } catch (error) {
    if (signal?.aborted === true) return empty
    throw error
  }
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function requiredString(args: Record<string, unknown>, key: string, label: string): string {
  const value = optionalString(args, key)
  if (value === undefined) throw new Error(label + ' (parameter ' + key + ') is required and must be a non-empty string.')
  return value
}

/** Optional bound-parameter array (D1 supports `?` placeholders). */
function optionalParams(args: Record<string, unknown>): unknown[] | undefined {
  const value = args.params
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error('params must be an array of bind values.')
  return value
}

// ---------- read-only guard (lexical, SQLite-accurate) ----------

/**
 * Blank out string literals, quoted identifiers and comments, keeping real
 * keywords, parentheses and semicolons. Follows SQLite's tokenizer: a quote is
 * escaped only by doubling it — backslash is an ordinary character — so a
 * payload like `'\'; DROP TABLE t; --'` cannot desynchronise the scan.
 */
export function stripSqlNoise(sql: string): string {
  return lexSql(sql).clean
}

/** What the lexer was still inside when the input ended (the statement is incomplete). */
export type Unterminated = 'string literal' | 'quoted identifier' | 'block comment'

/** De-noised text plus whether the input ended inside an open construct. */
export interface LexedSql {
  clean: string
  unterminated: Unterminated | null
}

/**
 * The lexer behind {@link stripSqlNoise}. Reports an unterminated string /
 * identifier / block comment so callers can reject incomplete input instead
 * of forwarding it (a dangling `/*` would otherwise swallow anything appended
 * after the statement, such as the row-cap wrapper).
 */
export function lexSql(sql: string): LexedSql {
  let out = ''
  let i = 0
  let unterminated: Unterminated | null = null
  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (ch === '-' && next === '-') {
      i += 2
      while (i < sql.length && sql[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      let closed = false
      while (i < sql.length) {
        if (sql[i] === '*' && sql[i + 1] === '/') {
          i += 2
          closed = true
          break
        }
        i += 1
      }
      if (!closed) unterminated = 'block comment'
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      out += ' '
      i += 1
      let closed = false
      while (i < sql.length) {
        if (sql[i] === ch) {
          if (sql[i + 1] === ch) {
            i += 2 // doubled quote inside the literal
            continue
          }
          i += 1
          closed = true
          break
        }
        i += 1
      }
      if (!closed) unterminated = ch === "'" ? 'string literal' : 'quoted identifier'
      continue
    }
    if (ch === '[') {
      out += ' '
      i += 1
      while (i < sql.length && sql[i] !== ']') i += 1
      if (i >= sql.length) unterminated = 'quoted identifier'
      i += 1
      continue
    }
    out += ch
    i += 1
  }
  return { clean: out, unterminated }
}

/** Parentheses must balance and never close more than they opened (so the statement cannot escape a wrapping subquery). */
function assertBalancedParens(clean: string): void {
  let depth = 0
  for (const ch of clean) {
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth < 0) throw new Error('d1_query: unbalanced parentheses (a ")" closes more than was opened).')
    }
  }
  if (depth !== 0) throw new Error('d1_query: unbalanced parentheses (' + depth + ' unclosed).')
}

/** Statement families d1_query accepts. `select` results are row-capped with a LIMIT wrapper. */
export type ReadKind = 'select' | 'pragma' | 'explain'

/** A validated read statement: the SQL to send (trailing `;` removed) and its kind. */
export interface ReadQuery {
  sql: string
  kind: ReadKind
}

const READ_ONLY_MESSAGE = 'd1_query only accepts read-only statements (SELECT / VALUES / WITH … SELECT / PRAGMA / EXPLAIN). Use d1_exec for writes.'

/** PRAGMAs that take a table/index argument and only read. Anything else with an argument may be a setter. */
const ARG_PRAGMAS = new Set(['table_info', 'table_xinfo', 'table_list', 'index_list', 'index_info', 'index_xinfo', 'foreign_key_list', 'foreign_key_check', 'quick_check', 'integrity_check'])

/** Argument-less PRAGMAs that modify the database or its storage. */
const SIDE_EFFECT_PRAGMAS = new Set(['optimize', 'shrink_memory', 'wal_checkpoint', 'incremental_vacuum'])

function headKeyword(text: string): string {
  return /^([a-z_]+)/i.exec(text)?.[1]?.toLowerCase() ?? ''
}

function assertNoUnsafeFunctions(clean: string): void {
  if (/\bload_extension\s*\(/i.test(clean)) throw new Error('d1_query does not accept load_extension().')
}

/**
 * Walk the CTE list of a de-noised `WITH` statement and return the main
 * statement that follows it. Each CTE body must itself be a query.
 */
function withMainStatement(stmt: string): string {
  let i = 4 // past "with"
  const skipWs = (): void => {
    while (i < stmt.length && /\s/.test(stmt[i])) i += 1
  }
  const word = (): string => {
    const match = /^[A-Za-z0-9_$]+/.exec(stmt.slice(i))
    if (match === null) return ''
    i += match[0].length
    return match[0].toLowerCase()
  }
  const skipParens = (): string => {
    const start = i
    let depth = 0
    do {
      if (stmt[i] === '(') depth += 1
      else if (stmt[i] === ')') depth -= 1
      i += 1
    } while (i < stmt.length && depth > 0)
    if (depth !== 0) throw new Error('d1_query: unbalanced parentheses in WITH clause.')
    return stmt.slice(start + 1, i - 1)
  }
  skipWs()
  if (/^recursive\b/i.test(stmt.slice(i))) {
    word()
    skipWs()
  }
  for (;;) {
    skipWs()
    word() // the CTE name (blank if it was quoted — quoted identifiers are blanked out)
    skipWs()
    if (stmt[i] === '(') {
      skipParens() // optional column list
      skipWs()
    }
    if (word() !== 'as') throw new Error('d1_query: unrecognised WITH clause (expected AS).')
    skipWs()
    const materialized = /^(not\s+)?materialized\b/i.exec(stmt.slice(i))
    if (materialized !== null) {
      i += materialized[0].length
      skipWs()
    }
    if (stmt[i] !== '(') throw new Error('d1_query: unrecognised WITH clause (expected a parenthesised query).')
    const bodyHead = headKeyword(skipParens().trim())
    if (bodyHead !== 'select' && bodyHead !== 'values' && bodyHead !== 'with') {
      throw new Error('d1_query: WITH clause bodies must be read-only SELECT queries; found ' + bodyHead.toUpperCase() + ' (a write keyword). Use d1_exec for writes.')
    }
    skipWs()
    if (stmt[i] === ',') {
      i += 1
      continue
    }
    break
  }
  return stmt.slice(i).trim()
}

function checkPragma(stmt: string): void {
  const match = /^pragma\s+(?:[A-Za-z0-9_$]+\s*\.\s*)?([A-Za-z0-9_$]+)\s*([\s\S]*)$/i.exec(stmt)
  if (match === null) throw new Error('d1_query: unrecognised PRAGMA form.')
  const name = match[1].toLowerCase()
  const rest = match[2].trim()
  if (rest === '') {
    if (SIDE_EFFECT_PRAGMAS.has(name)) throw new Error('d1_query does not accept PRAGMA ' + name + ' (it modifies the database); use d1_exec.')
    return
  }
  if (rest.startsWith('=')) throw new Error('d1_query does not accept assigning PRAGMA writes (e.g. PRAGMA foreign_keys = ON); use d1_exec.')
  if (rest.startsWith('(')) {
    if (!ARG_PRAGMAS.has(name)) {
      throw new Error('d1_query does not accept PRAGMA ' + name + '(…): only introspection PRAGMAs take an argument here (' + [...ARG_PRAGMAS].join(', ') + '). PRAGMA name(value) sets a value; use d1_exec.')
    }
    return
  }
  throw new Error('d1_query: unrecognised PRAGMA form.')
}

/** Classify one de-noised statement, throwing for anything that is not a read. */
function checkReadStatement(stmt: string): ReadKind {
  switch (headKeyword(stmt)) {
    case 'select':
    case 'values':
      assertNoUnsafeFunctions(stmt)
      return 'select'
    case 'with': {
      const main = headKeyword(withMainStatement(stmt))
      if (main !== 'select' && main !== 'values') {
        throw new Error('d1_query does not accept WITH … ' + main.toUpperCase() + ' (a write keyword); use d1_exec for writes.')
      }
      assertNoUnsafeFunctions(stmt)
      return 'select'
    }
    case 'explain': {
      const rest = stmt.replace(/^explain\s+(query\s+plan\s+)?/i, '')
      if (rest === stmt) throw new Error(READ_ONLY_MESSAGE)
      checkReadStatement(rest)
      return 'explain'
    }
    case 'pragma':
      checkPragma(stmt)
      return 'pragma'
    default:
      throw new Error(READ_ONLY_MESSAGE)
  }
}

/**
 * Validate a read-only query. After de-noising, exactly one statement is
 * allowed and it must be SELECT / VALUES / WITH … SELECT / PRAGMA (read forms
 * only) / EXPLAIN of one of those. In SQLite none of these can modify data, so
 * no interior keyword blacklist is needed — column names like `release` or
 * `set` are fine. Returns the SQL to send (trailing `;` removed) and its kind.
 */
export function classifyReadQuery(sql: string): ReadQuery {
  const trimmed = sql.trim()
  const lexed = lexSql(trimmed)
  if (lexed.unterminated !== null) throw new Error('d1_query: the statement ends inside an unterminated ' + lexed.unterminated + '.')
  const statements = lexed.clean
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '')
  if (statements.length === 0) throw new Error(READ_ONLY_MESSAGE)
  if (statements.length > 1) throw new Error('d1_query accepts a single statement at a time.')
  assertBalancedParens(statements[0])
  const kind = checkReadStatement(statements[0])
  return { sql: trimmed.replace(/;+\s*$/, '').trim(), kind }
}

/** {@link classifyReadQuery} returning only the SQL (throws for writes). */
export function assertReadQuery(sql: string): string {
  return classifyReadQuery(sql).sql
}

/**
 * Row-cap a SELECT by wrapping it: `SELECT * FROM (<sql>) LIMIT maxRows+1`.
 * The extra row tells us whether the result was truncated. Newlines keep a
 * trailing `--` comment in the inner query from swallowing the wrapper.
 */
export function withRowCap(sql: string, maxRows: number): string {
  return 'SELECT * FROM (\n' + sql + '\n) LIMIT ' + (maxRows + 1)
}

// ---------- output schemas ----------

// `required` lists the keys every result (including the empty value returned on
// cancellation) always carries, so Code Mode SDK types are not all-optional.

const querySchema = {
  type: 'object',
  properties: {
    database: { type: 'string' },
    columns: { type: 'array', items: { type: 'string' } },
    rows: { type: 'array', items: { type: 'array', items: {} } },
    rowCount: { type: 'integer' },
    truncated: { type: 'boolean' },
    maxRows: { type: 'integer' },
    format: { type: 'string' },
    formatted: { type: 'string' },
  },
  required: ['database', 'columns', 'rows', 'rowCount', 'truncated', 'maxRows'],
  additionalProperties: true,
}

const execSchema = {
  type: 'object',
  properties: {
    database: { type: 'string' },
    changes: { type: 'integer' },
    readOnly: { type: 'boolean' },
  },
  required: ['database', 'changes', 'readOnly'],
  additionalProperties: true,
}

const listSchema = {
  type: 'object',
  properties: {
    databases: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, databaseId: { type: 'string' }, ok: { type: 'boolean' }, error: { type: 'string' } },
        required: ['name', 'databaseId', 'ok'],
        additionalProperties: true,
      },
    },
  },
  required: ['databases'],
  additionalProperties: true,
}

const schemaToolSchema = {
  type: 'object',
  properties: {
    database: { type: 'string' },
    table: { type: 'string' },
    tables: { type: 'array', items: { type: 'string' } },
    columns: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, type: { type: 'string' }, notNull: { type: 'boolean' }, primaryKey: { type: 'boolean' } },
        required: ['name', 'type', 'notNull', 'primaryKey'],
        additionalProperties: true,
      },
    },
  },
  required: ['database', 'tables', 'columns'],
  additionalProperties: true,
}

const statsSchema = {
  type: 'object',
  properties: {
    database: { type: 'string' },
    tableCount: { type: 'integer' },
    tables: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, rowCount: { type: 'integer' }, error: { type: 'string' } },
        required: ['name'],
        additionalProperties: true,
      },
    },
    sizeBytes: { type: 'integer' },
  },
  required: ['database', 'tableCount', 'tables', 'sizeBytes'],
  additionalProperties: true,
}

const healthSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    plugin: { type: 'string' },
    databases: { type: 'array', items: { type: 'object', additionalProperties: true } },
    readOnly: { type: 'boolean' },
    writeApproval: { type: 'boolean' },
    maxRows: { type: 'integer' },
    queryTimeoutMs: { type: 'integer' },
    execTimeoutMs: { type: 'integer' },
    configError: { type: 'string' },
  },
  required: ['ok', 'plugin', 'databases', 'readOnly', 'writeApproval', 'maxRows', 'queryTimeoutMs', 'execTimeoutMs'],
  additionalProperties: true,
}

// ---------- output helpers ----------

/** One cell as text for the model-facing table render. */
function cellText(cell: unknown): string {
  if (cell === null || cell === undefined) return 'NULL'
  if (typeof cell === 'object') return JSON.stringify(cell)
  return String(cell)
}

/**
 * Query result → CSV text (RFC 4180-style escaping). String cells that a
 * spreadsheet would evaluate as a formula (`=`, `+`, `-`, `@`, tab, CR prefix)
 * are neutralised with a leading apostrophe; numbers are left untouched.
 */
export function toCsv(columns: string[], rows: unknown[][]): string {
  const escape = (cell: unknown): string => {
    if (cell === null || cell === undefined) return ''
    let text = typeof cell === 'object' ? JSON.stringify(cell) : String(cell)
    const formula = typeof cell === 'string' && /^[=+\-@\t\r]/.test(text)
    if (formula) text = "'" + text
    return formula || /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text
  }
  const lines = [columns.map(escape).join(',')]
  for (const row of rows) lines.push(row.map(escape).join(','))
  return lines.join('\n')
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

/** Quote a SQLite string literal (`'` → `''`). */
function quoteString(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'"
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Run `fn` over `items` with at most `limit` in flight; never rejects early (fn handles its own errors). */
async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next]
      next += 1
      await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

/** Tables per batched COUNT(*) statement (well under SQLite's compound-select limit). */
const STATS_BATCH = 25
/** Parallel per-table COUNT(*) requests when a batch has to be split. */
const STATS_FALLBACK_CONCURRENCY = 8

/**
 * Build the six tools. Adapters are created lazily and cached by database name.
 * `configError` (when the plugin config was rejected at boot) is surfaced by d1_health.
 */
export function buildD1Tools(config: ResolvedD1Config, env: NodeJS.ProcessEnv = process.env, configError?: string): { tools: D1ToolDefinition[]; adapters: Map<string, D1Adapter> } {
  const cfg = config
  const adapters = new Map<string, D1Adapter>()
  const readsAreConcurrencySafe = (): boolean => true

  const getAdapter = (name: string | undefined): { adapter: D1Adapter; name: string } => {
    if (cfg.databases.length === 0) {
      throw new Error('no D1 databases are configured. Add one under "databases" in the plugin config (see README).' + (configError !== undefined ? ' Config error: ' + configError : ''))
    }
    const target = name ?? cfg.databases[0].name
    const db = cfg.databases.find((item) => item.name.toLowerCase() === target.toLowerCase())
    if (db === undefined) {
      throw new Error('no database named ' + target + '. Use d1_list to see configured databases.')
    }
    let adapter = adapters.get(db.name)
    if (adapter === undefined) {
      adapter = createAdapter(db, env, { queryTimeoutMs: cfg.queryTimeoutMs, execTimeoutMs: cfg.execTimeoutMs })
      adapters.set(db.name, adapter)
    }
    return { adapter, name: db.name }
  }

  /** Probe every database concurrently; never rejects. */
  const pingAll = async (signal: AbortSignal | undefined): Promise<Array<Record<string, unknown>>> =>
    Promise.all(
      cfg.databases.map(async (db) => {
        const entry: Record<string, unknown> = { name: db.name, databaseId: db.databaseId }
        try {
          await getAdapter(db.name).adapter.ping({ signal })
          entry.ok = true
          entry.error = ''
        } catch (error) {
          entry.ok = false
          entry.error = error instanceof Error ? error.message : String(error)
        }
        return entry
      }),
    )

  const d1List: D1ToolDefinition = {
    name: 'd1_list',
    description: 'List the configured Cloudflare D1 databases and probe each for connectivity (SELECT 1). Returns name, database id and health.',
    parameters: compileParameters({}),
    output: {
      schema: listSchema,
      render: (_args, value) => {
        const rec = asRecord(value)
        const databases = Array.isArray(rec.databases) ? rec.databases : []
        const lines = [databases.length + ' D1 database(s):']
        for (const item of databases) {
          const c = asRecord(item)
          lines.push('- ' + c.name + ' (' + String(c.databaseId) + ')' + (c.ok === true ? ' ✅' : ' ❌ ' + String(c.error ?? '')))
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(_args: unknown, exec: unknown) {
      return { databases: await pingAll(signalOf(exec)) }
    },
    timeoutMs: cfg.queryTimeoutMs,
    isConcurrencySafe: readsAreConcurrencySafe,
  }

  const d1Query: D1ToolDefinition = {
    name: 'd1_query',
    description:
      'Run one read-only SQL statement against a D1 database: SELECT / VALUES / WITH … SELECT / introspection PRAGMA / EXPLAIN. Writes, PRAGMA setters and multi-statement input are rejected. Supports bound params (? placeholders). database defaults to the first configured. SELECTs are row-capped at maxRows via a LIMIT wrapper: rowCount is the number of rows returned and truncated=true means more rows exist (add your own LIMIT/WHERE to page). INTEGER values above 2^53 lose precision in JSON — select them as CAST(col AS TEXT). Use d1_exec for writes.',
    parameters: compileParameters({
      sql: { type: 'string', required: true, description: 'A single read-only SQL statement.' },
      params: { type: 'array', items: {}, description: 'Optional bind values for ? placeholders.' },
      database: { type: 'string', description: 'Database name (optional; defaults to the first configured).' },
      format: { type: 'string', description: 'Output format: table (default) / csv / json. csv and json also return a formatted text blob.' },
    }),
    output: {
      schema: querySchema,
      render: (_args, value) => {
        const rec = asRecord(value)
        if (typeof rec.formatted === 'string' && rec.formatted !== '') {
          const preview = rec.formatted.length > 4000 ? rec.formatted.slice(0, 4000) + '\n…(preview truncated)' : rec.formatted
          return [{ type: 'text', text: rec.rowCount + ' row(s) (' + String(rec.format) + ')' + (rec.truncated === true ? ', more exist (capped at ' + rec.maxRows + ')' : '') + ':\n' + preview }]
        }
        const rows = Array.isArray(rec.rows) ? rec.rows : []
        const lines = [
          rec.rowCount +
            ' row(s)' +
            (rec.truncated === true ? ' (capped at ' + rec.maxRows + '; more exist)' : '') +
            ', columns: ' +
            (Array.isArray(rec.columns) ? rec.columns.join(', ') : ''),
        ]
        for (const row of rows.slice(0, 20)) {
          lines.push('- ' + (Array.isArray(row) ? row.map(cellText).join(' | ') : cellText(row)))
        }
        if (rows.length > 20) lines.push('…showing first 20 rows')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(rawArgs: unknown, exec: unknown) {
      const args = asRecord(rawArgs)
      const signal = signalOf(exec)
      const { sql, kind } = classifyReadQuery(requiredString(args, 'sql', 'SQL statement'))
      const params = optionalParams(args)
      const { adapter, name } = getAdapter(optionalString(args, 'database'))
      const format = optionalString(args, 'format')?.toLowerCase() ?? 'table'
      const empty = { database: name, columns: [], rows: [], rowCount: 0, truncated: false, maxRows: cfg.maxRows }
      return cancellable(signal, empty, async () => {
        const capped = kind === 'select'
        const result = await adapter.query(capped ? withRowCap(sql, cfg.maxRows) : sql, params, { signal })
        const rows = result.rows.slice(0, cfg.maxRows)
        const base = {
          database: name,
          columns: result.columns,
          rows,
          rowCount: rows.length,
          truncated: result.rows.length > cfg.maxRows,
          maxRows: cfg.maxRows,
        }
        if (format === 'csv') return { ...base, format, formatted: toCsv(result.columns, rows) }
        if (format === 'json') {
          const objects = rows.map((row) => Object.fromEntries(result.columns.map((column, i) => [column, row[i]])))
          return { ...base, format, formatted: JSON.stringify(objects, null, 2) }
        }
        return base
      })
    },
    timeoutMs: cfg.queryTimeoutMs,
    isConcurrencySafe: readsAreConcurrencySafe,
  }

  const d1Exec: D1ToolDefinition = {
    name: 'd1_exec',
    description:
      'Run a write or DDL statement against a D1 database (INSERT / UPDATE / DELETE / CREATE / ALTER / DROP …). Disabled while the plugin is in readOnly mode; otherwise every call pauses for interactive approval (writeApproval). Supports bound params. Returns the number of rows changed. Cancelling a call only abandons the HTTP request: a statement D1 has already received may still be applied, so verify with d1_query before retrying.',
    parameters: compileParameters({
      sql: { type: 'string', required: true, description: 'Write/DDL SQL.' },
      params: { type: 'array', items: {}, description: 'Optional bind values for ? placeholders.' },
      database: { type: 'string', description: 'Database name (optional; defaults to the first configured).' },
    }),
    output: {
      schema: execSchema,
      render: (_args, value) => {
        const rec = asRecord(value)
        return [{ type: 'text', text: 'done (' + rec.database + '): ' + rec.changes + ' row(s) changed.' }]
      },
    },
    async execute(rawArgs: unknown, exec: unknown) {
      if (cfg.readOnly) {
        throw new Error('readOnly=true, so d1_exec is disabled. Set readOnly:false in the plugin config and restart to allow writes.')
      }
      const args = asRecord(rawArgs)
      const signal = signalOf(exec)
      const sql = requiredString(args, 'sql', 'SQL statement')
      const params = optionalParams(args)
      const { adapter, name } = getAdapter(optionalString(args, 'database'))
      return cancellable(signal, { database: name, changes: 0, readOnly: false }, async () => {
        const changes = await adapter.exec(sql, params, { signal })
        return { database: name, changes, readOnly: false }
      })
    },
    timeoutMs: cfg.execTimeoutMs,
  }

  const d1Schema: D1ToolDefinition = {
    name: 'd1_schema',
    description: 'Inspect a D1 database schema: with no table, list all user tables (views and internal tables excluded); with a table name, return its columns (name/type/notNull/primaryKey) via PRAGMA table_info. Errors if the table does not exist.',
    parameters: compileParameters({
      table: { type: 'string', description: 'Table name (optional; omit to list all tables).' },
      database: { type: 'string', description: 'Database name (optional; defaults to the first configured).' },
    }),
    output: {
      schema: schemaToolSchema,
      render: (_args, value) => {
        const rec = asRecord(value)
        const columns = Array.isArray(rec.columns) ? rec.columns : []
        if (typeof rec.table === 'string' && rec.table !== '') {
          const lines = ['columns of ' + rec.table + ':']
          for (const item of columns) {
            const c = asRecord(item)
            lines.push('- ' + c.name + ' ' + c.type + (c.primaryKey === true ? ' (pk)' : '') + (c.notNull === true ? ' (not null)' : ''))
          }
          return [{ type: 'text', text: lines.join('\n') }]
        }
        const tables = Array.isArray(rec.tables) ? rec.tables : []
        return [{ type: 'text', text: tables.length + ' table(s): ' + tables.join(', ') }]
      },
    },
    async execute(rawArgs: unknown, exec: unknown) {
      const args = asRecord(rawArgs)
      const signal = signalOf(exec)
      const { adapter, name } = getAdapter(optionalString(args, 'database'))
      const table = optionalString(args, 'table')
      return cancellable(signal, { database: name, tables: [], columns: [] }, async () => {
        if (table !== undefined) {
          const columns = await adapter.describeTable(table, { signal })
          if (columns.length === 0) throw new Error('no such table: ' + table + ' in database ' + name + ' (call d1_schema without a table to list tables).')
          return { database: name, table, columns, tables: [] }
        }
        const tables = await adapter.listTables({ signal })
        return { database: name, tables, columns: [] }
      })
    },
    timeoutMs: cfg.queryTimeoutMs,
    isConcurrencySafe: readsAreConcurrencySafe,
  }

  const d1Stats: D1ToolDefinition = {
    name: 'd1_stats',
    description: "Overview stats for a D1 database: table count, per-table row counts (COUNT(*), a full scan billed as rows_read) and database size in bytes (from D1's meta.size_after; -1 if unavailable). database defaults to the first configured.",
    parameters: compileParameters({
      database: { type: 'string', description: 'Database name (optional; defaults to the first configured).' },
    }),
    output: {
      schema: statsSchema,
      render: (_args, value) => {
        const rec = asRecord(value)
        const tables = Array.isArray(rec.tables) ? rec.tables : []
        const lines = [
          'database ' +
            rec.database +
            ': ' +
            tables.length +
            ' table(s)' +
            (typeof rec.sizeBytes === 'number' && rec.sizeBytes >= 0 ? ', size ' + formatBytes(rec.sizeBytes) : '') +
            '.',
        ]
        for (const item of tables.slice(0, 30)) {
          const t = asRecord(item)
          lines.push('- ' + t.name + ': ' + (typeof t.rowCount === 'number' ? t.rowCount + ' rows' : 'unknown' + (t.error ? ' (' + t.error + ')' : '')))
        }
        if (tables.length > 30) lines.push('…showing first 30 tables')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(rawArgs: unknown, exec: unknown) {
      const args = asRecord(rawArgs)
      const signal = signalOf(exec)
      const { adapter, name } = getAdapter(optionalString(args, 'database'))
      return cancellable(signal, { database: name, tableCount: 0, tables: [], sizeBytes: -1 }, async () => {
        let sizeBytes = -1
        try {
          sizeBytes = await adapter.databaseSize({ signal })
        } catch (error) {
          if (signal?.aborted) throw error
          sizeBytes = -1
        }
        const names = await adapter.listTables({ signal })
        const counts = new Map<string, number | { error: string }>()
        const countOne = async (table: string): Promise<void> => {
          try {
            const result = await adapter.query('SELECT COUNT(*) AS n FROM ' + quoteIdent(table), undefined, { signal })
            counts.set(table, Number(result.rows[0]?.[0] ?? 0))
          } catch (error) {
            if (signal?.aborted) throw error
            counts.set(table, { error: error instanceof Error ? error.message : String(error) })
          }
        }
        for (const batch of chunk(names, STATS_BATCH)) {
          // One round trip per batch instead of one per table.
          const sql = batch.map((table) => 'SELECT ' + quoteString(table) + ' AS name, COUNT(*) AS n FROM ' + quoteIdent(table)).join(' UNION ALL ')
          try {
            const result = await adapter.query(sql, undefined, { signal })
            for (const row of result.rows) counts.set(String(row[0]), Number(row[1] ?? 0))
            await mapLimit(batch.filter((table) => !counts.has(table)), STATS_FALLBACK_CONCURRENCY, countOne)
          } catch (error) {
            if (signal?.aborted) throw error
            // Isolate the failing table; run the fallback concurrently so one bad batch costs one round, not N.
            await mapLimit(batch, STATS_FALLBACK_CONCURRENCY, countOne)
          }
        }
        const tables = names.map((table) => {
          const count = counts.get(table)
          return typeof count === 'number' ? { name: table, rowCount: count } : { name: table, error: count?.error ?? 'unknown' }
        })
        return { database: name, tableCount: names.length, tables, sizeBytes }
      })
    },
    // size + table list + one batched COUNT per 25 tables, each bounded by queryTimeoutMs.
    timeoutMs: Math.min(600000, cfg.queryTimeoutMs * 4),
    isConcurrencySafe: readsAreConcurrencySafe,
  }

  const d1Health: D1ToolDefinition = {
    name: 'd1_health',
    description: 'dsh-d1 self-check: probe each configured database and summarize the safety config (read-only mode, write-approval gate, row cap, timeouts, any config error). Run this first when something is off.',
    parameters: compileParameters({}),
    output: {
      schema: healthSchema,
      render: (_args, value) => {
        const rec = asRecord(value)
        const databases = Array.isArray(rec.databases) ? rec.databases : []
        const bad = databases.filter((c) => asRecord(c).ok !== true)
        const lines = ['dsh-d1 self-check' + (databases.length === 0 ? ': no databases configured.' : bad.length === 0 ? ': all databases healthy.' : ': ' + bad.length + ' database(s) unhealthy.')]
        if (typeof rec.configError === 'string' && rec.configError !== '') lines.push('- config error: ' + rec.configError)
        for (const item of databases) {
          const c = asRecord(item)
          lines.push('- ' + c.name + (c.ok === true ? ' ✅' : ' ❌ ' + String(c.error ?? '')))
        }
        lines.push('- read-only: ' + (rec.readOnly === true ? 'on (d1_exec disabled)' : 'off'))
        lines.push('- write-approval: ' + (rec.writeApproval === true ? 'on' : 'off'))
        lines.push('- maxRows: ' + String(rec.maxRows) + '; query timeout ' + String(rec.queryTimeoutMs) + 'ms; exec timeout ' + String(rec.execTimeoutMs) + 'ms')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(_args: unknown, exec: unknown) {
      const databases = await pingAll(signalOf(exec))
      const bad = databases.filter((c) => c.ok !== true)
      return {
        ok: databases.length > 0 && bad.length === 0,
        plugin: 'dsh-d1',
        databases,
        readOnly: cfg.readOnly,
        writeApproval: cfg.writeApproval,
        maxRows: cfg.maxRows,
        queryTimeoutMs: cfg.queryTimeoutMs,
        execTimeoutMs: cfg.execTimeoutMs,
        ...(configError !== undefined ? { configError } : {}),
      }
    },
    timeoutMs: cfg.queryTimeoutMs,
    isConcurrencySafe: readsAreConcurrencySafe,
  }

  return { tools: [d1List, d1Query, d1Exec, d1Schema, d1Stats, d1Health], adapters }
}
