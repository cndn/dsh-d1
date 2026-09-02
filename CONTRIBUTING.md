# Contributing

## Setup

```bash
npm install
npm test          # builds lib/ with tsc, then runs node --test
npm run typecheck
```

Node 22.13 or newer. There are no runtime dependencies; keep it that way — the
plugin must load in any dsh profile without pulling extra packages.

## Tests

- `test/guard.test.mjs` — the read-only guard. Every accepted statement must be
  provably read-only in SQLite; every rejection must name the reason.
- `test/adapters.test.mjs` — the D1 `/raw` adapter with a stubbed `fetch`
  (request shape, redaction, cancellation, timeouts).
- `test/tools.test.mjs` — the six tools end to end against stubbed responses.
- `test/register.test.mjs` — the Cordis entry and the `d1_exec` gate.
- `test/harness.test.mjs` — harness-contract checks. Point `DSH_TOOLS_ENTRY` at an
  installed `@deepseek-ai/dsh-tools/lib/index.js` to also run dsh's own JSON-schema
  acceptance over every tool definition; without it those checks are skipped.

```bash
DSH_TOOLS_ENTRY=~/.dsh/profiles/node_modules/@deepseek-ai/dsh-tools/lib/index.js npm test
```

## Live smoke (optional)

`npm run smoke` drives the built plugin against a real D1 database with a
**read-only** token and prints counts only — no table names, rows, ids or tokens.

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... SMOKE_DB_ID=<d1 uuid> npm run smoke
```

## Changing the guard

Any change to `stripSqlNoise` / `classifyReadQuery` needs a test that runs the
accepted and rejected corpus through real SQLite (`node:sqlite`) and shows that
nothing accepted can modify data and nothing wrapped by the row cap changes
meaning. Backslash is not an escape in SQLite; doubled quotes are.

## Commits and releases

Conventional Commits with a lowercase subject (`fix: …`, `feat: …`, `docs: …`).
Bump `version` in `package.json`, add a `CHANGELOG.md` entry, tag `vX.Y.Z`.
`prepublishOnly` builds `lib/`; the npm tarball ships only `lib/`, the bundle
patch, README and LICENSE.
