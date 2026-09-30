/**
 * The tool catalog is part of the prompt (PLAN §6.2), so a change to it is a
 * change to what the model sees — and CLAUDE.md requires `pnpm eval` after
 * any such change. The app channel (§6.18) was built without touching it,
 * which is why that eval was not needed; this pins it so a later change cannot
 * slip past the same reasoning unnoticed.
 *
 * If this fails because the catalog changed on purpose: run `pnpm eval`,
 * report the §11.2 metrics, and only then update the digest below.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { toolCatalog } from '../../../src/tools/registry.js';

describe('the tool catalog in the prompt', () => {
  it('has not changed without an eval', () => {
    const digest = createHash('sha256').update(JSON.stringify(toolCatalog())).digest('hex');
    expect(digest).toBe('f715d20226940bced5380e945f7eff47183bf02119755f6ab040427d9afe6020');
  });
});
