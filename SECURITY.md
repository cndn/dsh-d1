# Security policy

## What dsh-d1 promises

- **Read-only by default.** `readOnly:true` (the default) makes `d1_exec` impossible: the
  pre-execute gate denies it before any prompt, and the tool refuses at execute time as
  a second layer. `d1_query` accepts only `SELECT` / `VALUES` / `WITH … SELECT` /
  introspection `PRAGMA` / `EXPLAIN`, exactly one statement, balanced parentheses and
  no unterminated string, identifier or comment — using SQLite's own quoting rules.
- **Approval-gated writes.** With `readOnly:false`, every `d1_exec` goes through dsh's
  approval service and shows the database, statement count and SQL to the approver.
- **Token hygiene.** The Cloudflare API token is read from the environment at call
  time, must be printable ASCII, and is never stored, logged, rendered to the model,
  or included in an error message. Upstream error bodies are scrubbed of the token
  and of account / database ids echoed in request paths.
- **Bounded transfers.** `SELECT`s are wrapped in a `LIMIT` before they are sent, so a
  runaway query cannot pull an entire table over the D1 HTTP API.

## What it does not promise

- A Cloudflare token with **D1 Edit** scope can write through `d1_exec` once the
  operator enables writes. Use a **D1 Read** token for read-only agents.
- Cancelling `d1_exec` abandons the HTTP request only; a statement D1 has already
  received may still be applied.

## Reporting a vulnerability

Open a [GitHub security advisory](https://github.com/cndn/dsh-d1/security/advisories/new)
or an issue at <https://github.com/cndn/dsh-d1/issues> with a minimal reproduction.
A read-only bypass of `d1_query` or any path that exposes the API token is treated as
critical and fixed first.
