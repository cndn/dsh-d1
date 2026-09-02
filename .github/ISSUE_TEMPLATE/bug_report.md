---
name: Bug report
about: Something in dsh-d1 misbehaves
labels: bug
---

**Before you paste anything:** never include your Cloudflare API token, account id or
database ids. Replace them with `<token>`, `<account>` and `<database>`. dsh-d1 redacts
these from its own errors, but logs and screenshots may still contain them.

### What happened

<!-- the tool you called (d1_query / d1_exec / …), the SQL (if it is not sensitive),
and the exact error text as rendered in dsh -->

### What you expected

### Environment

- dsh-d1 version:
- dsh version (`dsh --version`):
- Node version (`node --version`):
- Install method: npm registry / GitHub (`prepare` build) / local link
- Plugin config (from your profile's cordis.patch.yml, ids redacted):

```yaml
```

### Guard rejections

If `d1_query` rejected a statement you believe is read-only, paste the statement (or a
minimal equivalent) and the rejection message. The guard accepts one statement:
`SELECT` / `VALUES` / `WITH … SELECT` / introspection `PRAGMA` / `EXPLAIN`.
