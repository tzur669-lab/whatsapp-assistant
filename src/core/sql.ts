/**
 * The narrow SQL surface the portable core depends on. It matches the shape of
 * the Durable Object storage API, so `src/platform/sql-repo.ts` can adapt it in
 * a few lines while tests drive the same code against plain SQLite.
 *
 * Deliberately names no platform type: the ban-list scan enforces that the
 * Cloudflare API surface stays inside `src/platform/`.
 */
export type SqlRow = Record<string, unknown>;

export interface SqlDriver {
  /** Run a statement and return all result rows (empty for writes). */
  exec(query: string, ...bindings: unknown[]): SqlRow[];
}
