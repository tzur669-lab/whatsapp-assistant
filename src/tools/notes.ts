/**
 * `notes.*` (PLAN §6.22, ROADMAP #9, 2026-10-05): "תזכור ש…", and finding or
 * deleting what was kept.
 *
 * All three are private (`ToolSpec.private`): every reply they make — the save,
 * a list, a question, a confirmation, an Undo — is kept from the model and out
 * of the agent's history. A note is found in code from `query_variants`, like a
 * reminder; the model never sees one, so it never picks one.
 */
import { z } from 'zod';
import {
  MAX_NOTE_TEXT_CHARS,
  notesDeleteSlots,
  notesFindSlots,
  notesSaveSlots,
} from '../nlu/slot-schemas.js';
import { factText, notesText, personalQuestion } from '../render/personal.js';
import { isolate } from '../render/bidi.js';
import { foldForMatch, matchByText } from './match.js';
import type { Note, NoteStore } from './note-store.js';
import { parseInput } from './types.js';
import type {
  ExecuteResult,
  PersonalQuestion,
  ResolveOutcome,
  ToolContext,
  ToolDefinition,
} from './types.js';

/** How many notes a list shows. */
export const LIST_LIMIT = 15;

/**
 * Words that name notes in general rather than one note: "הפתקים שלי", "all my
 * notes". A note never contains them, so matching on them always failed
 * (2026-10-07). Stripped in code; what is left is the actual search.
 */
const GENERIC_WORDS = new Set(
  ['פתק', 'פתקים', 'הפתק', 'הפתקים', 'פתקיי', 'הערה', 'הערות', 'ההערות', 'שלי', 'כל', 'את', 'שמורים', 'השמורים',
    'note', 'notes', 'my', 'all', 'the', 'saved'].map(foldForMatch),
);

/** The variants with the generic words taken out; empty variants are dropped. */
export function searchTerms(variants: readonly string[]): string[] {
  return variants
    .map((variant) =>
      foldForMatch(variant)
        .split(' ')
        .filter((word) => word.length > 0 && !GENERIC_WORDS.has(word))
        .join(' '),
    )
    .filter((term) => term.length > 0);
}
/**
 * "פתק 3", "הפתק השני", "the third note": a note named by its number in the
 * list, which counts from the newest (2026-10-08). Searching the text for "3"
 * matched nothing, so every such request answered with the list from 1.
 */
const ORDINALS: Readonly<Record<string, number>> = {
  ראשונ: 1, ראשונה: 1, אחרונ: 1, אחרונה: 1, שני: 2, שניה: 2, שנייה: 2, שלישי: 3, שלישית: 3, רביעי: 4, רביעית: 4,
  חמישי: 5, חמישית: 5, שישי: 6, שישית: 6, שביעי: 7, שביעית: 7, שמיני: 8, שמינית: 8, תשיעי: 9, תשיעית: 9,
  עשירי: 10, עשירית: 10,
  first: 1, last: 1, latest: 1, newest: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
  eighth: 8, ninth: 9, tenth: 10,
};
const POSITION_WORDS = new Set(['מספר', 'מס', 'number', 'no'].map(foldForMatch));

/** The 1-based position a variant names, or null when it names none. */
export function positionOf(variants: readonly string[]): number | null {
  for (const term of searchTerms(variants)) {
    const words = term.split(' ').filter((word) => !POSITION_WORDS.has(word));
    if (words.length !== 1 || !words[0]) continue;
    const word = words[0].replace(/^ה(?=\p{L})/u, '');
    if (/^\d{1,3}$/.test(word)) return Number(word);
    const ordinal = ORDINALS[word] ?? ORDINALS[words[0]];
    if (ordinal) return ordinal;
  }
  return null;
}

/** Above this, "which one?" is a worse question than "say it differently". */
const MAX_CHOICES = 5;

const ask = (what: PersonalQuestion): ResolveOutcome => ({ kind: 'clarify', clarify: { code: 'personal', what } });

function storeOf(ctx: ToolContext): NoteStore {
  if (!ctx.notes) throw new Error('E_NOTES_UNAVAILABLE');
  return ctx.notes;
}

// -- notes.save ---------------------------------------------------------------

const saveInputSchema = z.object({ text: z.string().min(1).max(MAX_NOTE_TEXT_CHARS) }).strict();
type SaveInput = z.infer<typeof saveInputSchema>;

