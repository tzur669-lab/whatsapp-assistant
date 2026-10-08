/**
 * Turns waiting for the user's consent (smart conversations, slice 5): the same
 * table as the phone's, told apart by `kind`, taken once by a tap that carries
 * the row's nonce — never by the phone's result path, never by a guess.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../../src/core/repo.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import { parseKeyring } from '../../../src/security/crypto.js';
import { SuspendedTurns, SUSPEND_TTL_MS } from '../../../src/agent/turns.js';
import type { SuspendedState } from '../../../src/agent/loop.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';

const NOW = Date.parse('2026-10-08T09:00:00Z');
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
const PRINCIPAL = 'p_consent_turns';
const CONVERSATION = '11111111-1111-4111-8111-111111111111';

const consentState = (overrides: Partial<SuspendedState> = {}): SuspendedState =>
  ({
    model: 'gemini-fake',
    conversation: CONVERSATION,
    mode: 'smart',
    kind: 'consent',
    source: 'calendar',
    messages: [
      { role: 'user', content: 'מה יש לי מחר?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'calendar__list_events', arguments: '{}' } }],
      },
    ],
    spent: 900,
    calls: 1,
    tainted: false,
    text: 'מה יש לי מחר?',
    lang: 'he',
    cards: true,
    toolCallId: 'call_1',
    tool: 'calendar.list_events',
    ...overrides,
  }) as SuspendedState;

const phoneState = (): SuspendedState => ({
  model: 'fake-model',
  messages: [
    { role: 'user', content: 'מה כתבו לי ב-SMS?' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'phone__sms', arguments: '{}' } }] },
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
});

describe('consent turns', () => {
  let driver: TestSqlDriver;
  let now: number;
  let turns: SuspendedTurns;

  beforeEach(() => {
    driver = new TestSqlDriver();
    new Repository(driver).migrate(MIGRATIONS);
    now = NOW;
    turns = new SuspendedTurns(driver, () => now, () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY }));
  });
  afterEach(() => driver.close());

  const row = (queryId: string) => driver.exec('SELECT * FROM agent_turns WHERE query_id = ?', queryId)[0]!;

  it('stores the turn encrypted, with its kind, source and conversation, and only a hash of the nonce', async () => {
    const { queryId, nonce } = await turns.suspendForConsent(PRINCIPAL, 'app:in:1', consentState());
    expect(queryId).toMatch(/^[0-9a-f]{32}$/);
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    const stored = row(queryId);
    expect(stored).toMatchObject({ kind: 'consent', source: 'calendar', conversation: CONVERSATION, status: 'waiting' });
    expect(String(stored['ciphertext'])).not.toContain('מחר');
    expect(JSON.stringify(stored)).not.toContain(nonce);
    expect(stored['expires_at']).toBe(NOW + SUSPEND_TTL_MS);

    const begun = turns.beginConsent(queryId, PRINCIPAL, nonce, false);
    if (begun.kind !== 'run') throw new Error('expected run');
    expect(begun).toMatchObject({ wamid: 'app:in:1', source: 'calendar', conversation: CONVERSATION });
    expect(await turns.open(queryId, PRINCIPAL, begun.ciphertext)).toEqual(consentState());
  });

  it('is taken once: a second tap finds it running, then done', async () => {
    const { queryId, nonce } = await turns.suspendForConsent(PRINCIPAL, 'app:in:1', consentState());
    expect(turns.beginConsent(queryId, PRINCIPAL, nonce, true).kind).toBe('run');
    expect(turns.beginConsent(queryId, PRINCIPAL, nonce, false)).toMatchObject({ kind: 'settled', status: 'running' });
    turns.finish(queryId);
    expect(turns.beginConsent(queryId, PRINCIPAL, nonce, false)).toMatchObject({ kind: 'settled', status: 'done' });
  });

  it('refuses a wrong nonce, another sender or an unknown id, and leaves the turn waiting', async () => {
    const { queryId, nonce } = await turns.suspendForConsent(PRINCIPAL, 'app:in:1', consentState());
    expect(turns.beginConsent(queryId, PRINCIPAL, 'c'.repeat(32), false)).toEqual({ kind: 'refused' });
    expect(turns.beginConsent(queryId, 'p_other', nonce, false)).toEqual({ kind: 'refused' });
    expect(turns.beginConsent('d'.repeat(32), PRINCIPAL, nonce, false)).toEqual({ kind: 'refused' });
    expect(row(queryId)['status']).toBe('waiting');
    expect(turns.beginConsent(queryId, PRINCIPAL, nonce, false).kind).toBe('run');
  });

  it('refuses "this conversation" for a source that offers only "this time", and leaves the turn waiting', async () => {
    for (const source of ['mail', 'sms', 'contacts', 'notifications'] as const) {
      const { queryId, nonce } = await turns.suspendForConsent(PRINCIPAL, `app:in:${source}`, consentState({ source } as never));
      expect(turns.beginConsent(queryId, PRINCIPAL, nonce, true), source).toEqual({ kind: 'refused' });
      expect(row(queryId)['status']).toBe('waiting');
      expect(turns.beginConsent(queryId, PRINCIPAL, nonce, false).kind).toBe('run');
    }
  });

  it('expires after three minutes, and a newer turn supersedes it', async () => {
    const first = await turns.suspendForConsent(PRINCIPAL, 'app:in:1', consentState());
    now = NOW + SUSPEND_TTL_MS;
    expect(turns.beginConsent(first.queryId, PRINCIPAL, first.nonce, false)).toMatchObject({ kind: 'settled', status: 'expired' });
    expect(row(first.queryId)['ciphertext']).toBeNull();

    now = NOW;
    const second = await turns.suspendForConsent(PRINCIPAL, 'app:in:2', consentState());
    turns.supersede(PRINCIPAL);
    expect(turns.beginConsent(second.queryId, PRINCIPAL, second.nonce, false)).toMatchObject({ kind: 'settled', status: 'superseded' });
  });

  it("is never taken by the phone's result path, and a phone turn never by a tap", async () => {
    const consent = await turns.suspendForConsent(PRINCIPAL, 'app:in:1', consentState());
    expect(turns.begin(consent.queryId, PRINCIPAL)).toEqual({ kind: 'not_found' });
    expect(row(consent.queryId)['status']).toBe('waiting');

    const phone = await turns.suspend(PRINCIPAL, 'app:in:2', phoneState());
    expect(row(phone)['kind']).toBe('phone');
    expect(turns.beginConsent(phone, PRINCIPAL, consent.nonce, false)).toEqual({ kind: 'refused' });
    expect(row(phone)['status']).toBe('waiting');
  });

  it('says which kind a retry or the sweep found', async () => {
    const consent = await turns.suspendForConsent(PRINCIPAL, 'app:in:1', consentState());
    await turns.suspend(PRINCIPAL, 'app:in:2', phoneState());
    expect(turns.byWamid('app:in:1')).toMatchObject({ queryId: consent.queryId, kind: 'consent', status: 'waiting' });
    expect(turns.byWamid('app:in:2')).toMatchObject({ kind: 'phone' });

    now = NOW + SUSPEND_TTL_MS;
    const expired = turns.expireDue().sort((a, b) => a.wamid.localeCompare(b.wamid));
    expect(expired).toEqual([
      { wamid: 'app:in:1', principal: PRINCIPAL, kind: 'consent' },
      { wamid: 'app:in:2', principal: PRINCIPAL, kind: 'phone' },
    ]);
  });

  it('rejects a stored consent turn without a source, or a phone turn without a query', async () => {
    const { source: _source, ...noSource } = consentState() as SuspendedState & { source: string };
    const bad = await turns.suspendForConsent(PRINCIPAL, 'app:in:1', { ...noSource, source: 'calendar' } as never);
    const begun = turns.beginConsent(bad.queryId, PRINCIPAL, bad.nonce, false);
    if (begun.kind !== 'run') throw new Error('expected run');
    // Re-encrypt a state that lost its source: it must not open.
    const { encryptToken } = await import('../../../src/security/crypto.js');
    const keyring = parseKeyring({ TOKEN_ENC_KEY_V1: KEY });
    const aad = { provider: 'agent-turns', account: `${PRINCIPAL}:${bad.queryId}` };
    const broken = await encryptToken(JSON.stringify(noSource), keyring, aad);
    expect(await turns.open(bad.queryId, PRINCIPAL, broken)).toBeNull();
    const { query: _query, ...noQuery } = phoneState() as SuspendedState & { query: unknown };
    expect(await turns.open(bad.queryId, PRINCIPAL, await encryptToken(JSON.stringify(noQuery), keyring, aad))).toBeNull();
  });
});
