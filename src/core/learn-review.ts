/**
 * The weekly review (block K, K2, PLAN §6.31): what last week looked like, at
 * most two proposals, and one short question. Built from local SQL only — no
 * network, no model, no decrypt — so the caller can mark the week and queue
 * every message in one synchronous transaction.
 *
 * A proposal only ever names a preference that has its own command (`/digest
 * N`, `/leave N`); a tap applies the stored value through that same setter.
 * Nothing here touches policy, tiers or limits (invariant 8), and nothing ever
 * fills a missing time (invariant 4).
 */
import type { Repository } from './repo.js';
import { LEAVE_DEFAULT_MAX, LEAVE_DEFAULT_MIN } from './repo.js';
import type { LearnStore, ProposalKind, WeekRow } from './learn-store.js';
import { weekStartOf } from './learn-store.js';
import { digestHourCandidate, firstMessageMinutes, leaveMinutesCandidate, median, ratePer100 } from './habits.js';
import type { RateLine, ReviewTrend } from '../render/learn.js';
import { DEFAULT_TRAVEL_MINUTES } from '../tools/reminders.js';
import { localPartsOf, ZONE } from '../time/tz.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const PRIOR_WEEKS = 4;
const MIN_PRIOR_WEEKS = 2;
const HABIT_DAYS = 14;
const LEAVE_DAYS = 30;
export const MAX_PROPOSALS = 2;
/** Sunday at 10:00, Jerusalem: independent of the digest. */
export const REVIEW_WEEKDAY = 0;
export const REVIEW_HOUR = 10;

export type PlannedProposal = { kind: ProposalKind; value: number; current: number; observed: number };
export type PlannedQuestion = { kind: ProposalKind; values: number[] };

export type ReviewPlan = {
  trend: ReviewTrend;
  /** The first review of the month reminds about the export. */
  exportDue: boolean;
  proposals: PlannedProposal[];
  question: PlannedQuestion | null;
};

/** The static question bank: each answer is one value of one preference. Rotated by week. */
export const QUESTION_BANK: ReadonlyArray<{ kind: ProposalKind; values: readonly number[] }> = [
  { kind: 'digest_hour', values: [7, 8, 9] },
  { kind: 'leave_min', values: [15, 20, 30] },
  { kind: 'digest_hour', values: [6, 7, 8] },
  { kind: 'leave_min', values: [20, 30, 45] },
  { kind: 'digest_hour', values: [8, 9, 10] },
  { kind: 'leave_min', values: [10, 15, 20] },
  { kind: 'digest_hour', values: [9, 10, 11] },
  { kind: 'leave_min', values: [30, 45, 60] },
];

/** Is it the review's hour, local? A tick after 10:00 on Sunday still counts: the day key stops a second one. */
export function reviewDue(nowMs: number): boolean {
  const local = localPartsOf(nowMs, ZONE);
  return local.weekday === REVIEW_WEEKDAY && local.hour >= REVIEW_HOUR;
}

export function planReview(input: {
  nowMs: number;
  principal: string;
  store: LearnStore;
  repo: Repository;
}): ReviewPlan {
  const { nowMs, principal, store, repo } = input;
  const local = localPartsOf(nowMs, ZONE);
  const trend = trendOf(store, principal, nowMs);
  const pending = store.pendingKinds(principal);
  const proposals: PlannedProposal[] = [];

  const digestHour = repo.digestHour();
  const firstStart = store.startOf('first_message');
  if (firstStart !== null && digestHour !== null && !pending.has('digest_hour')) {
    const times = store.firstMessageTimes(principal, Math.max(nowMs - HABIT_DAYS * DAY_MS, firstStart));
    const candidate = digestHourCandidate(times, digestHour);
    if (candidate !== null) {
      const observed = (median(firstMessageMinutes(times))! + 4 * 60) % (24 * 60);
      proposals.push({ kind: 'digest_hour', value: candidate, current: digestHour, observed });
    }
  }

  const leaveStart = store.startOf('leave');
  const leaveNow = repo.leaveDefaultMinutes() ?? DEFAULT_TRAVEL_MINUTES;
  if (leaveStart !== null && !pending.has('leave_min')) {
    const stated = store.statedLeaves(principal, Math.max(nowMs - LEAVE_DAYS * DAY_MS, leaveStart));
    const candidate = leaveMinutesCandidate(stated, leaveNow, { min: LEAVE_DEFAULT_MIN, max: LEAVE_DEFAULT_MAX });
    if (candidate !== null) proposals.push({ kind: 'leave_min', value: candidate, current: leaveNow, observed: candidate });
  }

  return {
    trend,
    exportDue: local.day <= 7,
    proposals: proposals.slice(0, MAX_PROPOSALS),
    question: questionOf(nowMs, {
      blocked: new Set([...pending, ...proposals.map((proposal) => proposal.kind)]),
      digestHour,
      leaveNow,
    }),
  };
}

/** This week's question, without answers equal to today's value; none if fewer than two remain. */
function questionOf(
  nowMs: number,
  context: { blocked: ReadonlySet<ProposalKind>; digestHour: number | null; leaveNow: number },
): PlannedQuestion | null {
  const entry = QUESTION_BANK[Math.floor(nowMs / WEEK_MS) % QUESTION_BANK.length]!;
  if (context.blocked.has(entry.kind)) return null;
  if (entry.kind === 'digest_hour' && context.digestHour === null) return null;
  const current = entry.kind === 'digest_hour' ? context.digestHour : context.leaveNow;
  const values = entry.values.filter((value) => value !== current);
  return values.length >= 2 ? { kind: entry.kind, values } : null;
}

/**
 * Last week's rates per 100 messages against the mean of the four before it.
 * A week that started before the counters did is "no data", never a zero.
 */
export function trendOf(store: LearnStore, principal: string, nowMs: number): ReviewTrend {
  const start = store.startOf('weeks');
  const none: RateLine = { now: null, before: null };
  if (start === null) return { messages: null, misses: none, rephrases: none, combined: none };
  const startWeek = weekStartOf(start);
  const lastWeek = weekStartOf(nowMs - WEEK_MS);
  const priorWeeks = Array.from({ length: PRIOR_WEEKS }, (_, i) => weekStartOf(nowMs - (i + 2) * WEEK_MS));
  const rows = new Map(store.weeks(principal, priorWeeks[PRIOR_WEEKS - 1]!).map((row) => [row.week, row]));
  const usable = (week: string): WeekRow | null => {
    if (week <= startWeek) return null;
    return rows.get(week) ?? { week, messages: 0, misses: 0, rephrases: 0 };
  };

  const last = usable(lastWeek);
  const prior = priorWeeks.map(usable).filter((row): row is WeekRow => row !== null && row.messages > 0);
  const line = (count: (row: WeekRow) => number): RateLine => {
    const now = last ? ratePer100(count(last), last.messages) : null;
    if (prior.length < MIN_PRIOR_WEEKS) return { now, before: null };
    const rates = prior.map((row) => ratePer100(count(row), row.messages)!);
    return { now, before: Math.round((rates.reduce((a, b) => a + b, 0) / rates.length) * 10) / 10 };
  };
  return {
    messages: last === null ? null : last.messages,
    misses: line((row) => row.misses),
    rephrases: line((row) => row.rephrases),
    combined: line((row) => row.misses + row.rephrases),
  };
}
