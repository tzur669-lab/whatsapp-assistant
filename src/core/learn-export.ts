/**
 * The monthly export (block K, K3, PLAN §6.31): the learning journal as one
 * JSON file for Claude Code to turn into fixes (K4, `scripts/learn-to-evals.ts`).
 *
 * Built in memory for one signed request and returned; nothing is stored
 * decrypted. Every text passes `scrubForModel` first, which masks phones,
 * emails, links, codes and long numbers — not names, addresses or places — so
 * the file is "reduced", not anonymized, and says so. Capped at 256 KB of the
 * final UTF-8 bytes: records (a rephrase pair or a miss, each indivisible) go
 * in newest first while they fit, and the rest are counted in `truncated`.
 */
import { z } from 'zod';
import type { LearnStore, StoredEvent } from './learn-store.js';
import { MAX_LEARN_TEXT_CHARS } from './learn-store.js';
import { median } from './habits.js';
import { scrubForModel } from '../security/scrub.js';

export const LEARN_EXPORT_SCHEMA = 1;
export const LEARN_EXPORT_MAX_BYTES = 256 * 1024;

export const EXPORT_NOTE =
  'Reduced, not anonymized: phones, emails, links, codes and long numbers are masked; names, addresses and places are not. Deleting in the bot does not delete this file.';

const turnSchema = z
  .object({
    user: z.string().max(MAX_LEARN_TEXT_CHARS),
    reply: z.string().max(MAX_LEARN_TEXT_CHARS),
    outcome: z.string().max(60),
    intent: z.string().max(60).nullable(),
  })
  .strict();
const missBodySchema = z.object({ failed: turnSchema }).strict();
const pairBodySchema = z.object({ failed: turnSchema, fixed: turnSchema }).strict();
const confidenceSchema = z.enum(['reported', 'heuristic']);
const pairMetaSchema = z.object({ gap_s: z.number().int().min(0), tools: z.array(z.string().max(60)).max(4) }).strict();
const tapMetaSchema = z.object({ tool: z.string().max(60), seconds: z.number().int().min(0) }).strict();
const leaveMetaSchema = z.object({ minutes: z.number().int(), stated: z.union([z.literal(0), z.literal(1)]) }).strict();

type Turn = z.infer<typeof turnSchema>;

export type ExportRecord =
  | { type: 'miss'; at: string; confidence: 'reported'; failed: Turn }
  | { type: 'pair'; at: string; confidence: 'heuristic'; gapSeconds: number; tools: string[]; failed: Turn; fixed: Turn };

export async function buildLearnExport(input: { store: LearnStore; principal: string; nowMs: number }): Promise<string> {
  const { store, principal, nowMs } = input;
  const events = store.eventsForExport(principal);

  const records: ExportRecord[] = [];
  const taps = new Map<string, { tool: string; undo: number; confirmNo: number; seconds: number[] }>();
  const leaves = { count: 0, stated: 0, statedMinutes: [] as number[] };
  let unreadable = 0;

  for (const event of events) {
    switch (event.kind) {
      case 'miss':
      case 'rephrase': {
        const record = await recordOf(store, principal, event);
        if (record) records.push(record);
        else unreadable++;
        break;
      }
      case 'undo':
      case 'confirm_no': {
        const meta = parseMeta(tapMetaSchema, event.meta);
        if (!meta) break;
        const entry = taps.get(meta.tool) ?? { tool: meta.tool, undo: 0, confirmNo: 0, seconds: [] };
        if (event.kind === 'undo') entry.undo++;
        else entry.confirmNo++;
        entry.seconds.push(meta.seconds);
        taps.set(meta.tool, entry);
        break;
      }
      case 'leave': {
        const meta = parseMeta(leaveMetaSchema, event.meta);
        if (!meta) break;
        leaves.count++;
        if (meta.stated === 1) {
          leaves.stated++;
          leaves.statedMinutes.push(meta.minutes);
        }
        break;
      }
    }
  }

  const meta = {
    schema: LEARN_EXPORT_SCHEMA,
    exportedAt: new Date(nowMs).toISOString(),
    note: EXPORT_NOTE,
    taps: [...taps.values()]
      .map((entry) => ({ tool: entry.tool, undo: entry.undo, confirmNo: entry.confirmNo, medianSeconds: median(entry.seconds) }))
      .sort((a, b) => a.tool.localeCompare(b.tool)),
    leave: { count: leaves.count, stated: leaves.stated, medianStatedMinutes: median(leaves.statedMinutes) },
    weeks: store.weeks(principal, '0000-00-00'),
    proposals: store.proposalOutcomes(principal),
    unreadable,
  };
  return fitRecords(meta, records);
}

/**
 * The final JSON within the cap. The reserve holds the widest `truncated`
 * the records could need, so the counts written after the cut never push it over.
 */
export function fitRecords(meta: Record<string, unknown>, records: readonly ExportRecord[]): string {
  const bytes = (text: string) => new TextEncoder().encode(text).length;
  const widest = String(records.length);
  const reserve = bytes(JSON.stringify({ ...meta, truncated: { pairs: widest, misses: widest }, records: [] }));
  let used = reserve;
  const kept: ExportRecord[] = [];
  const truncated = { pairs: 0, misses: 0 };
  for (const record of records) {
    const size = bytes(JSON.stringify(record)) + (kept.length > 0 ? 1 : 0);
    if (truncated.pairs + truncated.misses === 0 && used + size <= LEARN_EXPORT_MAX_BYTES) {
      kept.push(record);
      used += size;
    } else if (record.type === 'pair') {
      truncated.pairs++;
    } else {
      truncated.misses++;
    }
  }
  return JSON.stringify({ ...meta, truncated, records: kept });
}

async function recordOf(store: LearnStore, principal: string, event: StoredEvent): Promise<ExportRecord | null> {
  try {
    const confidence = confidenceSchema.parse(event.confidence);
    const body = await store.open(principal, event);
    const at = new Date(event.createdAt).toISOString();
    if (event.kind === 'miss' && confidence === 'reported') {
      const parsed = missBodySchema.parse(body);
      return { type: 'miss', at, confidence, failed: scrubTurn(parsed.failed) };
    }
    if (event.kind === 'rephrase' && confidence === 'heuristic') {
      const parsed = pairBodySchema.parse(body);
      const meta = pairMetaSchema.parse(JSON.parse(event.meta));
      return {
        type: 'pair',
        at,
        confidence,
        gapSeconds: meta.gap_s,
        tools: meta.tools,
        failed: scrubTurn(parsed.failed),
        fixed: scrubTurn(parsed.fixed),
      };
    }
  } catch {
    // A row that does not decrypt or parse is counted, never shown.
  }
  return null;
}

function scrubTurn(turn: Turn): Turn {
  return { ...turn, user: scrubForModel(turn.user), reply: scrubForModel(turn.reply) };
}

function parseMeta<T>(schema: z.ZodType<T>, raw: string): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
