/**
 * The agent's encrypted short memory (PLAN §6.19, plan invariant 7).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../../src/core/repo.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import { parseKeyring } from '../../../src/security/crypto.js';
import {
  ConversationHistory,
  HISTORY_TTL_MS,
  MAX_EXCHANGES,
  TAINTED_HISTORY_TTL_MS,
} from '../../../src/agent/history.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';

const KEY_A = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const KEY_B = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const P = 'p_test';

describe('ConversationHistory', () => {
  let driver: TestSqlDriver;
  let now: number;
  let key: string;
  let history: ConversationHistory;

  beforeEach(() => {
    driver = new TestSqlDriver();
    new Repository(driver).migrate(MIGRATIONS);
    now = 1_700_000_000_000;
    key = KEY_A;
    history = new ConversationHistory(driver, () => now, () => parseKeyring({ TOKEN_ENC_KEY_V1: key }));
  });
  afterEach(() => driver.close());

  it('reads back what was written, oldest first', async () => {
    await history.append(P, { user: 'שלום', reply: 'היי', tainted: false });
    now += 1;
    await history.append(P, { user: 'ומחר?', reply: 'כלום', tainted: false });
    const recent = await history.recent(P);
    expect(recent.map((entry) => entry.user)).toEqual(['שלום', 'ומחר?']);
  });

  describe('per conversation (the app, §6.18)', () => {
    const A = '11111111-1111-4111-8111-111111111111';
    const B = '22222222-2222-4222-8222-222222222222';

    it('keeps each conversation to itself', async () => {
      await history.append(P, { user: 'in A', reply: 'r', tainted: false }, A);
      await history.append(P, { user: 'in B', reply: 'r', tainted: false }, B);
      await history.append(P, { user: 'no conversation', reply: 'r', tainted: false });

      expect((await history.recent(P, A)).map((e) => e.user)).toEqual(['in A']);
      expect((await history.recent(P, B)).map((e) => e.user)).toEqual(['in B']);
      expect((await history.recent(P)).map((e) => e.user)).toEqual(['no conversation']);
    });

    it(`keeps the last ${MAX_EXCHANGES} exchanges of each conversation, not of all of them`, async () => {
      for (let i = 0; i < MAX_EXCHANGES + 2; i++) {
        await history.append(P, { user: `a${i}`, reply: 'r', tainted: false }, A);
      }
      await history.append(P, { user: 'b0', reply: 'r', tainted: false }, B);

      expect(await history.recent(P, A)).toHaveLength(MAX_EXCHANGES);
      expect((await history.recent(P, A))[0]?.user).toBe('a2');
      expect((await history.recent(P, B)).map((e) => e.user)).toEqual(['b0']);
    });

    it('binds a row to its conversation: moved to another, it does not decrypt', async () => {
      await history.append(P, { user: 'secret', reply: 'r', tainted: false }, A);
      driver.exec('UPDATE conversation_turns SET conversation = ?', B);
      expect(await history.recent(P, B)).toEqual([]);
    });

    it('/forget wipes every conversation', async () => {
      await history.append(P, { user: 'x', reply: 'r', tainted: false }, A);
      await history.append(P, { user: 'y', reply: 'r', tainted: false }, B);
      history.wipe(P);
      expect(await history.recent(P, A)).toEqual([]);
      expect(await history.recent(P, B)).toEqual([]);
    });
  });

  it('stores only ciphertext', async () => {
    await history.append(P, { user: 'SECRET-WORDS', reply: 'SECRET-REPLY', tainted: false });
    const dump = JSON.stringify(driver.exec('SELECT * FROM conversation_turns'));
    expect(dump).not.toContain('SECRET-WORDS');
    expect(dump).not.toContain('SECRET-REPLY');
  });

  it(`keeps only the last ${MAX_EXCHANGES} exchanges`, async () => {
    for (let i = 0; i < MAX_EXCHANGES + 3; i++) {
      await history.append(P, { user: `u${i}`, reply: `r${i}`, tainted: false });
    }
    expect(driver.exec('SELECT COUNT(*) AS n FROM conversation_turns')[0]?.['n']).toBe(MAX_EXCHANGES);
    expect((await history.recent(P))[0]?.user).toBe('u3');
  });

  it('forgets an exchange after its time, and a tainted one sooner', async () => {
    await history.append(P, { user: 'clean', reply: 'r', tainted: false });
    await history.append(P, { user: 'tainted', reply: 'r', tainted: true });
    now += TAINTED_HISTORY_TTL_MS + 1;
    expect((await history.recent(P)).map((entry) => entry.user)).toEqual(['clean']);
    now += HISTORY_TTL_MS;
    expect(await history.recent(P)).toEqual([]);
  });

  it('carries the taint flag back', async () => {
    await history.append(P, { user: 'u', reply: 'r', tainted: true });
    expect((await history.recent(P))[0]?.tainted).toBe(true);
  });

  it('drops a row that no longer decrypts, instead of failing every turn', async () => {
    await history.append(P, { user: 'old key', reply: 'r', tainted: false });
    key = KEY_B; // V1 rotated to a different key, nothing re-encrypted
    expect(await history.recent(P)).toEqual([]);
    expect(driver.exec('SELECT COUNT(*) AS n FROM conversation_turns')[0]?.['n']).toBe(0);
  });

  it('never reads another sender\'s rows', async () => {
    await history.append('p_other', { user: 'theirs', reply: 'r', tainted: false });
    expect(await history.recent(P)).toEqual([]);
  });

  it('wipes everything for a sender', async () => {
    await history.append(P, { user: 'u', reply: 'r', tainted: false });
    history.wipe(P);
    expect(await history.recent(P)).toEqual([]);
  });
});
