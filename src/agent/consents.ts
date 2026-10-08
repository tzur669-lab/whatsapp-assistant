/**
 * Consent in smart conversations (2026-10-08, PLAN §6.19).
 *
 * A smart conversation's model may train on what it is sent, so the user's
 * data reaches it only once the user allowed its source. A tool whose
 * `dataSource` is a consent source the conversation has not allowed is never
 * run when a model calls it: the turn waits (`turns.ts`, kind `consent`) and
 * the user gets a card. The answer is a button, handled in code only
 * (invariant 7):
 *
 *   once  this turn may read the source; nothing is kept
 *   conv  this conversation may read it from now on: a row here
 *   no    nothing is read; the model is told and answers in words
 *
 * Mail, SMS, contacts and notifications hold other people's words, and are
 * allowed one turn at a time: no row is ever written for them, and a "conv"
 * button for one is refused.
 *
 * Synchronous SQL on purpose: a "conv" tap writes its row in the same
 * transaction that takes the waiting turn (`pipeline.ts`).
 */
import type { SqlDriver } from '../core/sql.js';
import { CONSENT_SOURCES, dataSourceOf } from '../tools/registry.js';
import type { ConsentSource, ToolName } from '../tools/registry.js';

/** Other people's words: allowed for one turn at a time, never for a conversation. */
const ONCE_ONLY: ReadonlySet<ConsentSource> = new Set<ConsentSource>(['mail', 'sms', 'contacts', 'notifications']);

export function isConsentSource(value: unknown): value is ConsentSource {
  return typeof value === 'string' && (CONSENT_SOURCES as readonly string[]).includes(value);
}

/** Whether "allow in this conversation" is offered for this source. */
export function mayKeepForConversation(source: ConsentSource): boolean {
  return !ONCE_ONLY.has(source);
}

/** The consent source a tool's replies may carry; null for public and private tools. */
export function consentSourceOf(tool: ToolName): ConsentSource | null {
  const source = dataSourceOf(tool);
  return isConsentSource(source) ? source : null;
}

/** The sources one smart conversation allowed. The shared thread ('') never has any. */
export class ConversationConsents {
  constructor(
    private readonly sql: SqlDriver,
    private readonly now: () => number,
  ) {}

  consented(principal: string, conversation: string, source: ConsentSource): boolean {
    if (conversation === '' || !mayKeepForConversation(source)) return false;
    const row = this.sql.exec(
      'SELECT 1 AS found FROM conversation_consents WHERE principal = ? AND conversation = ? AND source = ?',
      principal,
      conversation,
      source,
    )[0];
    return row !== undefined;
  }

  /** Allow `source` for the rest of the conversation. False: refused, nothing written. */
  grant(principal: string, conversation: string, source: ConsentSource): boolean {
    if (conversation === '' || !mayKeepForConversation(source)) return false;
    this.sql.exec(
      `INSERT INTO conversation_consents (principal, conversation, source, last_used)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(principal, conversation, source) DO UPDATE SET last_used = excluded.last_used`,
      principal,
      conversation,
      source,
      this.now(),
    );
    return true;
  }

  /** True when there was something to revoke. */
  revoke(principal: string, conversation: string, source: ConsentSource): boolean {
    const rows = this.sql.exec(
      'DELETE FROM conversation_consents WHERE principal = ? AND conversation = ? AND source = ? RETURNING source',
      principal,
      conversation,
      source,
    );
    return rows.length > 0;
  }

  /** The conversation's allowed sources, in `CONSENT_SOURCES` order; anything else is ignored. */
  list(principal: string, conversation: string): ConsentSource[] {
    if (conversation === '') return [];
    const stored = new Set(
      this.sql
        .exec('SELECT source FROM conversation_consents WHERE principal = ? AND conversation = ?', principal, conversation)
        .map((row) => row['source']),
    );
    return CONSENT_SOURCES.filter((source) => stored.has(source) && mayKeepForConversation(source));
  }

  /** The sources were used: their rows stay clear of the 30-day purge. Others are left alone. */
  touch(principal: string, conversation: string, sources: readonly ConsentSource[]): void {
    const now = this.now();
    for (const source of new Set(sources)) {
      this.sql.exec(
        'UPDATE conversation_consents SET last_used = MAX(last_used, ?) WHERE principal = ? AND conversation = ? AND source = ?',
        now,
        principal,
        conversation,
        source,
      );
    }
  }
}

// -- buttons ------------------------------------------------------------------

/** The tool name a revoke offer is stored under in `undo_actions` (`confirm/undo.ts`). */
export const CONSENT_REVOKE_TOOL = 'consents.revoke';

export type ConsentVerb = 'once' | 'conv' | 'no';

export type ConsentButton =
  /** A tap on a consent card: the waiting turn's query id and its nonce. */
  | { kind: 'answer'; queryId: string; nonce: string; verb: ConsentVerb }
  /** A tap on a `/consents` revoke button: a one-shot offer in `undo_actions`. */
  | { kind: 'revoke'; id: string; nonce: string };

const ANSWER = /^cs:([0-9a-f]{32}):([0-9a-f]{32}):(once|conv|no)$/;
const REVOKE = /^cr:([0-9a-f]{24}):([0-9a-f]{32}):ok$/;

/** `cs:<query id>:<nonce>:<once|conv|no>` — the app channel's alphabet, `[a-z0-9:]`. */
export function consentButtonId(queryId: string, nonce: string, verb: ConsentVerb): string {
  return `cs:${queryId}:${nonce}:${verb}`;
}

/** `cr:<offer id>:<nonce>:ok`. */
export function revokeButtonId(id: string, nonce: string): string {
  return `cr:${id}:${nonce}:ok`;
}

export function parseConsentButton(raw: string): ConsentButton | null {
  const answer = ANSWER.exec(raw);
  if (answer) return { kind: 'answer', queryId: answer[1]!, nonce: answer[2]!, verb: answer[3] as ConsentVerb };
  const revoke = REVOKE.exec(raw);
  if (revoke) return { kind: 'revoke', id: revoke[1]!, nonce: revoke[2]! };
  return null;
}
