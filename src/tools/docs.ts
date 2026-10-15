/**
 * `docs.create` (block L, L6, 2026-10-15): "תכין לי מסמך השוואה בין שלוש
 * הדירות". The model writes the body; it is display text only (invariant 3),
 * capped, cleaned and link-defanged, never parsed into anything.
 *
 * Tier 2: the card names both destinations, the title, the length and the
 * first and last lines. Refused outright in a tainted turn (`refusesTainted`):
 * no text someone else wrote rides into a file. Execute creates the Google
 * Doc once (`drive.file`, never retried — not idempotent; an `op` in its
 * `appProperties` lets an uncertain outcome be looked up) and hands the phone
 * a Markdown file card. The two are separate side effects and every reply
 * says exactly what happened to each; neither failure rolls the other back.
 *
 * Offered only when the words ask for a document (`namesDocument`), never in
 * the full catalog.
 */
import { z } from 'zod';
import { docsCreateSlots } from '../nlu/slot-schemas.js';
import { normalizeHebrew } from '../time/hebrew-lexicon.js';
import { localPartsOf, ZONE } from '../time/tz.js';
import { defangLinks } from '../security/scrub.js';
import { docsText } from '../render/docs.js';
import { DRIVE_FILE_SCOPE } from '../google/drive.js';
import { isDefiniteFailure } from '../core/mail-archive.js';
import { parseInput } from './types.js';
import type { ExecuteResult, ResolveOutcome, ToolContext, ToolDefinition } from './types.js';

export const MAX_DOC_BODY = 8_000;
export const MAX_DOC_TITLE = 100;

const WORDS = [
  /(?:תכין|תכיני|תיצור|ליצור|להכין|לכתוב|תכתוב|תעשה)\s+(?:לי\s+)?(?:\S+\s+)?(?:מסמך|קובץ)/,
  /(?:מסמך|קובץ)\s+(?:ב)?(?:גוגל\s*דוקס|גוגל\s*דרייב|דרייב)/,
  /\b(?:create|make|write|prepare)\s+(?:me\s+)?(?:a\s+)?(?:\w+\s+)?(?:doc|document)\b/i,
  /\bgoogle\s*docs?\b/i,
  /(?:^|\s)ב?גוגל\s*דוקס/,
];

export function namesDocument(text: string): boolean {
  const normalized = normalizeHebrew(text);
  return WORDS.some((pattern) => pattern.test(normalized));
}

const inputSchema = z
  .object({
    title: z.string().min(1).max(MAX_DOC_TITLE),
    body: z.string().min(1).max(MAX_DOC_BODY),
    toDrive: z.boolean(),
    toPhone: z.boolean(),
    /** The Drive upload's own id, in its `appProperties`: chosen once, in the stored input. */
    op: z.string().regex(/^[0-9a-f]{16}$/),
  })
  .strict();
type DocInput = z.infer<typeof inputSchema>;

/** Model text as a file's text: control characters out (newlines kept), links defanged, capped. */
export function cleanDocText(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  return defangLinks(text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g, ''))
    .trim()
    .slice(0, max);
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The phone's file: a fixed, safe name; the app accepts only this shape. */
export function docFileName(op: string, nowMs: number): string {
  const p = localPartsOf(nowMs, ZONE);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `doc-${p.year}-${pad(p.month)}-${pad(p.day)}-${op.slice(0, 6)}.md`;
}

export const docsCreate: ToolDefinition = {
  name: 'docs.create',
  inputSchema,

  resolve(rawSlots, ctx: ToolContext): ResolveOutcome {
    // The orchestrator passes the taint to tools marked `refusesTainted`; refusing is ours.
    if (ctx.tainted) return { kind: 'clarify', clarify: { code: 'personal', what: 'docs_tainted' } };
    const slots = docsCreateSlots.safeParse(rawSlots);
    if (!slots.success || !slots.data.body) return { kind: 'clarify', clarify: { code: 'missing_slot', slot: 'text' } };
    const body = cleanDocText(slots.data.body, MAX_DOC_BODY);
    const title = cleanDocText(slots.data.title ?? '', MAX_DOC_TITLE).replace(/\s+/g, ' ') || docsText.defaultTitle(ctx.lang);
    if (!body) return { kind: 'clarify', clarify: { code: 'missing_slot', slot: 'text' } };
    const toDrive = ctx.drive?.hasScope(DRIVE_FILE_SCOPE) ?? false;
    const toPhone = ctx.fileCards === true;
    if (!toDrive && !toPhone) return { kind: 'clarify', clarify: { code: 'personal', what: 'docs_nowhere' } };
    return { kind: 'ready', input: { title, body, toDrive, toPhone, op: randomHex(8) } satisfies DocInput };
  },

  preview(rawInput, lang): string {
    const input = parseInput<DocInput>(inputSchema, rawInput, 'docs.create');
    return docsText.preview(input, lang);
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<DocInput>(inputSchema, rawInput, 'docs.create');
    // Execute runs with the turn's taint (`orchestrator.execute`): still refused.
    if (ctx.tainted) return { text: docsText.tainted(ctx.lang) };

    let drive: 'created' | 'failed' | 'unknown' | 'skipped' = 'skipped';
    let link: string | null = null;
    if (input.toDrive) {
      if (!ctx.drive) drive = 'failed';
      else {
        const created = await ctx.drive.createDoc({ title: input.title, body: input.body, op: input.op });
        if (created.ok) {
          drive = 'created';
          link = created.value.link;
        } else if (isDefiniteFailure(created.error)) {
          drive = 'failed';
        } else {
          // It may have reached Google: one lookup by the upload's own id, never a second create.
          const found = await ctx.drive.findByOp(input.op);
          if (found.ok && found.value) {
            drive = 'created';
            link = found.value.link;
          } else {
            drive = 'unknown';
          }
        }
      }
    }
    ctx.log.info('docs_created', { drive, phone: input.toPhone });

    return {
      text: docsText.outcome({ drive, link, phone: input.toPhone }, ctx.lang),
      ...(input.toPhone
        ? {
            fileCard: {
              name: docFileName(input.op, ctx.nowMs),
              mime: 'text/markdown' as const,
              content: `# ${input.title}\n\n${input.body}\n`,
              preview: docsText.cardPreview(input.title, ctx.lang),
            },
          }
        : {}),
    };
  },
};
