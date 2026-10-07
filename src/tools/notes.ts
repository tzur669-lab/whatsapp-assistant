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
import { notesText, personalQuestion } from '../render/personal.js';
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
    return { text: notesText.saved(note.text, ctx.lang), compensating: { noteId: note.id }, externalRef: note.id };
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

    const terms = searchTerms(input.variants);
    if (terms.length === 0) {
      return { text: notesText.list(all.slice(0, LIST_LIMIT), 'latest', all.length - LIST_LIMIT, ctx.lang) };
    }
    const found = matchByText(all, terms, (note) => note.text);
    if (found.length === 0) {
      // Never a dead end: the note may not contain the words it was asked by.
      return { text: notesText.list(all.slice(0, LIST_LIMIT), 'no_match', all.length - LIST_LIMIT, ctx.lang) };
    }
    return { text: notesText.list(found.slice(0, LIST_LIMIT), 'found', found.length - LIST_LIMIT, ctx.lang) };
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
