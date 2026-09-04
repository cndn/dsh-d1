# dsh-d1

[![ci](https://github.com/cndn/dsh-d1/actions/workflows/ci.yml/badge.svg)](https://github.com/cndn/dsh-d1/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-d1)](https://www.npmjs.com/package/dsh-d1)

**Cloudflare D1 (serverless SQLite over HTTP) tools for the [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) — read-only first.**

D1 is Cloudflare's serverless SQLite. Unlike a normal database it has **no TCP socket** — it is reached only over the Cloudflare REST API. So the excellent [`dsh-sql`](https://github.com/STARDUSTLC666/dsh-sql) plugin (which pools TCP connections to SQLite/MySQL/Postgres) can't talk to it. `dsh-d1` fills that gap: it speaks the D1 HTTP API directly, giving a dsh agent six tools to introspect and query any D1 database you configure.

It is **read-only by default**. Writes require flipping `readOnly:false` *and* passing an interactive approval gate.

## Tools

| Tool | Mode | What it does |
|---|---|---|
| `d1_list` | read | List configured databases and probe each (`SELECT 1`). |
| `d1_query` | read | Run one read-only statement (`SELECT` / `VALUES` / `WITH … SELECT` / introspection `PRAGMA` / `EXPLAIN`), with optional bound `params`. Row-capped. |
| `d1_exec` | write | Run a write/DDL statement. Denied under `readOnly`; needs interactive approval otherwise. |
| `d1_schema` | read | List user tables, or describe one table's columns (via `PRAGMA table_info`). |
| `d1_stats` | read | Table count, per-table row counts (batched), database size. |
| `d1_health` | read | Probe every database and print the safety config (and any config error). |

Every tool forwards the harness's cancellation signal to the D1 request, so a cancelled or timed-out call aborts the HTTP call instead of running to completion in the background. For `d1_exec` that only abandons the request: a statement D1 has already received may still be applied, so check with `d1_query` before retrying a cancelled write. The five read tools are marked concurrency-safe, so the harness may run them in parallel.

## Install

From npm. The profile directory is a pnpm workspace root, so pnpm needs `-w`:

```bash
dsh plugin --profile web add -w dsh-d1
```

The npm tarball ships `lib/` prebuilt, so there is no build step to approve. The
package is published from CI with [provenance](https://docs.npmjs.com/generating-provenance-statements);
`npm audit signatures` verifies the attestation.

During development, from a local checkout:

```bash
cd dsh-d1 && npm install && npm run build
dsh plugin --profile web add -w /absolute/path/to/dsh-d1
```

Installing straight from git (`github:cndn/dsh-d1`) builds `lib/` through the `prepare` script instead. pnpm 10 blocks that build until you allow it once: copy the `onlyBuiltDependencies` entry it prints (pinned to the git commit) into the profile's `pnpm-workspace.yaml`, then re-run the install.

## Configure

The package already inserts a `d1` row into your profile. Override its `config` from your profile's `cordis.patch.yml` with an **id-targeted entry** (not another `insert`, which would load the plugin twice). **The API token is never part of this config** — see below.

```yaml
- id: d1
  name: 'dsh-d1'
  config:
    accountId: 'your-32-hex-cloudflare-account-id'   # or set CLOUDFLARE_ACCOUNT_ID in the env
    databases:
      - name: prod                                   # the friendly name the agent uses
        databaseId: 00000000-0000-0000-0000-000000000000
      - name: analytics
        databaseId: 11111111-1111-1111-1111-111111111111
        accountId: 'another-32-hex-account-id'       # optional per-db override
    maxRows: 1000            # d1_query row cap (1–10000; larger values are clamped)
    readOnly: true           # default true — d1_exec denied; set false to allow writes
    writeApproval: true      # writes must be confirmed interactively (default true)
    queryTimeoutMs: 60000    # 5 s – 10 min (clamped)
    execTimeoutMs: 120000    # 5 s – 10 min (clamped)
```

With **no** databases the plugin still loads (all tools register, `d1_health` reports "no databases configured") so it is usable for diagnostics. If the config is invalid the plugin falls back to read-only with no databases and `d1_health` prints the config error.

## The API token (env-only)

The Cloudflare API token is read from the **environment at call time** and is *never* stored in config, written to the patch, logged, rendered, or included in any error message.

```bash
# Global token used for every database:
export CLOUDFLARE_API_TOKEN='...'
# Optional per-database override: DSH_D1_TOKEN_<NAME>, where NAME is the database
# name uppercased with non-alphanumerics replaced by "_" (my-db → DSH_D1_TOKEN_MY_DB):
export DSH_D1_TOKEN_PROD='...'
```

Create a token in the Cloudflare dashboard with **D1 → Read** for a read-only agent (or **D1 → Edit** if you intend to enable writes). The account id (32 hex characters) can come from `accountId` in config or the `CLOUDFLARE_ACCOUNT_ID` env var.

## Read-only, at two layers

1. **`d1_query` is lexically guarded.** After stripping comments, string literals and quoted identifiers (with SQLite's own quoting rules — backslash is not an escape), exactly one statement is allowed and it must be `SELECT` / `VALUES` / `WITH … SELECT` / `PRAGMA` (introspection forms only — no `PRAGMA x = y`, no `PRAGMA x(value)` setters, no `PRAGMA optimize`) / `EXPLAIN` of one of those. In SQLite none of these can modify data, so there is no interior keyword blacklist and column names such as `release` or `set` are fine. `SELECT`s are wrapped in `SELECT * FROM (…) LIMIT maxRows+1` so a runaway query never transfers more than the cap.
2. **`d1_exec` is denied while `readOnly:true`** — the pre-execute gate refuses it before any prompt. With `readOnly:false`, `writeApproval:true` (the default) routes every write through dsh's approval service: in the web UI you get a confirmation card showing the target database, statement count and the SQL. Where nobody can answer — a headless profile without an interactive answerer, a profile with no approval service at all, or `DSH_PERMISSION_MODE=danger-full-access` (dsh sets the approval policy to `never`) — the ask is auto-rejected and the write is denied, so in those modes `d1_exec` cannot run at all with `writeApproval:true`. `writeApproval:false` removes the gate entirely — the plugin logs a warning at boot when both flags are off.

This is deliberately stricter than a general SQL plugin: the safe default is that an agent can *read* your production data but cannot change it until you opt in.

## Security notes

- The token is env-only and must be printable ASCII; the bundled `cordis.patch.yml` carries no secrets and no real database ids.
- Errors are redacted: a failed request surfaces the reason (timeout, cancellation, HTTP status, D1 error message) but never the token or request headers, and request paths echoed by Cloudflare have the account and database ids removed.
- Table names are double-quote-escaped before use in `PRAGMA table_info` / `COUNT(*)` (`d1_schema`, `d1_stats`) so a name can't break out into arbitrary SQL.
- CSV output neutralises spreadsheet formula prefixes (`=`, `+`, `-`, `@`) in string cells.

## License

MIT
