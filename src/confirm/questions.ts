/**
 * The open clarifying question (PLAN §6.11).
 *
 * When a tool refuses to invent what the user left out, the question is asked
 * *and written down*: which tool, everything already understood, and which slot
 * is being waited on. The next free-text message is then read as an answer to
 * it — which is what makes "תזכיר לי מחר להתקשר לאבא" → "באיזו שעה?" → "8" the
 * three-message exchange the user expects instead of three unrelated ones.
 *
 * What this is not: a memory of the conversation. Exactly one question is open
 * at a time, it holds one tool's slots, it dies in ten minutes, and an answer
 * to it never executes anything by itself. The merged draft goes back through
 * the same validation, the same `resolve`, and the same policy decision as a
 * first-time request — so a clarification cannot be used to reach a tool the
 * original message would not have reached.
 *
 * Synchronous, like the rest of `confirm/`: the Durable Object serializes calls,
 * so the read and the replace cannot interleave with another message.
 */
import type { SqlDriver } from '../core/sql.js';

/** Matches `STALE_MESSAGE_MS`: past that, a message is not a reply to anything. */
export const QUESTION_EXPIRY_MS = 10 * 60 * 1000;

/**
 * The slots a question may be about. Closed on purpose, and re-checked on read:
 * a merge is steered by this value, so it must never be anything but a slot a
 * tool actually declares.
 *
 * `when` is the one that is not a slot: it is what "הזמן הזה כבר עבר. למתי
 * לקבוע?" asks, which a day, an hour or both all answer.
 */
export const ASKABLE_SLOTS = [
  'text', 'time', 'target', 'title', 'date', 'duration', 'when',
] as const;
export type AskedSlot = (typeof ASKABLE_SLOTS)[number];

export function isAskableSlot(value: unknown): value is AskedSlot {
  return typeof value === 'string' && (ASKABLE_SLOTS as readonly string[]).includes(value);
}

export type OpenQuestion = {
  tool: string;
  /** What the first message did say. Message content — stored, never logged. */
  slots: Record<string, unknown>;
  asked: AskedSlot;
  language: 'he' | 'en';
  createdAt: number;
  expiresAt: number;
};

export class OpenQuestions {
  constructor(
    private readonly sql: SqlDriver,
    private readonly now: () => number,
  ) {}

  /**
   * Record the question just asked, replacing whatever was open before.
   *
   * The replace is the point: a user who asks something new mid-question has
   * moved on, and leaving the old row would let one answer match two questions.
   */
  open(params: {
    principal: string;
    tool: string;
    slots: Record<string, unknown>;
    asked: AskedSlot;
    language: 'he' | 'en';
  }): void {
    const createdAt = this.now();
    this.sql.exec(
      `INSERT INTO open_questions (principal, tool, slots_json, asked, language, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(principal) DO UPDATE SET
         tool = excluded.tool,
         slots_json = excluded.slots_json,
         asked = excluded.asked,
         language = excluded.language,
         created_at = excluded.created_at,
         expires_at = excluded.expires_at`,
      params.principal,
      params.tool,
      JSON.stringify(params.slots),
      params.asked,
      params.language,
      createdAt,
      createdAt + QUESTION_EXPIRY_MS,
    );
  }

  /**
   * This sender's live question, or null.
   *
   * Every field is re-checked rather than trusted: the row crossed a JSON
   * boundary and a column could have drifted, and an unusable row must read as
   * "no question open" — which costs one "לא הבנתי" — rather than as a merge
   * into something unexpected.
   */
  peek(principal: string): OpenQuestion | null {
    const row = this.sql.exec(
      'SELECT * FROM open_questions WHERE principal = ? AND expires_at > ?',
      principal,
      this.now(),
    )[0];
    if (!row) return null;

    const asked = row['asked'];
    if (!isAskableSlot(asked)) return null;

    const language = row['language'] === 'en' ? 'en' : 'he';

    let slots: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(String(row['slots_json']));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
      slots = parsed as Record<string, unknown>;
    } catch {
      return null;
    }

    return {
      tool: String(row['tool']),
      slots,
      asked,
      language,
      createdAt: Number(row['created_at']),
      expiresAt: Number(row['expires_at']),
    };
  }

  clear(principal: string): void {
    this.sql.exec('DELETE FROM open_questions WHERE principal = ?', principal);
  }

  /** Run from the daily cron, beside the other expiries (PLAN §6.7). */
  purgeExpired(): void {
    this.sql.exec('DELETE FROM open_questions WHERE expires_at <= ?', this.now());
  }
}
