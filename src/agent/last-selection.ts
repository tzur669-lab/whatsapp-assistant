/**
 * Inherited tool groups (block J, J2a, 2026-10-13).
 *
 * A local message that names no tool group gets the full catalog, which barely
 * fits a turn. A short follow-up ("ובעוד שעה?", "תבטל אותה") is usually about the
 * turn before it, so it is offered that turn's groups instead — when all hold:
 *
 *   - the message is short and names no group (`mayInherit`);
 *   - the previous local agent turn of this conversation chose groups (not the
 *     full set), did not start tainted, and is less than 10 minutes old;
 *   - that turn ran a tool, and every tool it ran is in those groups (`ran`).
 *
 * Inheritance only narrows what `agentToolNames` offers this turn; it never
 * adds a tool. If the needed tool is missing, no tool runs and the parser
 * fallback runs, as for any turn with no tool.
 *
 * Group names are code constants: nothing here is message content. Written
 * when the local plan is made (`AgentDeps.onLocalSelection`), marked when the
 * same turn settles (`markRan`, by `seq =`). Synchronous throughout.
 */
import type { SqlDriver } from '../core/sql.js';
import type { ToolName } from '../tools/registry.js';
import { GROUPS, matchGroups } from './tool-groups.js';
import type { GroupName } from './tool-groups.js';

export const INHERIT_WINDOW_MS = 10 * 60_000;
/** Longer messages carry their own meaning, and get the full set. */
export const INHERIT_MAX_WORDS = 6;

/** Offered only when named (§6.27, §6.28): never inherited. */
const NEVER_INHERITED: ReadonlySet<GroupName> = new Set<GroupName>(['routine', 'screen']);

/** A message short enough to be a follow-up, whose words name no group. */
export function mayInherit(text: string): boolean {
  const words = text.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0 || words.length > INHERIT_MAX_WORDS) return false;
  return matchGroups(text).every((group) => NEVER_INHERITED.has(group));
}

const KNOWN = new Set<string>(Object.keys(GROUPS));

function parseGroups(value: unknown): GroupName[] {
  if (typeof value !== 'string' || value === '') return [];
  return value.split(',').filter((name): name is GroupName => KNOWN.has(name));
}

export class LastSelections {
  constructor(
    private readonly sql: SqlDriver,
    private readonly now: () => number,
  ) {}

  /**
   * The groups this local turn was offered; empty for the full set, which
   * overwrites the row so an older selection is not inherited past it.
   */
  record(principal: string, conversation: string, seq: number, groups: readonly GroupName[], tainted: boolean): void {
    const kept = groups.filter((group) => !NEVER_INHERITED.has(group));
    this.sql.exec(
      `INSERT INTO last_selection (principal, conversation, seq, groups, tainted, ran, at)
       VALUES (?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(principal, conversation) DO UPDATE SET
         seq = excluded.seq, groups = excluded.groups, tainted = excluded.tainted, ran = 0, at = excluded.at
       WHERE excluded.seq >= last_selection.seq`,
      principal,
      conversation,
      seq,
      kept.join(','),
      tainted ? 1 : 0,
      this.now(),
    );
  }

  /** The turn `seq` ran these tools: inheritable only if each is in its groups. */
  markRan(principal: string, conversation: string, seq: number, tools: readonly ToolName[]): void {
    if (tools.length === 0) return;
    const row = this.sql.exec(
      'SELECT groups FROM last_selection WHERE principal = ? AND conversation = ? AND seq = ?',
      principal,
      conversation,
      seq,
    )[0];
    if (!row) return;
    const groups = parseGroups(row['groups']);
    const inside = tools.every((tool) => groups.some((group) => GROUPS[group].includes(tool)));
    if (!inside) return;
    this.sql.exec(
      'UPDATE last_selection SET ran = 1 WHERE principal = ? AND conversation = ? AND seq = ?',
      principal,
      conversation,
      seq,
    );
  }

  /** The groups a follow-up in this conversation may inherit now, or null. */
  inherited(principal: string, conversation: string): GroupName[] | null {
    const row = this.sql.exec(
      `SELECT groups FROM last_selection
       WHERE principal = ? AND conversation = ? AND ran = 1 AND tainted = 0 AND at > ?`,
      principal,
      conversation,
      this.now() - INHERIT_WINDOW_MS,
    )[0];
    const groups = parseGroups(row?.['groups']);
    return groups.length > 0 ? groups : null;
  }

  purgeExpired(): void {
    this.sql.exec('DELETE FROM last_selection WHERE at <= ?', this.now() - INHERIT_WINDOW_MS);
  }
}
