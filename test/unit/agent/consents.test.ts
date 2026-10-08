/**
 * The consent store and the consent button ids (smart conversations, slice 5,
 * 2026-10-08).
 *
 * A source the user allowed "in this conversation" is a row here: one
 * conversation, one source, never the shared thread, and never a source that
 * holds other people's words (mail, SMS, contacts, notifications), which are
 * approved one turn at a time.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../../src/core/repo.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import {
  consentButtonId,
  consentSourceOf,
  ConversationConsents,
  isConsentSource,
  mayKeepForConversation,
  parseConsentButton,
  revokeButtonId,
} from '../../../src/agent/consents.js';
import { CONSENT_SOURCES, dataSourceOf, TOOL_NAMES } from '../../../src/tools/registry.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';

const NOW = Date.parse('2026-10-08T09:00:00Z');
const P = 'p_consents';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const HEX32 = 'a'.repeat(32);
const NONCE = 'b'.repeat(32);

describe('consent sources', () => {
  it('keeps mail, SMS, contacts and notifications to one turn; the rest may be kept for the conversation', () => {
    expect(CONSENT_SOURCES.filter((source) => !mayKeepForConversation(source)).sort()).toEqual(['contacts', 'mail', 'notifications', 'sms']);
    for (const source of ['calendar', 'reminders', 'tasks', 'drive', 'birthdays', 'calls', 'expenses'] as const) {
      expect(mayKeepForConversation(source), source).toBe(true);
    }
  });

  it("names a tool's consent source, and none for public or private tools", () => {
    expect(consentSourceOf('calendar.list_events')).toBe('calendar');
    expect(consentSourceOf('phone.sms')).toBe('sms');
    expect(consentSourceOf('calc.compute')).toBeNull();
    expect(consentSourceOf('notes.find')).toBeNull();
    for (const name of TOOL_NAMES) {
      const source = dataSourceOf(name);
      expect(consentSourceOf(name), name).toBe(source === 'public' || source === 'private' ? null : source);
    }
  });

  it('recognizes only the closed set', () => {
    expect(isConsentSource('calendar')).toBe(true);
    expect(isConsentSource('public')).toBe(false);
    expect(isConsentSource('private')).toBe(false);
    expect(isConsentSource('Calendar')).toBe(false);
    expect(isConsentSource(7)).toBe(false);
  });
});

describe('ConversationConsents', () => {
  let driver: TestSqlDriver;
  let now: number;
  let consents: ConversationConsents;

  beforeEach(() => {
    driver = new TestSqlDriver();
    new Repository(driver).migrate(MIGRATIONS);
    now = NOW;
    consents = new ConversationConsents(driver, () => now);
  });
  afterEach(() => driver.close());

  const lastUsed = (conversation: string, source: string) =>
    driver.exec('SELECT last_used FROM conversation_consents WHERE principal = ? AND conversation = ? AND source = ?', P, conversation, source)[0]?.[
      'last_used'
    ];

  it('grants a source for one conversation only', () => {
    expect(consents.grant(P, A, 'calendar')).toBe(true);
    expect(consents.consented(P, A, 'calendar')).toBe(true);
    expect(consents.consented(P, B, 'calendar')).toBe(false);
    expect(consents.consented('p_other', A, 'calendar')).toBe(false);
    expect(consents.consented(P, A, 'reminders')).toBe(false);
  });

  it('never stores a once-only source, nor anything for the shared thread', () => {
    for (const source of ['mail', 'sms', 'contacts', 'notifications'] as const) {
      expect(consents.grant(P, A, source)).toBe(false);
      expect(consents.consented(P, A, source)).toBe(false);
    }
    expect(consents.grant(P, '', 'calendar')).toBe(false);
    expect(driver.exec('SELECT COUNT(*) AS n FROM conversation_consents')[0]?.['n']).toBe(0);
  });

  it('lists in a fixed order, and ignores a row it would never have written', () => {
    consents.grant(P, A, 'expenses');
    consents.grant(P, A, 'calendar');
    consents.grant(P, B, 'tasks');
    driver.exec("INSERT INTO conversation_consents (principal, conversation, source, last_used) VALUES (?, ?, 'mail', ?)", P, A, NOW);
    driver.exec("INSERT INTO conversation_consents (principal, conversation, source, last_used) VALUES (?, ?, 'secrets', ?)", P, A, NOW);
    expect(consents.list(P, A)).toEqual(['calendar', 'expenses']);
    expect(consents.list(P, B)).toEqual(['tasks']);
    expect(consents.list(P, '')).toEqual([]);
    // A row for a once-only source counts as not consented, whatever wrote it.
    expect(consents.consented(P, A, 'mail')).toBe(false);
  });

  it('grants twice as once, moving last_used', () => {
    consents.grant(P, A, 'calendar');
    now = NOW + 60_000;
    consents.grant(P, A, 'calendar');
    expect(driver.exec('SELECT COUNT(*) AS n FROM conversation_consents')[0]?.['n']).toBe(1);
    expect(lastUsed(A, 'calendar')).toBe(NOW + 60_000);
  });

  it('touches last_used on use, and only for what was granted', () => {
    consents.grant(P, A, 'calendar');
    now = NOW + 5 * 60_000;
    consents.touch(P, A, ['calendar', 'reminders']);
    expect(lastUsed(A, 'calendar')).toBe(NOW + 5 * 60_000);
    expect(lastUsed(A, 'reminders')).toBeUndefined();
  });

  it('revokes one source of one conversation', () => {
    consents.grant(P, A, 'calendar');
    consents.grant(P, A, 'reminders');
    consents.grant(P, B, 'calendar');
    expect(consents.revoke(P, A, 'calendar')).toBe(true);
    expect(consents.revoke(P, A, 'calendar')).toBe(false);
    expect(consents.list(P, A)).toEqual(['reminders']);
    expect(consents.list(P, B)).toEqual(['calendar']);
  });
});

describe('consent button ids', () => {
  it('fit the app channel alphabet and round-trip', () => {
    for (const verb of ['once', 'conv', 'no'] as const) {
      const id = consentButtonId(HEX32, NONCE, verb);
      expect(id).toMatch(/^[a-z0-9:]{1,256}$/);
      expect(parseConsentButton(id)).toEqual({ kind: 'answer', queryId: HEX32, nonce: NONCE, verb });
    }
    const revoke = revokeButtonId('c'.repeat(24), NONCE);
    expect(revoke).toMatch(/^[a-z0-9:]{1,256}$/);
    expect(parseConsentButton(revoke)).toEqual({ kind: 'revoke', id: 'c'.repeat(24), nonce: NONCE });
  });

  it('refuses anything else, including the confirmation buttons', () => {
    for (const raw of [
      `cs:${HEX32}:${NONCE}:yes`,
      `cs:${HEX32}:${NONCE}`,
      `cs:${HEX32}:${NONCE}:once:x`,
      `cs:${'A'.repeat(32)}:${NONCE}:once`,
      `cs:${HEX32.slice(1)}:${NONCE}:once`,
      `cs:${HEX32}:${NONCE.slice(1)}:once`,
      `cr:${'c'.repeat(24)}:${NONCE}:no`,
      `cr:${'c'.repeat(23)}:${NONCE}:ok`,
      `pa:${'c'.repeat(24)}:${NONCE}:ok`,
      'confirm:0a1b:2c3d',
      '',
    ]) {
      expect(parseConsentButton(raw), raw).toBeNull();
    }
  });
});
