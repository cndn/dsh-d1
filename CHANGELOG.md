# Changelog

All notable changes to dsh-d1 are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-09-02

### Added

- Six Cordis tools for the DeepSeek Harness: `d1_list`, `d1_query`, `d1_exec`,
  `d1_schema`, `d1_stats`, `d1_health`, speaking the Cloudflare D1 `/raw` HTTP API.
- Read-only-first posture: a SQLite-accurate lexical guard on `d1_query`
  (single statement; `SELECT` / `VALUES` / `WITH … SELECT` / introspection
  `PRAGMA` / `EXPLAIN`; balanced parentheses; no unterminated constructs) and a
  `tools/pre-execute` gate that denies `d1_exec` under `readOnly` (the default)
  and asks for interactive approval otherwise.
- `SELECT` results are row-capped with a `LIMIT` wrapper before transfer.
- Every tool forwards the harness cancellation signal to the D1 request;
  cancelled calls settle as dsh's canonical ABORTED outcome.
- Batched `COUNT(*)` in `d1_stats` (one round trip per 25 tables).
- Env-only API token (`CLOUDFLARE_API_TOKEN` / `DSH_D1_TOKEN_<NAME>`), never
  stored, logged, rendered or included in errors; upstream error bodies are
  token- and path-scrubbed.
- CSV output neutralises spreadsheet formula prefixes.
- Zero runtime dependencies; MIT license.
