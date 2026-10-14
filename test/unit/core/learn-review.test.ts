/**
 * The weekly review, its proposals and the export (block K, K2–K3, PLAN §6.31).
 *
 * Habits abstain rather than guess; a tap applies the stored value through
 * the command's own setter, once per group, in one transaction; the export is
 * scrubbed, capped in bytes, and never splits a pair.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../../src/core/repo.js';
import { LEARN_NOTICE_VERSION, LearnStore, PROPOSAL_KEPT_MS, PROPOSAL_TTL_MS, weekStartOf } from '../../../src/core/learn-store.js';
import type { LearnTurn } from '../../../src/core/learn-store.js';
import { digestHourCandidate, firstMessageMinutes, leaveMinutesCandidate, ratePer100 } from '../../../src/core/habits.js';
import { planReview, QUESTION_BANK, reviewDue, trendOf } from '../../../src/core/learn-review.js';
import { buildLearnExport, fitRecords, LEARN_EXPORT_MAX_BYTES } from '../../../src/core/learn-export.js';
import type { ExportRecord } from '../../../src/core/learn-export.js';
import { matchCommand } from '../../../src/core/router.js';
import { learnText } from '../../../src/render/learn.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import { parseKeyring } from '../../../src/security/crypto.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';

const PRINCIPAL = 'p_learn';
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const keyring = () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY });
const DAY = 24 * 60 * 60 * 1000;

/** A Jerusalem wall-clock instant in October 2026 (UTC+3 until the 25th at 02:00, then UTC+2). */
const at = (day: number, hour: number, minute = 0) => {
  const offset = day > 25 || (day === 25 && hour >= 2) ? 2 : 3;
  return Date.UTC(2026, 9, day, hour - offset, minute);
};

describe('habits', () => {
  it('ordinary mornings propose their hour', () => {
    const times = Array.from({ length: 8 }, (_, i) => at(1 + i, 7, 10 + i));
    expect(digestHourCandidate(times, 9)).toBe(7);
  });

  it('the same hour as today, or a digest that is off, proposes nothing', () => {
    const times = Array.from({ length: 8 }, (_, i) => at(1 + i, 7, 10));
    expect(digestHourCandidate(times, 7)).toBeNull();
    expect(digestHourCandidate(times, null)).toBeNull();
  });

  it('fewer than 7 days: nothing', () => {
    expect(digestHourCandidate(Array.from({ length: 6 }, (_, i) => at(1 + i, 7)), 9)).toBeNull();
  });

  it('a midnight cluster stays together, its median 00:15 is outside the window: nothing, never clamped', () => {
    const times = Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? at(2 + i, 23, 50) : at(2 + i, 0, 15)));
    expect(firstMessageMinutes(times).every((m) => m >= 19 * 60)).toBe(true);
    expect(digestHourCandidate(times, 9)).toBeNull();
  });

  it('a median of 12:30 or 01:00: nothing', () => {
    expect(digestHourCandidate(Array.from({ length: 8 }, (_, i) => at(1 + i, 12, 30)), 9)).toBeNull();
    expect(digestHourCandidate(Array.from({ length: 8 }, (_, i) => at(1 + i, 1, 0)), 9)).toBeNull();
  });

  it('scattered days: nothing', () => {
    const hours = [5, 8, 11, 6, 10, 7, 11, 5];
    expect(digestHourCandidate(hours.map((h, i) => at(1 + i, h)), 9)).toBeNull();
  });

  it('03:59 belongs to the day before, 04:00 starts a new one', () => {
    expect(firstMessageMinutes([at(5, 3, 59), at(5, 7)])).toHaveLength(2);
    expect(firstMessageMinutes([at(5, 4, 0), at(5, 7)])).toEqual([0]);
  });

  it('the fall-back on 2026-10-25 buckets by wall clock', () => {
    const times = [20, 21, 22, 23, 24, 25, 26, 27].map((day) => at(day, 7, 30));
    expect(new Set(firstMessageMinutes(times))).toEqual(new Set([3 * 60 + 30]));
    expect(digestHourCandidate(times, 9)).toBe(7);
  });

  it('travel times: three said, not today\'s default, inside the bounds', () => {
    const bounds = { min: 10, max: 120 };
    expect(leaveMinutesCandidate([20, 20], 30, bounds)).toBeNull();
    expect(leaveMinutesCandidate([20, 25, 20], 30, bounds)).toBe(20);
    expect(leaveMinutesCandidate([30, 30, 25], 30, bounds)).toBeNull();
    expect(leaveMinutesCandidate([5, 5, 5], 30, bounds)).toBeNull();
  });

  it('a week with no messages has no rate', () => {
    expect(ratePer100(1, 0)).toBeNull();
    expect(ratePer100(3, 40)).toBe(7.5);
  });

  it('the review is due on Sunday from 10:00 local', () => {
    expect(reviewDue(at(25, 9, 59))).toBe(false);
    expect(reviewDue(at(25, 10))).toBe(true);
    expect(reviewDue(at(26, 10))).toBe(false);
  });
});

