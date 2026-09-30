/**
 * Adapts Durable Object SQLite storage to the portable `SqlDriver` interface.
 * This file and `assistant-do.ts` are the only places allowed to touch
 * Cloudflare APIs (CLAUDE.md invariant 11).
 */
import type { SqlDriver, SqlRow } from '../core/sql.js';

export class DurableObjectSqlDriver implements SqlDriver {
  constructor(private readonly storage: DurableObjectStorage) {}

  exec(query: string, ...bindings: unknown[]): SqlRow[] {
    const cursor = this.storage.sql.exec(query, ...(bindings as never[]));
    return cursor.toArray() as SqlRow[];
  }

  transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }
}
