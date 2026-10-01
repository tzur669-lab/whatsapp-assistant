/**
 * `drive.search` (2026-10-01): find files in Google Drive by name, kind and
 * recency. Tier 0, agent-only, names and dates only. Code builds Drive's query
 * with the quotes taken out of the words, so a slot cannot become another
 * query. No links in the reply: outbound links are defanged (§6.19).
 */
import { z } from 'zod';
import { driveSearchSlots } from '../nlu/slot-schemas.js';
import { buildDriveQuery, DRIVE_KINDS } from '../google/drive.js';
import type { DriveFile } from '../google/drive.js';
import { eventText } from '../render/events.js';
import { isolate } from '../render/bidi.js';
import { formatDay } from '../render/format-time.js';
import type { Lang } from '../render/format-time.js';
import { localPartsOf, ZONE } from '../time/tz.js';
import { parseInput } from './types.js';
import type { ExecuteResult, ResolveOutcome, ToolDefinition } from './types.js';

const inputSchema = z.object({ query: z.string().min(1).max(500) }).strict();
type SearchInput = z.infer<typeof inputSchema>;

const KIND_HE: Record<DriveFile['kind'], string> = {
  any: 'קובץ',
  document: 'מסמך',
  spreadsheet: 'גיליון',
  presentation: 'מצגת',
  pdf: 'PDF',
  image: 'תמונה',
  folder: 'תיקייה',
  other: 'קובץ',
};

function render(files: readonly DriveFile[], lang: Lang): string {
  const he = lang === 'he';
  if (files.length === 0) return he ? 'לא נמצאו קבצים כאלה ב־Drive.' : 'No such files in Drive.';
  const lines = files.map((file) => {
    const when = file.modifiedAt ? formatDay(localPartsOf(file.modifiedAt, ZONE), lang) : '';
    const owner = file.owner ? ` · ${isolate(file.owner)}` : '';
    const kind = he ? KIND_HE[file.kind] : file.kind;
    return `• ${isolate(file.name)} — ${kind}${when ? ` · ${he ? 'עודכן' : 'changed'} ${when}` : ''}${owner}`;
  });
  return [he ? 'קבצים ב־Drive:' : 'Files in Drive:', ...lines].join('\n');
}

export const driveSearch: ToolDefinition = {
  name: 'drive.search',
  inputSchema,

  resolve(rawSlots, ctx): ResolveOutcome {
    const slots = driveSearchSlots.safeParse(rawSlots);
    const data = slots.success ? slots.data : {};
    const kind = data.kind && (DRIVE_KINDS as readonly string[]).includes(data.kind) ? data.kind : null;
    return {
      kind: 'ready',
      input: { query: buildDriveQuery({ words: data.name ?? null, kind, days: data.days ?? null, nowMs: ctx.nowMs }) } satisfies SearchInput,
    };
  },

  preview: () => 'חיפוש ב־Drive',

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<SearchInput>(inputSchema, rawInput, 'drive.search');
    if (!ctx.drive) return { text: eventText.grantNotConnected('drive', ctx.lang) };
    const found = await ctx.drive.search(input.query);
    if (!found.ok) {
      if (found.error.code === 'not_connected' || found.error.code === 'disconnected') {
        return { text: eventText.grantNotConnected('drive', ctx.lang) };
      }
      ctx.log.warn('drive_failed', { errorCode: found.error.code });
      return { text: ctx.lang === 'he' ? 'Google Drive לא זמין כרגע. כדאי לנסות שוב בעוד רגע.' : 'Google Drive is unavailable right now.' };
    }
    return { text: render(found.value, ctx.lang) };
  },
};
