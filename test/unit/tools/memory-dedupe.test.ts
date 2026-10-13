/**
 * A fact said twice is kept once (block J, J7) — best effort. Equality only,
 * after case, spacing, surrounding quotes and one trailing period: a longer
 * fact may be a correction, and `1.5` is not `15`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../../src/core/repo.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import { FactStore } from '../../../src/tools/fact-store.js';
import { memoryRemember, sameFact } from '../../../src/tools/memory.js';
import type { ToolContext } from '../../../src/tools/types.js';
import { factText } from '../../../src/render/personal.js';
import { parseKeyring } from '../../../src/security/crypto.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';

const NOW = Date.parse('2026-10-13T09:00:00Z');
const P = 'p_dedupe';
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));

describe('sameFact', () => {
  it.each([
    ['אני גר ברחובות', 'אני גר ברחובות.'],
    ['I am Vegetarian', 'i am   vegetarian'],
    ['"אני צמחוני"', 'אני צמחוני'],
    ['״אני צמחוני״', 'אני צמחוני'],
  ])('"%s" is "%s"', (a, b) => expect(sameFact(a, b)).toBe(true));

  it.each([
    ['אני גר ברחובות', 'אני גר ברחובות עם שני ילדים'],
    ['הילד בן 1.5', 'הילד בן 15'],
    ['אני גר ברחובות', 'אני גר בירושלים'],
    ['אני גר. ברחובות', 'אני גר ברחובות'],
  ])('"%s" is not "%s"', (a, b) => expect(sameFact(a, b)).toBe(false));
});

describe('memory.remember, a second time', () => {
  let driver: TestSqlDriver;
  let facts: FactStore;
  let ctx: ToolContext;

  beforeEach(() => {
    driver = new TestSqlDriver();
    new Repository(driver).migrate(MIGRATIONS);
    facts = new FactStore(driver, () => NOW, () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY }));
    ctx = { principal: P, nowMs: NOW, lang: 'he', log: createFakeLogger(), facts } as unknown as ToolContext;
  });
  afterEach(() => driver.close());

  it('keeps one, and says so without an Undo', async () => {
    const first = await memoryRemember.execute({ text: 'אני צמחוני' }, ctx);
    expect(first.compensating).toBeDefined();
    const again = await memoryRemember.execute({ text: 'אני צמחוני.' }, ctx);
    expect(again.text).toBe(factText.already('he'));
    // No Undo: it would delete the fact that was there before.
    expect(again.compensating).toBeUndefined();
    expect(again.externalRef).toBeUndefined();
    expect((await facts.all(P)).map((fact) => fact.text)).toEqual(['אני צמחוני']);
  });

  it('a correction is a new fact', async () => {
    await memoryRemember.execute({ text: 'אני גר ברחובות' }, ctx);
    await memoryRemember.execute({ text: 'אני גר ברחובות, ליד הפארק' }, ctx);
    expect(await facts.all(P)).toHaveLength(2);
  });

  it('best effort: two saves of the same fact interleaved can both insert (accepted, documented)', async () => {
    const [a, b] = await Promise.all([
      memoryRemember.execute({ text: 'אני צמחוני' }, ctx),
      memoryRemember.execute({ text: 'אני צמחוני' }, ctx),
    ]);
    expect([a.compensating, b.compensating].filter(Boolean).length).toBeGreaterThanOrEqual(1);
    expect((await facts.all(P)).length).toBeGreaterThanOrEqual(1);
  });
});
