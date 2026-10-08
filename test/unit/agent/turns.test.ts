/**
 * Turns waiting for the phone (PLAN §6.21): taken once, encrypted while they
 * wait, cleared the moment they settle, and never continued after a newer turn
 * or after their three minutes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../../src/core/repo.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import { parseKeyring } from '../../../src/security/crypto.js';
import { SuspendedTurns, SETTLED_KEEP_MS, SUSPEND_TTL_MS } from '../../../src/agent/turns.js';
import type { SuspendedState } from '../../../src/agent/loop.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';

const NOW = Date.parse('2026-09-24T09:00:00Z');
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
const OTHER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(6)));
const PRINCIPAL = 'p_turns';

const state = (overrides: Partial<SuspendedState> = {}): SuspendedState =>
  ({
  model: 'fake-model',
  messages: [
    { role: 'user', content: 'מה כתבו לי ב-SMS?' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'phone__sms', arguments: '{}' } }],
    },
  ],
  spent: 1200,
  calls: 1,
  tainted: false,
  text: 'מה כתבו לי ב-SMS?',
  lang: 'he',
  cards: true,
  toolCallId: 'call_1',
  tool: 'phone.sms',
  query: { kind: 'sms', hours: 24 },
  ...overrides,
  }) as SuspendedState;

describe('suspended turns', () => {
  let driver: TestSqlDriver;
  let now: number;
  let key: string;
  let turns: SuspendedTurns;

  beforeEach(() => {
    driver = new TestSqlDriver();
    new Repository(driver).migrate(MIGRATIONS);
    now = NOW;
    key = KEY;
    turns = new SuspendedTurns(driver, () => now, () => parseKeyring({ TOKEN_ENC_KEY_V1: key }));
  });
  afterEach(() => driver.close());

  const ciphertextOf = (queryId: string) =>
    driver.exec('SELECT ciphertext FROM agent_turns WHERE query_id = ?', queryId)[0]?.['ciphertext'];

  it('stores the turn encrypted, and gives it back whole', async () => {
    const queryId = await turns.suspend(PRINCIPAL, 'app:in:1', state());
    expect(queryId).toMatch(/^[0-9a-f]{32}$/);
    expect(String(ciphertextOf(queryId))).not.toContain('SMS');

    const begun = turns.begin(queryId, PRINCIPAL);
    expect(begun).toMatchObject({ kind: 'run', wamid: 'app:in:1' });
    if (begun.kind !== 'run') return;
    expect(await turns.open(queryId, PRINCIPAL, begun.ciphertext)).toEqual(state());
  });

  it('lets a result continue the turn once; a second finds it running, then done', async () => {
    const queryId = await turns.suspend(PRINCIPAL, 'app:in:1', state());
    expect(turns.begin(queryId, PRINCIPAL).kind).toBe('run');
    expect(turns.begin(queryId, PRINCIPAL)).toEqual({ kind: 'settled', wamid: 'app:in:1', status: 'running' });

    turns.finish(queryId);
    expect(turns.begin(queryId, PRINCIPAL)).toEqual({ kind: 'settled', wamid: 'app:in:1', status: 'done' });
    expect(ciphertextOf(queryId)).toBeNull();
  });

  it('answers another sender, or an unknown id, with not_found', async () => {
    const queryId = await turns.suspend(PRINCIPAL, 'app:in:1', state());
    expect(turns.begin(queryId, 'p_someone_else')).toEqual({ kind: 'not_found' });
    expect(turns.begin('0'.repeat(32), PRINCIPAL)).toEqual({ kind: 'not_found' });
    // And the real one is still waiting.
    expect(turns.begin(queryId, PRINCIPAL).kind).toBe('run');
  });

  it('does not decrypt under another sender or another query id', async () => {
    const first = await turns.suspend(PRINCIPAL, 'app:in:1', state());
    const second = await turns.suspend(PRINCIPAL, 'app:in:2', state());
    const ciphertext = String(ciphertextOf(first));
    expect(await turns.open(first, 'p_someone_else', ciphertext)).toBeNull();
    expect(await turns.open(second, PRINCIPAL, ciphertext)).toBeNull();
  });

  it('reads a turn written under a rotated-out key as absent', async () => {
    const queryId = await turns.suspend(PRINCIPAL, 'app:in:1', state());
    key = OTHER_KEY;
    expect(await turns.open(queryId, PRINCIPAL, String(ciphertextOf(queryId)))).toBeNull();
  });

  it('is superseded by a newer turn: the text goes, and it cannot be continued', async () => {
    const queryId = await turns.suspend(PRINCIPAL, 'app:in:1', state());
    turns.supersede(PRINCIPAL);
    expect(ciphertextOf(queryId)).toBeNull();
    expect(turns.begin(queryId, PRINCIPAL)).toEqual({ kind: 'settled', wamid: 'app:in:1', status: 'superseded' });
  });

  it('expires after three minutes, on read and in the sweep, and the alarm knows when', async () => {
    const queryId = await turns.suspend(PRINCIPAL, 'app:in:1', state());
    expect(turns.nextExpiryAt()).toBe(NOW + SUSPEND_TTL_MS);

    now = NOW + SUSPEND_TTL_MS;
    expect(turns.expireDue()).toEqual([{ wamid: 'app:in:1', principal: PRINCIPAL, kind: 'phone' }]);
    expect(turns.expireDue()).toEqual([]);
    expect(ciphertextOf(queryId)).toBeNull();
    expect(turns.nextExpiryAt()).toBeNull();
    expect(turns.begin(queryId, PRINCIPAL)).toMatchObject({ kind: 'settled', status: 'expired' });
  });

  it('refuses a late result even before the sweep ran', async () => {
    const queryId = await turns.suspend(PRINCIPAL, 'app:in:1', state());
    now = NOW + SUSPEND_TTL_MS + 1;
    expect(turns.begin(queryId, PRINCIPAL)).toMatchObject({ kind: 'settled', status: 'expired' });
    expect(ciphertextOf(queryId)).toBeNull();
  });

  it('finds the newest turn of a message, for a retry of it', async () => {
    const queryId = await turns.suspend(PRINCIPAL, 'app:in:1', state());
    expect(turns.byWamid('app:in:1')).toMatchObject({ queryId, principal: PRINCIPAL, status: 'waiting' });
    expect(turns.byWamid('app:in:9')).toBeNull();
  });

  it('is wiped by /forget and /pair off, and purged an hour after it started', async () => {
    const wiped = await turns.suspend(PRINCIPAL, 'app:in:1', state());
    turns.wipe(PRINCIPAL);
    expect(turns.byWamid('app:in:1')).toBeNull();
    expect(turns.begin(wiped, PRINCIPAL)).toEqual({ kind: 'not_found' });

    await turns.suspend(PRINCIPAL, 'app:in:2', state());
    now = NOW + SETTLED_KEEP_MS;
    turns.purgeOld();
    expect(turns.byWamid('app:in:2')).toBeNull();
  });

  it('rejects a stored turn that does not have the right shape', async () => {
    const queryId = await turns.suspend(PRINCIPAL, 'app:in:1', state({ tool: 'not.a_tool' as never }));
    expect(await turns.open(queryId, PRINCIPAL, String(ciphertextOf(queryId)))).toBeNull();
  });

  describe("a Gemini 3 call's thought signature (2026-10-08)", () => {
    const signed = (signature: string): SuspendedState =>
      state({
        messages: [
          { role: 'user', content: 'מה כתבו לי ב-SMS?' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'phone__sms', arguments: '{}' },
                extra_content: { google: { thought_signature: signature } },
              },
            ],
          },
        ],
      });

    it('keeps it on the stored call, so the resumed request sends it back', async () => {
      const queryId = await turns.suspend(PRINCIPAL, 'app:in:1', signed('CiQBjz1rX+abc/def=_-'));
      expect(String(ciphertextOf(queryId))).not.toContain('CiQBjz1rX');
      expect(await turns.open(queryId, PRINCIPAL, String(ciphertextOf(queryId)))).toEqual(signed('CiQBjz1rX+abc/def=_-'));
    });

    it('refuses a stored call whose signature is not the shape a model sends', async () => {
      for (const bad of ['has space', '', 'a'.repeat(16_385)]) {
        const queryId = await turns.suspend(PRINCIPAL, `app:in:${bad.length}`, signed(bad));
        expect(await turns.open(queryId, PRINCIPAL, String(ciphertextOf(queryId)))).toBeNull();
      }
    });
  });
});
