import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

/**
 * Wrangler bundles `.sql` files as text modules (see `rules` in wrangler.jsonc).
 * This mirrors that for the test runner so migrations import identically in
 * both environments.
 */
function sqlAsText() {
  return {
    name: 'sql-as-text',
    transform(_code: string, id: string) {
      if (!id.endsWith('.sql')) return null;
      const sql = readFileSync(id, 'utf8');
      return { code: `export default ${JSON.stringify(sql)};`, map: null };
    },
  };
}

export default defineConfig({
  plugins: [sqlAsText()],
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Evals hit a real provider and are run separately via `pnpm eval`.
    exclude: ['node_modules/**', 'test/evals/**'],
  },
});
