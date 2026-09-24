/**
 * System-command replies (PLAN §6.4, §6.9).
 *
 * These are the only messages the user sees when something is wrong, so they
 * are checked for two things: that they say what actually happened, and that
 * numbers and Latin runs cannot render reversed in a Hebrew sentence.
 */
import { describe, expect, it } from 'vitest';
import { statusText } from '../../../src/render/status.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import { budgetState, BUDGET_WARN_AT, FREE_MESSAGES_PER_MONTH } from '../../../src/policy/window.js';
import { localPartsOf, ZONE } from '../../../src/time/tz.js';

const plain = (text: string) => stripIsolates(text);

const report = (overrides = {}) => ({
  connected: true,
  pendingReminders: 3,
  budget: budgetState(120),
  llmFallbacksToday: 0,
  lastErrorCode: null,
  paused: false,
  ...overrides,
});

describe('/status', () => {
  it('reports the connection, the queue and the month', () => {
    const text = plain(statusText.status(report()));
    expect(text).toContain('מחובר');
    expect(text).toContain('3');
    expect(text).toContain('120/1000');
  });

  it('tells the user how to connect when the calendar is not linked', () => {
    const text = plain(statusText.status(report({ connected: false })));
    expect(text).toContain('לא מחובר');
    expect(text).toContain('/connect google');
  });

  it('says so when the system is paused, and how to undo it', () => {
    const text = plain(statusText.status(report({ paused: true })));
    expect(text).toContain('מושהית');
    expect(text).toContain('/resume');
  });

  it('omits the pause line when running', () => {
    expect(plain(statusText.status(report()))).not.toContain('מושהית');
  });

  it('shows a stable error code, not an error message', () => {
    const text = plain(statusText.status(report({ lastErrorCode: 'E_WA_SEND_401' })));
    expect(text).toContain('E_WA_SEND_401');
  });

  it('omits the error line when there is nothing to report', () => {
    expect(plain(statusText.status(report()))).not.toContain('תקלה אחרונה');
  });

  it('isolates every numeric run so the report cannot render reversed', () => {
    const text = statusText.status(report({ lastErrorCode: 'E_X' }));
    expect(text).not.toBe(plain(text));
    expect(text).toContain('⁦');
  });
});

describe('/budget', () => {
  it('states plain usage well under the cap', () => {
    expect(plain(statusText.budget(budgetState(120)))).toContain('120/1000');
  });

  it('warns with the number remaining', () => {
    const text = plain(statusText.budget(budgetState(BUDGET_WARN_AT)));
    expect(text).toContain('200');
    expect(text).toContain('יומן');
  });

  it('says delivery has moved to the calendar once the cap is reached', () => {
    const text = plain(statusText.budget(budgetState(FREE_MESSAGES_PER_MONTH)));
    expect(text).toContain('נגמרה');
    expect(text).toContain('יומן');
  });

  it('warns once at the crossing, naming both numbers', () => {
    const text = plain(statusText.budgetWarning(budgetState(BUDGET_WARN_AT)));
    expect(text).toContain('800');
    expect(text).toContain('1000');
  });
});

describe('pause and resume', () => {
  it('explains that existing reminders still fire while paused', () => {
    expect(plain(statusText.paused)).toContain('ימשיכו');
    expect(plain(statusText.paused)).toContain('/resume');
  });

  it('confirms resuming', () => {
    expect(statusText.resumed).toContain('פעילה');
  });
});

describe('confirmations', () => {
  it('shows the code-rendered summary and asks', () => {
    const text = statusText.confirmPrompt('מחיקת הפגישה עם יוסי');
    expect(text).toContain('מחיקת הפגישה עם יוסי');
    expect(text).toContain('לאשר?');
  });

  it('has a distinct message for each way a confirmation fails', () => {
    const messages = [
      statusText.confirmExpired,
      statusText.confirmNotFound,
      statusText.confirmAmbiguous,
      statusText.confirmTapButton,
    ];
    expect(new Set(messages).size).toBe(messages.length);
  });

  it('tells the user to tap when two actions are pending', () => {
    expect(statusText.confirmAmbiguous).toContain('כפתור');
  });
});

describe('reminder replies', () => {
  const local = localPartsOf(Date.parse('2026-09-25T11:00:00Z'), ZONE);

  it('echoes weekday, date and time when a reminder is set', () => {
    expect(plain(statusText.reminderSet(local))).toContain('יום ו׳ 25.9 · 14:00');
  });

  it('says why a reminder will arrive through the calendar', () => {
    const text = plain(statusText.calendarFallback(local));
    expect(text).toContain('יומן');
    expect(text).toContain('יום ו׳ 25.9 · 14:00');
  });

  it('states how late a delivery is', () => {
    expect(plain(statusText.lateBy(15))).toContain('15');
  });
});

describe('Hebrew conventions', () => {
  const allStrings = [
    statusText.paused,
    statusText.resumed,
    statusText.alreadyPaused,
    statusText.alreadyRunning,
    statusText.confirmed,
    statusText.cancelled,
    statusText.undone,
    statusText.confirmExpired,
    statusText.confirmNotFound,
    statusText.confirmAmbiguous,
    statusText.confirmTapButton,
    statusText.noReminders,
    statusText.missedWhileOffline,
    plain(statusText.status(report())),
    plain(statusText.budget(budgetState(120))),
  ];

  it('addresses the user without assuming a gender', () => {
    // "אתה יכול" / "תלחץ" would pick one. The neutral forms do not.
    for (const text of allStrings) {
      expect(text, text).not.toMatch(/\bאתה\b|\bאת\s+יכולה\b|\bתלחץ\b|\bתשלח\b/);
    }
  });

  it('uses ktiv maleh', () => {
    for (const text of allStrings) {
      expect(text, text).not.toMatch(/\bתכנה\b|\bשרות\b/);
    }
  });

  it('carries no ASCII double quotes, which collide with gershayim', () => {
    for (const text of allStrings) {
      expect(text, text).not.toContain('"');
    }
  });
});
