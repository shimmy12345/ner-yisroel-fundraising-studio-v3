// A minimal D1Database-shaped adapter over node:sqlite's DatabaseSync, for
// tests that need to exercise REAL D1-touching production code (not a
// hand-copied reimplementation of its SQL) under plain Node -- see
// tests/trip-reconciliation-concurrency.test.mjs's own header for why
// this exists and what it does and doesn't prove. Implements exactly the
// subset of the D1Database surface this codebase's write paths actually
// use: prepare().bind().first()/.all()/.run(), and batch() as one real
// transaction (BEGIN/COMMIT, ROLLBACK + rethrow on any statement error --
// matching D1's own documented all-or-nothing batch semantics, which
// several write paths explicitly depend on).
import { DatabaseSync } from "node:sqlite";

class D1SqliteStatement {
  #db; #sql; #params = [];
  constructor(db, sql) { this.#db = db; this.#sql = sql; }
  bind(...params) { this.#params = params; return this; }
  first() {
    const row = this.#db.prepare(this.#sql).get(...this.#params);
    return row === undefined ? null : row;
  }
  all() {
    const results = this.#db.prepare(this.#sql).all(...this.#params);
    return { results };
  }
  run() {
    const statement = this.#db.prepare(this.#sql);
    const info = statement.run(...this.#params);
    return { meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
  }
  // Internal: used by batch() to run with already-bound params without
  // re-wrapping the result shape differently from .run()'s own.
  _runRaw() { return this.run(); }
}

export class D1SqliteAdapter {
  #db;
  constructor(db) { this.#db = db; }
  static fromMigrations(migrationSqlTexts) {
    const db = new DatabaseSync(":memory:");
    for (const sql of migrationSqlTexts) db.exec(sql);
    return new D1SqliteAdapter(db);
  }
  prepare(sql) { return new D1SqliteStatement(this.#db, sql); }
  exec(sql) { this.#db.exec(sql); }
  // Matches D1Database.batch(): all statements commit together, or none
  // do. A thrown error from any statement rolls back and rethrows,
  // exactly like the real D1 binding -- several production write paths
  // (attributeGivingActivityToTrip's own insert-and-retire, in
  // particular) are only correct if this holds.
  batch(statements) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement._runRaw());
      this.#db.exec("COMMIT");
      return results;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
  raw() { return this.#db; }
}