export const notesSave: ToolDefinition = {
  name: 'notes.save',
  inputSchema: saveInputSchema,

  resolve(rawSlots): ResolveOutcome {
    const slots = notesSaveSlots.safeParse(rawSlots);
    const text = slots.success ? slots.data.text?.trim() : undefined;
    if (!text) return ask('note_text');
    return { kind: 'ready', input: { text } satisfies SaveInput };
  },

  preview(rawInput, lang): string {
    return notesText.saved(parseInput<SaveInput>(saveInputSchema, rawInput, 'notes.save').text, lang);
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<SaveInput>(saveInputSchema, rawInput, 'notes.save');
    const note = storeOf(ctx).add(ctx.principal, input.text);
    if (!note) return { text: personalQuestion('notes_full', ctx.lang) };
    // A note that reads like a fact about the user: say where facts go (§6.26).
    const aboutMe = /^ש?אני\s/.test(note.text.trim());
    const text = notesText.saved(note.text, ctx.lang) + (aboutMe ? `\n${factText.noteHint(ctx.lang)}` : '');
    return { text, compensating: { noteId: note.id }, externalRef: note.id };
  },

  async undo(compensating, ctx): Promise<ExecuteResult> {
    const { noteId } = parseInput<{ noteId: string }>(
      z.object({ noteId: z.string().min(1).max(64) }).strict(),
      compensating,
      'notes.save',
    );
    // Gone already (deleted since) is the state the Undo asked for.
    storeOf(ctx).remove(noteId, ctx.principal);
    return { text: notesText.deleted(ctx.lang) };
  },
};

// -- notes.find -----------------------------------------------------------------

const findInputSchema = z.object({ variants: z.array(z.string().min(1).max(100)).max(5) }).strict();
type FindInput = z.infer<typeof findInputSchema>;

export const notesFind: ToolDefinition = {
  name: 'notes.find',
  inputSchema: findInputSchema,

  resolve(rawSlots): ResolveOutcome {
    const slots = notesFindSlots.safeParse(rawSlots);
    const variants = slots.success ? (slots.data.query_variants ?? []) : [];
    return { kind: 'ready', input: { variants } satisfies FindInput };
  },

  preview(): string {
    return 'פתקים';
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<FindInput>(findInputSchema, rawInput, 'notes.find');
    const all = storeOf(ctx).all(ctx.principal);
    if (all.length === 0) return { text: personalQuestion('no_notes', ctx.lang) };

    // Every note keeps its number in the newest-first list, in every answer, so
    // "פתק 3" means the same note whichever list the user saw it in.
    const numbered = (notes: readonly Note[]) => notes.map((note) => ({ note, number: all.indexOf(note) + 1 }));
    const latest = numbered(all.slice(0, LIST_LIMIT));

    const terms = searchTerms(input.variants);
    if (terms.length === 0) {
      return { text: notesText.list(latest, 'latest', all.length - LIST_LIMIT, ctx.lang) };
    }
    const position = positionOf(input.variants);
    const byPosition = position === null ? undefined : all[position - 1];
    if (byPosition) return { text: notesText.list(numbered([byPosition]), 'found', 0, ctx.lang) };

    const found = matchByText(all, terms, (note) => note.text);
    if (found.length === 0) {
      // Never a dead end: the note may not contain the words it was asked by.
      return { text: notesText.list(latest, 'no_match', all.length - LIST_LIMIT, ctx.lang) };
    }
    return { text: notesText.list(numbered(found.slice(0, LIST_LIMIT)), 'found', found.length - LIST_LIMIT, ctx.lang) };
  },
};

// -- notes.delete -----------------------------------------------------------------

const deleteInputSchema = z
  .object({ noteId: z.string().min(1).max(64), text: z.string().min(1).max(MAX_NOTE_TEXT_CHARS) })
  .strict();
type DeleteInput = z.infer<typeof deleteInputSchema>;

export const notesDelete: ToolDefinition = {
  name: 'notes.delete',
  inputSchema: deleteInputSchema,

  resolve(rawSlots, ctx): ResolveOutcome {
    const slots = notesDeleteSlots.safeParse(rawSlots);
    const variants = slots.success ? (slots.data.query_variants ?? []) : [];
    const all = storeOf(ctx).all(ctx.principal);
    if (all.length === 0) return ask('no_notes');
    if (variants.length === 0) return { kind: 'clarify', clarify: { code: 'missing_slot', slot: 'target' } };

    const found = matchByText(all, variants, (note) => note.text);
    if (found.length === 0) return { kind: 'clarify', clarify: { code: 'not_found' } };
    if (found.length === 1 && found[0]) return { kind: 'ready', input: inputOf(found[0]) };
    return {
      kind: 'clarify',
      clarify: {
        code: 'ambiguous',
        choices: found.slice(0, MAX_CHOICES).map((note) => ({ id: note.id, label: isolate(note.text) })),
      },
    };
  },

  preview(rawInput, lang): string {
    return notesText.deletePreview(parseInput<DeleteInput>(deleteInputSchema, rawInput, 'notes.delete').text, lang);
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<DeleteInput>(deleteInputSchema, rawInput, 'notes.delete');
    // Between the preview and the tap it may have gone: say so, never throw.
    const removed = storeOf(ctx).remove(input.noteId, ctx.principal);
    return { text: removed ? notesText.deleted(ctx.lang) : notesText.gone(ctx.lang), externalRef: input.noteId };
  },
};

function inputOf(note: Note): DeleteInput {
  return { noteId: note.id, text: note.text };
}

export const NOTE_TOOLS = {
  'notes.save': notesSave,
  'notes.find': notesFind,
  'notes.delete': notesDelete,
} as const;
