/**
 * dsh-d1 — Cloudflare D1 (serverless SQLite over HTTP) tools for the DeepSeek
 * Harness, built on the Cordis plugin framework. Read-only first.
 *
 * A Cordis plugin exports `name`, `inject` and `apply`. `apply` resolves the
 * config, installs a `tools/pre-execute` gate for `d1_exec` (deny while
 * read-only, ask for approval otherwise) and registers the six d1_* tools.
 * Registrations and the listener are fiber-owned effects: cordis removes them
 * when the plugin unloads or reloads, so no manual teardown is needed.
 *
 * @module dsh-d1
 */
import { resolveConfig, type D1Config, type ResolvedD1Config } from './config.js'
import { buildD1Tools, stripSqlNoise } from './tools.js'

export const name = 'd1'
export const inject = ['tools']

/** A disposer returned by ctx.tools.register. */
type Disposer = () => void

/** The subset of the Cordis context this plugin uses. */
interface ToolsContext {
  tools: { register(definition: unknown): Disposer }
  on(event: 'tools/pre-execute', listener: PreExecuteListener): void
}

/** A pending tool execution as seen by the pre-execute gate (dsh-tools ToolExecution). */
interface PreExecuteEvent {
  name: string
  arguments?: unknown
}

/** Verdict a pre-execute listener returns (or it calls next() to waterfall). */
type PreExecuteVerdict = { kind: 'allow' | 'deny' | 'ask'; reason?: string }
type PreExecuteListener = (event: PreExecuteEvent, next: () => Promise<PreExecuteVerdict>) => Promise<PreExecuteVerdict>

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/**
 * The approval prompt for a d1_exec call: target database, statement count,
 * bound-param count and the SQL (whitespace-collapsed; head + tail when long).
 */
export function describeWrite(args: unknown): string {
  const rec = asRecord(args)
  const sql = typeof rec.sql === 'string' ? rec.sql.replace(/\s+/g, ' ').trim() : ''
  const database = typeof rec.database === 'string' && rec.database.trim() !== '' ? rec.database.trim() : 'default'
  const params = Array.isArray(rec.params) ? rec.params.length : 0
  const statements = stripSqlNoise(sql).split(';').filter((part) => part.trim() !== '').length
  const preview = sql === '' ? '(no sql provided)' : sql.length <= 600 ? sql : sql.slice(0, 400) + ' … ' + sql.slice(-150)
  return (
    'd1_exec write requires interactive approval — database ' +
    database +
    (statements > 1 ? ', ' + statements + ' statements' : '') +
    (params > 0 ? ', ' + params + ' bound param(s)' : '') +
    ': ' +
    preview
  )
}

/**
 * Plugin entry. Registers the d1_* tools and the d1_exec gate: while readOnly
 * the gate denies outright (no pointless prompt); otherwise, with writeApproval
 * on, it asks the human before any write runs.
 */
export function apply(ctx: ToolsContext, config: D1Config | undefined | null): void {
  let cfg: ResolvedD1Config
  let configError: string | undefined
  try {
    cfg = resolveConfig(config)
  } catch (error) {
    // Bad config shouldn't crash harness boot — fall back to safe defaults
    // (read-only, zero databases); d1_health reports the reason.
    configError = error instanceof Error ? error.message : String(error)
    // eslint-disable-next-line no-console -- surface misconfig at boot; no secrets in this message.
    console.warn('[dsh-d1] invalid config, falling back to read-only/no databases: ' + configError)
    cfg = resolveConfig(null)
  }

  if (!cfg.readOnly && !cfg.writeApproval) {
    // eslint-disable-next-line no-console -- an ungated write path deserves one boot-time line.
    console.warn('[dsh-d1] readOnly:false and writeApproval:false — d1_exec writes run with no approval gate.')
  }

  if (cfg.readOnly || cfg.writeApproval) {
    ctx.on('tools/pre-execute', async (event, next) => {
      if (event.name !== 'd1_exec') return next()
      if (cfg.readOnly) {
        return { kind: 'deny', reason: 'dsh-d1 is in readOnly mode; d1_exec is disabled (set readOnly:false in the plugin config to allow writes).' }
      }
      return { kind: 'ask', reason: describeWrite(event.arguments) }
    })
  }

  const { tools } = buildD1Tools(cfg, process.env, configError)
  for (const definition of tools) ctx.tools.register(definition)
}

export * from './config.js'
export * from './adapters.js'
export * from './tools.js'
