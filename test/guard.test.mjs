import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertReadQuery, classifyReadQuery, lexSql, stripSqlNoise } from '../lib/tools.js'

test('accepts read statements, including identifiers that collide with write keywords', () => {
  for (const sql of [
    'SELECT * FROM users',
    'select id from t where name = 1',
    'VALUES (1), (2)',
    'PRAGMA table_info(users)',
    'PRAGMA table_info("users")',
    'PRAGMA index_list(users)',
    'PRAGMA foreign_key_list(users)',
    'PRAGMA table_list',
    'PRAGMA page_size',
    'PRAGMA foreign_keys',
    'PRAGMA main.table_info(users)',
    'EXPLAIN QUERY PLAN SELECT 1',
    'EXPLAIN SELECT * FROM t',
    'WITH x AS (SELECT 1) SELECT * FROM x',
    'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 10) SELECT n FROM c',
    'WITH "quoted name"(a, b) AS NOT MATERIALIZED (VALUES (1, 2)), y AS (SELECT * FROM "quoted name") SELECT * FROM y',
    'SELECT release, set, copy, begin, merge, execute FROM versions ORDER BY release',
    'SELECT * FROM t WHERE id IN (SELECT id FROM u) AND status = \'delete me\'',
    'SELECT json_each.value FROM t, json_each(t.payload)',
    'SELECT id, row_number() OVER (PARTITION BY grp ORDER BY ts) FROM events',
    'SELECT * FROM t LIMIT 10 OFFSET 5',
    "SELECT 'it''s; fine' AS note",
    '  select 1  ',
    'SELECT 1;', // trailing semicolon on a single statement is fine
    'SELECT 1 -- delete from t',
    'SELECT 1 /* drop table t */',
    'SELECT "drop table" AS label FROM t',
    'SELECT `insert` FROM t',
    'SELECT [update] FROM t',
  ]) {
    assert.doesNotThrow(() => assertReadQuery(sql), 'should accept: ' + sql)
  }
})

test('classifies statements for row capping', () => {
  assert.equal(classifyReadQuery('SELECT 1').kind, 'select')
  assert.equal(classifyReadQuery('VALUES (1)').kind, 'select')
  assert.equal(classifyReadQuery('WITH x AS (SELECT 1) SELECT * FROM x').kind, 'select')
  assert.equal(classifyReadQuery('PRAGMA table_info(t)').kind, 'pragma')
  assert.equal(classifyReadQuery('EXPLAIN SELECT 1').kind, 'explain')
})

test('strips the trailing semicolon from the returned sql', () => {
  assert.equal(assertReadQuery('SELECT 1;'), 'SELECT 1')
  assert.equal(assertReadQuery('SELECT 1 ;  '), 'SELECT 1')
})

test('rejects writes and DDL', () => {
  for (const sql of [
    'INSERT INTO t VALUES (1)',
    'UPDATE t SET x = 1',
    'DELETE FROM t',
    'DROP TABLE t',
    'ALTER TABLE t ADD COLUMN c INT',
    'CREATE TABLE t (id INT)',
    'REPLACE INTO t VALUES (1)',
    'TRUNCATE t',
    'ATTACH DATABASE ":memory:" AS x',
    'VACUUM',
    'BEGIN',
    'ANALYZE',
    'REINDEX',
  ]) {
    assert.throws(() => assertReadQuery(sql), /read-only/, 'should reject: ' + sql)
  }
})

test('rejects multi-statement smuggling', () => {
  assert.throws(() => assertReadQuery('SELECT 1; DROP TABLE t'), /single statement/)
  assert.throws(() => assertReadQuery('SELECT 1; DELETE FROM t'), /single statement/)
  assert.throws(() => assertReadQuery('SELECT 1; -- x\nDROP TABLE t'), /single statement/)
})

test('backslash is not an escape in SQLite: the string desync payload is rejected', () => {
  // Real SQLite parses '\' as a complete one-character string, then runs the DROP.
  assert.throws(() => assertReadQuery("SELECT '\\'; DROP TABLE t; --'"), /single statement/)
  assert.throws(() => assertReadQuery('SELECT "\\"; DELETE FROM t; --"'), /single statement/)
  assert.throws(() => assertReadQuery('SELECT `\\`; UPDATE t SET x = 1; --`'), /single statement/)
  assert.equal(stripSqlNoise("SELECT '\\'; DROP TABLE t; --'").includes('DROP'), true)
})

test('verdicts are deterministic across repeated calls', () => {
  const read = 'SELECT a, b, c FROM some_long_table_name WHERE description LIKE ? ORDER BY created_at DESC'
  const write = 'WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x'
  for (let i = 0; i < 5; i += 1) {
    assert.doesNotThrow(() => assertReadQuery(read))
    assert.throws(() => assertReadQuery(write), /write keyword/i)
  }
})