describe('the weekly review in the store', () => {
  let driver: TestSqlDriver;
  let repo: Repository;
  let now: number;
  let learn: LearnStore;

  const start = (atMs: number) => {
    now = atMs;
    expect(learn.turnOn()).toBe('notice');
    learn.noticeQueued(LEARN_NOTICE_VERSION, 1);
    learn.acked([1]);
  };
  const inbound = (wamid: string, receivedAt: number, extra: { kind?: string; intent?: string; decision?: string } = {}) =>
    driver.exec(
      'INSERT INTO inbound_messages (wamid, principal, received_at, sent_at, kind, intent, decision) VALUES (?, ?, ?, ?, ?, ?, ?)',
      wamid,
      PRINCIPAL,
      receivedAt,
      receivedAt,
      extra.kind ?? 'text',
      extra.intent ?? null,
      extra.decision ?? null,
    );
  const status = (id: string) => String(driver.exec('SELECT status FROM learn_proposals WHERE id = ?', id)[0]?.['status']);

  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    now = at(1, 12);
    learn = new LearnStore(driver, repo, () => now, keyring);
  });
  afterEach(() => driver.close());

  describe('first messages', () => {
    it('leave out buttons, commands and anything before learning started', () => {
      inbound('before', at(1, 6));
      start(at(1, 12));
      inbound('text', at(2, 7));
      inbound('button', at(3, 6), { kind: 'button' });
      inbound('tapped', at(3, 6, 5), { decision: 'BUTTON' });
      inbound('digest', at(4, 6), { intent: 'digest' });
      inbound('learn', at(4, 6, 1), { intent: 'learn' });
      inbound('leave', at(4, 6, 2), { intent: 'leave' });
      expect(learn.firstMessageTimes(PRINCIPAL, learn.startOf('first_message')!)).toEqual([at(2, 7)]);
    });

    it('a duplicate message id is one row', () => {
      start(at(1, 12));
      inbound('same', at(2, 7));
      expect(() => inbound('same', at(2, 7))).toThrow();
      expect(learn.firstMessageTimes(PRINCIPAL, 0)).toHaveLength(1);
    });
  });

  describe('planReview', () => {
    it('proposes the digest hour and a travel time, at most two, and asks no question about them', () => {
      start(at(1, 12));
      repo.setDigestHour(9);
      for (let day = 2; day <= 10; day++) inbound(`m${day}`, at(day, 7, 5));
      for (const minutes of [20, 20, 25]) learn.addLeave(PRINCIPAL, minutes, true);
      learn.addLeave(PRINCIPAL, 30, false);
      now = at(11, 10);
      const plan = planReview({ nowMs: now, principal: PRINCIPAL, store: learn, repo });
      expect(plan.proposals.map((p) => [p.kind, p.value])).toEqual([
        ['digest_hour', 7],
        ['leave_min', 20],
      ]);
      expect(plan.question).toBeNull();
      expect(plan.exportDue).toBe(false);
    });

    it('a pending proposal of a kind blocks a new one of it', () => {
      start(at(1, 12));
      for (const minutes of [20, 20, 25]) learn.addLeave(PRINCIPAL, minutes, true);
      learn.insertGroup(PRINCIPAL, [{ kind: 'leave_min', value: 15 }]);
      now = at(4, 10);
      expect(planReview({ nowMs: now, principal: PRINCIPAL, store: learn, repo }).proposals).toEqual([]);
    });

    it('off: nothing is read, nothing is proposed', () => {
      repo.setDigestHour(9);
      for (let day = 2; day <= 10; day++) inbound(`m${day}`, at(day, 7, 5));
      now = at(11, 10);
      expect(planReview({ nowMs: now, principal: PRINCIPAL, store: learn, repo }).proposals).toEqual([]);
    });

    it('the question drops today\'s value and is skipped for an off digest', () => {
      start(at(1, 12));
      for (let week = 0; week < QUESTION_BANK.length; week++) {
        const nowMs = week * 7 * DAY + 3 * DAY;
        const entry = QUESTION_BANK[Math.floor(nowMs / (7 * DAY)) % QUESTION_BANK.length]!;
        const plan = planReview({ nowMs, principal: PRINCIPAL, store: learn, repo });
        if (entry.kind === 'digest_hour') expect(plan.question).toBeNull();
        else expect(plan.question?.values).toEqual(entry.values.filter((v) => v !== 30));
      }
    });

    it('the first review of a month reminds about the export', () => {
      start(at(1, 12));
      expect(planReview({ nowMs: at(4, 10), principal: PRINCIPAL, store: learn, repo }).exportDue).toBe(true);
    });
  });

  describe('trend', () => {
    const week = (sunday: number, counts: { messages: number; misses: number; rephrases: number }) =>
      driver.exec(
        'INSERT INTO learn_weeks (principal, week_start, messages, misses, rephrases) VALUES (?, ?, ?, ?, ?)',
        PRINCIPAL,
        weekStartOf(sunday),
        counts.messages,
        counts.misses,
        counts.rephrases,
      );

    it('separate rates against the mean of the weeks before', () => {
      start(Date.UTC(2026, 7, 1));
      const review = at(25, 10);
      week(review - 7 * DAY, { messages: 50, misses: 2, rephrases: 1 });
      week(review - 14 * DAY, { messages: 40, misses: 4, rephrases: 0 });
      week(review - 21 * DAY, { messages: 20, misses: 0, rephrases: 2 });
      expect(trendOf(learn, PRINCIPAL, review)).toEqual({
        messages: 50,
        misses: { now: 4, before: 5 },
        rephrases: { now: 2, before: 5 },
        combined: { now: 6, before: 10 },
      });
    });

    it('fewer than two weeks before: no comparison; a quiet week: no rate', () => {
      start(Date.UTC(2026, 7, 1));
      const review = at(25, 10);
      week(review - 14 * DAY, { messages: 40, misses: 4, rephrases: 0 });
      const trend = trendOf(learn, PRINCIPAL, review);
      expect(trend.messages).toBe(0);
      expect(trend.misses).toEqual({ now: null, before: null });
    });

    it('a week that started before learning is no data, never a zero', () => {
      const review = at(25, 10);
      start(review - 5 * DAY);
      week(review - 7 * DAY, { messages: 50, misses: 2, rephrases: 1 });
      expect(trendOf(learn, PRINCIPAL, review).messages).toBeNull();
      expect(stripIsolates(learnText.review(trendOf(learn, PRINCIPAL, review), false))).toContain('אין מספיק נתונים');
    });
  });

  describe('proposals', () => {
    it('ok applies the stored value through the setter, once', () => {
      start(at(1, 12));
      const [row] = learn.insertGroup(PRINCIPAL, [{ kind: 'leave_min', value: 20 }]);
      expect(learn.answerProposal(PRINCIPAL, row!.id, row!.nonce, true)).toEqual({ kind: 'applied', proposal: 'leave_min', value: 20 });
      expect(repo.leaveDefaultMinutes()).toBe(20);
      expect(learn.answerProposal(PRINCIPAL, row!.id, row!.nonce, true)).toEqual({ kind: 'answered' });
    });

    it('the digest hour goes through the /digest setter', () => {
      start(at(1, 12));
      repo.setDigestHour(9);
      const [row] = learn.insertGroup(PRINCIPAL, [{ kind: 'digest_hour', value: 7 }]);
      learn.answerProposal(PRINCIPAL, row!.id, row!.nonce, true);
      expect(repo.digestHour()).toBe(7);
    });

    it('no declines a proposal and changes nothing', () => {
      start(at(1, 12));
      const [row] = learn.insertGroup(PRINCIPAL, [{ kind: 'leave_min', value: 20 }]);
      expect(learn.answerProposal(PRINCIPAL, row!.id, row!.nonce, false)).toEqual({ kind: 'declined' });
      expect(repo.leaveDefaultMinutes()).toBeNull();
      expect(learn.answerProposal(PRINCIPAL, row!.id, row!.nonce, true)).toEqual({ kind: 'answered' });
      expect(repo.leaveDefaultMinutes()).toBeNull();
    });

    it('two answers of a question tapped back to back: one accepted, the other superseded', () => {
      start(at(1, 12));
      const [a, b, c] = learn.insertGroup(PRINCIPAL, [15, 20, 45].map((value) => ({ kind: 'leave_min' as const, value })));
      expect(learn.answerProposal(PRINCIPAL, b!.id, b!.nonce, true).kind).toBe('applied');
      expect(learn.answerProposal(PRINCIPAL, a!.id, a!.nonce, true)).toEqual({ kind: 'answered' });
      expect([status(a!.id), status(b!.id), status(c!.id)]).toEqual(['superseded', 'accepted', 'superseded']);
      expect(repo.leaveDefaultMinutes()).toBe(20);
    });

    it('no on a question answer changes nothing', () => {
      start(at(1, 12));
      const [a] = learn.insertGroup(PRINCIPAL, [15, 20].map((value) => ({ kind: 'leave_min' as const, value })));
      learn.answerProposal(PRINCIPAL, a!.id, a!.nonce, false);
      expect(status(a!.id)).toBe('pending');
    });

    it('a wrong nonce or another sender finds nothing', () => {
      start(at(1, 12));
      const [row] = learn.insertGroup(PRINCIPAL, [{ kind: 'leave_min', value: 20 }]);
      expect(learn.answerProposal(PRINCIPAL, row!.id, 'ab'.repeat(8), true)).toEqual({ kind: 'gone' });
      expect(learn.answerProposal('p_other', row!.id, row!.nonce, true)).toEqual({ kind: 'gone' });
      expect(status(row!.id)).toBe('pending');
    });

    it('expired after 6 days, and cancelled by /learn off', () => {
      start(at(1, 12));
      const [late] = learn.insertGroup(PRINCIPAL, [{ kind: 'leave_min', value: 20 }]);
      now += PROPOSAL_TTL_MS + 1;
      expect(learn.answerProposal(PRINCIPAL, late!.id, late!.nonce, true)).toEqual({ kind: 'expired' });
      const [row] = learn.insertGroup(PRINCIPAL, [{ kind: 'leave_min', value: 25 }]);
      learn.turnOff();
      expect(status(row!.id)).toBe('cancelled');
      expect(learn.answerProposal(PRINCIPAL, row!.id, row!.nonce, true)).toEqual({ kind: 'expired' });
      expect(repo.leaveDefaultMinutes()).toBeNull();
    });

    it('a setter that throws rolls the claim back', () => {
      start(at(1, 12));
      const [row] = learn.insertGroup(PRINCIPAL, [{ kind: 'leave_min', value: 500 }]);
      expect(() => learn.answerProposal(PRINCIPAL, row!.id, row!.nonce, true)).toThrow();
      expect(status(row!.id)).toBe('pending');
      expect(repo.leaveDefaultMinutes()).toBeNull();
    });

    it('a proposal never touches anything but its one setting', () => {
      start(at(1, 12));
      const before = driver.exec("SELECT key, value FROM settings WHERE key NOT LIKE 'learn_%' ORDER BY key");
      const [row] = learn.insertGroup(PRINCIPAL, [{ kind: 'leave_min', value: 20 }]);
      learn.answerProposal(PRINCIPAL, row!.id, row!.nonce, true);
      const after = driver.exec("SELECT key, value FROM settings WHERE key NOT LIKE 'learn_%' ORDER BY key");
      expect(after).toHaveLength(before.length + 1);
      expect(after).toEqual(expect.arrayContaining([...before, { key: 'leave_default_min', value: '20' }]));
    });

    it('maintenance expires pending rows, then deletes ended rows after 90 days, never a pending one', () => {
      start(at(1, 12));
      const [pending] = learn.insertGroup(PRINCIPAL, [{ kind: 'leave_min', value: 20 }]);
      const [declined] = learn.insertGroup(PRINCIPAL, [{ kind: 'digest_hour', value: 7 }]);
      learn.answerProposal(PRINCIPAL, declined!.id, declined!.nonce, false);
      driver.exec('UPDATE learn_proposals SET expires_at = ? WHERE id = ?', now + 365 * DAY, pending!.id);
      now += PROPOSAL_KEPT_MS + 1;
      expect(learn.purgeProposals()).toEqual({ expired: 0, deleted: 1 });
      expect(status(pending!.id)).toBe('pending');
    });

    it('/learn forget deletes them', () => {
      start(at(1, 12));
      learn.insertGroup(PRINCIPAL, [{ kind: 'leave_min', value: 20 }]);
      expect(learn.forget(PRINCIPAL).proposals).toBe(1);
    });
  });

  describe('export', () => {
    const turn = (user: string): LearnTurn => ({ user, reply: 'לא הבנתי', outcome: 'CLARIFY', intent: 'agent' });

    it('scrubs phones, emails and links, keeps Hebrew, keeps a pair whole', async () => {
      start(at(1, 12));
      const phones = ['050-000-0000', '+972 50 000 0000', '03-000-0000', '(050) 0000000'];
      const sealed = await learn.sealRephrase(
        PRINCIPAL,
        turn(`תתקשר ל-${phones[0]} ול-${phones[1]} ולבית ${phones[2]} או ${phones[3]}`),
        turn('שלח מייל ל-test@example.com וגם ל-בדיקה@example.com על https://example.com/x'),
        { gapSeconds: 40, tools: ['calls.place'] },
      );
      learn.insertSealed(sealed!);
      now += 1_000;
      const miss = await learn.sealMiss(PRINCIPAL, turn('תזכיר לי מחר בבוקר'));
      learn.insertSealed(miss!);
      learn.addTap(PRINCIPAL, 'undo', 'reminders.create', 5);
      learn.addLeave(PRINCIPAL, 20, true);

      const text = await buildLearnExport({ store: learn, principal: PRINCIPAL, nowMs: now });
      for (const phone of phones) expect(text).not.toContain(phone);
      expect(text).not.toContain('test@example.com');
      expect(text).not.toContain('בדיקה@example.com');
      expect(text).not.toContain('https://example.com');
      expect(text).toContain('תזכיר לי מחר בבוקר');
      const parsed = JSON.parse(text) as {
        schema: number;
        note: string;
        records: ExportRecord[];
        taps: unknown[];
        leave: unknown;
        truncated: unknown;
      };
      expect(parsed.schema).toBe(1);
      expect(parsed.note).toContain('not anonymized');
      expect(parsed.records.map((r) => [r.type, r.confidence])).toEqual([
        ['miss', 'reported'],
        ['pair', 'heuristic'],
      ]);
      expect(parsed.taps).toEqual([{ tool: 'reminders.create', undo: 1, confirmNo: 0, medianSeconds: 5 }]);
      expect(parsed.leave).toEqual({ count: 1, stated: 1, medianStatedMinutes: 20 });
      expect(parsed.truncated).toEqual({ pairs: 0, misses: 0 });
    });

    it('another principal\'s rows are never in it', async () => {
      start(at(1, 12));
      learn.addLeave('p_other', 20, true);
      const parsed = JSON.parse(await buildLearnExport({ store: learn, principal: PRINCIPAL, nowMs: now })) as { leave: { count: number } };
      expect(parsed.leave.count).toBe(0);
    });

    it('cuts whole records, newest first, under the byte cap with Hebrew and 4-byte emoji at full length', () => {
      const long = ('שלום🙂'.repeat(200)).slice(0, 1_200);
      const unit = (i: number): ExportRecord => ({
        type: 'pair',
        at: new Date(i).toISOString(),
        confidence: 'heuristic',
        gapSeconds: 1,
        tools: [],
        failed: { user: long, reply: long, outcome: 'CLARIFY', intent: null },
        fixed: { user: long, reply: long, outcome: 'ALLOW', intent: null },
      });
      const records = Array.from({ length: 80 }, (_, i) => unit(80 - i));
      const meta = { schema: 1, weeks: Array.from({ length: 26 }, () => ({ week: '2026-10-11', messages: 999, misses: 99, rephrases: 99 })) };
      const text = fitRecords(meta, records);
      const parsed = JSON.parse(text) as { records: ExportRecord[]; truncated: { pairs: number; misses: number } };
      expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(LEARN_EXPORT_MAX_BYTES);
      expect(parsed.records.length + parsed.truncated.pairs).toBe(80);
      expect(parsed.truncated.pairs).toBeGreaterThan(0);
      expect(parsed.records[0]!.at).toBe(records[0]!.at);
      // Bounds: the metadata and one maximal unit always fit.
      expect(new TextEncoder().encode(fitRecords(meta, [unit(1)])).length).toBeLessThan(LEARN_EXPORT_MAX_BYTES);
      expect((JSON.parse(fitRecords(meta, [unit(1)])) as { records: unknown[] }).records).toHaveLength(1);
    });
  });
});

