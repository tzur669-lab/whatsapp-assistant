/**
 * A `SqlDriver` backed by Node's built-in SQLite, used to drive the real
 * repository code in tests. Cloudflare's DO storage exposes the same shape.
 *
 * Loaded through `createRequire` because Vite's bundler does not yet treat
 * `node:sqlite` as a builtin and would try to resolve it from disk.
 */
import { createRequire } from 'node:module';
import type { SqlDriver, SqlRow } from '../../src/core/sql.js';

type Statement = { all(...params: unknown[]): SqlRow[]; run(...params: unknown[]): unknown };
type Database = { prepare(sql: string): Statement; exec(sql: string): void; close(): void };

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_('node:sqlite') as {
  DatabaseSync: new (path: string) => Database;
};

const RETURNS_ROWS = /^\s*(select|pragma)|returning/is;

export class TestSqlDriver implements SqlDriver {
  private readonly db: Database = new DatabaseSync(':memory:');

  exec(query: string, ...bindings: unknown[]): SqlRow[] {
    const statement = this.db.prepare(query);
    if (RETURNS_ROWS.test(query)) {
      return statement.all(...bindings).map((row) => ({ ...row }));
    }
    statement.run(...bindings);
    return [];
  }

  close(): void {
    this.db.close();
  }
}