test('rejects WITH clauses that lead to a write or wrap one', () => {
  assert.throws(() => assertReadQuery('WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x'), /write keyword/i)
  assert.throws(() => assertReadQuery('WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x'), /WITH … INSERT/)
  assert.throws(() => assertReadQuery('WITH x AS (SELECT 1) UPDATE t SET a = 1'), /WITH … UPDATE/)
  assert.throws(() => assertReadQuery('WITH x AS (SELECT 1) DELETE FROM t'), /WITH … DELETE/)
  assert.throws(() => assertReadQuery('WITH x AS (SELECT 1) REPLACE INTO t SELECT * FROM x'), /WITH … REPLACE/)
  assert.throws(() => assertReadQuery('WITH x (SELECT 1) SELECT 1'), /expected AS/)
})

test('EXPLAIN only wraps reads', () => {
  assert.throws(() => assertReadQuery('EXPLAIN DELETE FROM t'), /read-only/)
  assert.throws(() => assertReadQuery('EXPLAIN QUERY PLAN INSERT INTO t VALUES (1)'), /read-only/)
})

test('PRAGMA: introspection forms pass, setters and side-effect pragmas are rejected', () => {
  assert.throws(() => assertReadQuery('PRAGMA foreign_keys = ON'), /PRAGMA/)
  assert.throws(() => assertReadQuery('PRAGMA user_version(5)'), /PRAGMA user_version\(/)
  assert.throws(() => assertReadQuery('PRAGMA foreign_keys(ON)'), /PRAGMA/)
  assert.throws(() => assertReadQuery('PRAGMA wal_checkpoint(TRUNCATE)'), /PRAGMA/)
  assert.throws(() => assertReadQuery('PRAGMA optimize'), /modifies the database/)
  assert.throws(() => assertReadQuery('PRAGMA wal_checkpoint'), /modifies the database/)
  assert.throws(() => assertReadQuery('PRAGMA "user_version"(5)'), /unrecognised PRAGMA/)
  assert.doesNotThrow(() => assertReadQuery('PRAGMA table_info(t)'))
  assert.doesNotThrow(() => assertReadQuery('PRAGMA quick_check(1)'))
})

test('rejects load_extension()', () => {
  assert.throws(() => assertReadQuery("SELECT load_extension('evil')"), /load_extension/)
  assert.throws(() => assertReadQuery("WITH x AS (SELECT load_extension('evil')) SELECT * FROM x"), /load_extension/)
})

test('a write keyword hidden inside a string literal does not fool the guard', () => {
  assert.doesNotThrow(() => assertReadQuery("SELECT 'please delete this later' AS note"))
  assert.doesNotThrow(() => assertReadQuery('SELECT "drop table" AS label FROM t'))
  assert.doesNotThrow(() => assertReadQuery('SELECT 1 -- delete from t'))
  assert.doesNotThrow(() => assertReadQuery('SELECT 1 /* drop table t */'))
})

test('stripSqlNoise removes comments, strings and quoted identifiers', () => {
  assert.equal(stripSqlNoise("SELECT 'x' -- c\n, 1").includes("'x'"), false)
  assert.equal(stripSqlNoise('SELECT /* drop */ 1').includes('drop'), false)
  assert.equal(stripSqlNoise('SELECT "drop table" FROM t').includes('drop'), false)
  assert.equal(stripSqlNoise('SELECT `weird name` FROM t').includes('weird'), false)
  assert.equal(stripSqlNoise('SELECT [bracket id] FROM t').includes('bracket'), false)
  assert.equal(stripSqlNoise("SELECT 'a''b; c' FROM t").includes(';'), false, 'doubled quotes stay inside the literal')
})

test('statements that end inside an unterminated construct are rejected (they would swallow the row-cap wrapper)', () => {
  assert.throws(() => assertReadQuery('SELECT * FROM users) /*'), /unterminated block comment|unbalanced/)
  assert.throws(() => assertReadQuery('SELECT 1 /* x'), /unterminated block comment/)
  assert.throws(() => assertReadQuery("SELECT 'a"), /unterminated string literal/)
  assert.throws(() => assertReadQuery('SELECT "a'), /unterminated quoted identifier/)
  assert.throws(() => assertReadQuery('SELECT [a'), /unterminated quoted identifier/)
  assert.throws(() => assertReadQuery('SELECT `a'), /unterminated quoted identifier/)
  assert.doesNotThrow(() => assertReadQuery('SELECT 1 /* closed */'))
  assert.doesNotThrow(() => assertReadQuery('SELECT 1 -- line comments are fine'))
  assert.equal(lexSql('SELECT 1 /* x').unterminated, 'block comment')
  assert.equal(lexSql("SELECT 'it''s'").unterminated, null)
})

test('parentheses must balance so a SELECT cannot escape the LIMIT wrapper', () => {
  assert.throws(() => assertReadQuery('SELECT * FROM users) UNION ALL SELECT * FROM users /* x */'), /unbalanced/)
  assert.throws(() => assertReadQuery('SELECT * FROM t) CROSS JOIN t b /**/'), /unbalanced/)
  assert.throws(() => assertReadQuery('SELECT (1'), /unbalanced/)
  assert.doesNotThrow(() => assertReadQuery("SELECT (1 + 2) * 3, ')' AS s FROM t WHERE x IN (SELECT y FROM u)"))
})

test('empty / non-read input is rejected', () => {
  assert.throws(() => assertReadQuery(''), /read-only/)
  assert.throws(() => assertReadQuery('   '), /read-only/)
  assert.throws(() => assertReadQuery(';;'), /read-only/)
})