describe('/leave and /learn export', () => {
  it('parses the bounds', () => {
    expect(matchCommand('/leave')).toEqual({ kind: 'leave', set: null });
    expect(matchCommand('/leave 20')).toEqual({ kind: 'leave', set: 20 });
    expect(matchCommand('/leave 10')).toEqual({ kind: 'leave', set: 10 });
    expect(matchCommand('/leave 120')).toEqual({ kind: 'leave', set: 120 });
    expect(matchCommand('/leave 9')).toEqual({ kind: 'leave', set: 'invalid' });
    expect(matchCommand('/leave 121')).toEqual({ kind: 'leave', set: 'invalid' });
    expect(matchCommand('/leave off')).toEqual({ kind: 'leave', set: 'off' });
    expect(matchCommand('/learn export')).toEqual({ kind: 'learn', action: 'export' });
  });

  it('the repository refuses a value outside 10–120', () => {
    const driver = new TestSqlDriver();
    const repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    expect(() => repo.setLeaveDefaultMinutes(5)).toThrow();
    repo.setLeaveDefaultMinutes(45);
    expect(repo.leaveDefaultMinutes()).toBe(45);
    repo.setLeaveDefaultMinutes(null);
    expect(repo.leaveDefaultMinutes()).toBeNull();
    driver.close();
  });
});
