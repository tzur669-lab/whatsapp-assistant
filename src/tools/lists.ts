/**
 * `lists.*` (PLAN §6.25, ROADMAP block H part 17, 2026-10-07): "תוסיף חלב
 * לרשימת קניות", "מה ברשימת המניות?", "תוריד את החלב", "תמחק את הרשימה".
 *
 * Private, like notes (`ToolSpec.private`): no reply of these tools reaches the
 * model or its history. A list is found in code from the words that named it
 * (`ListStore.find`); the model never sees a list, so it never picks one.
 */
import { z } from 'zod';
import { listsAddSlots, listsDeleteSlots, listsRemoveSlots, listsShowSlots } from '../nlu/slot-schemas.js';
import { listText } from '../render/lists.js';
import { personalQuestion } from '../render/personal.js';
import { isolate } from '../render/bidi.js';
import { itemKey, listKey, MAX_LIST_NAME_CHARS } from './list-store.js';
import type { ListItem, ListStore, ListSummary } from './list-store.js';
import { foldForMatch } from './match.js';
import { parseInput } from './types.js';
import type { ExecuteResult, PersonalQuestion, ResolveOutcome, ToolContext, ToolDefinition } from './types.js';

/** At most this many names in a "which list?" question or a hint. */
const MAX_NAMES = 5;

const ask = (what: PersonalQuestion): ResolveOutcome => ({ kind: 'clarify', clarify: { code: 'personal', what } });
const whichList = (lists: readonly ListSummary[]): ResolveOutcome => ({
  kind: 'clarify',
  clarify: { code: 'which_list', names: lists.slice(0, MAX_NAMES).map((list) => list.name) },
});

function storeOf(ctx: ToolContext): ListStore {
  if (!ctx.lists) throw new Error('E_LISTS_UNAVAILABLE');
  return ctx.lists;
}

const cleanItems = (items: readonly string[] | undefined): string[] =>
  (items ?? []).map((item) => item.trim()).filter((item) => item.length > 0);

/**
 * The one existing list the words name, or the one list there is when none is
 * named. Otherwise the question to ask.
 */
function existingList(store: ListStore, principal: string, variants: readonly string[] | undefined): ListSummary | ResolveOutcome {
  const all = store.lists(principal);
  if (all.length === 0) return ask('no_lists');
  if (!variants || variants.length === 0) return all.length === 1 ? all[0]! : whichList(all);
  const found = store.find(principal, variants);
  if (found.length === 1) return found[0]!;
  if (found.length === 0) return { kind: 'clarify', clarify: { code: 'not_found' } };
  return whichList(found);
}

const isList = (value: ListSummary | ResolveOutcome): value is ListSummary => 'id' in value && 'name' in value;

const rowVersionSchema = z.object({ id: z.string().min(1).max(64), version: z.number().int().min(0) }).strict();

// -- lists.add ----------------------------------------------------------------

const addInputSchema = z
  .object({
    listId: z.string().min(1).max(64).optional(),
    newName: z.string().min(1).max(MAX_LIST_NAME_CHARS).optional(),
    items: z.array(z.string().min(1).max(200)).min(1).max(20),
  })
  .strict()
  .refine((input) => (input.listId === undefined) !== (input.newName === undefined));
type AddInput = z.infer<typeof addInputSchema>;

const addUndoSchema = z
  .object({ listId: z.string().min(1).max(64), created: z.boolean(), items: z.array(rowVersionSchema).max(20) })
  .strict();

export const listsAdd: ToolDefinition = {
  name: 'lists.add',
  inputSchema: addInputSchema,

  resolve(rawSlots, ctx): ResolveOutcome {
    const slots = listsAddSlots.safeParse(rawSlots);
    if (!slots.success) return ask('list_items');
    const items = cleanItems(slots.data.items);
    if (items.length === 0) return ask('list_items');

    const store = storeOf(ctx);
    const variants = slots.data.list;
    if (!variants || variants.length === 0) {
      const all = store.lists(ctx.principal);
      if (all.length === 0) return ask('list_name');
      return all.length === 1 ? ready({ listId: all[0]!.id, items }) : whichList(all);
    }
    const found = store.find(ctx.principal, variants);
    if (found.length === 1) return ready({ listId: found[0]!.id, items });
    if (found.length > 1) return whichList(found);

    // No list by that name: a new one, called what the user called it.
    const name = variants[0]!.trim().slice(0, MAX_LIST_NAME_CHARS);
    if (listKey(name).length === 0) return ask('list_name');
    return ready({ newName: name, items });
  },

  preview(rawInput, lang): string {
    const input = parseInput<AddInput>(addInputSchema, rawInput, 'lists.add');
    return input.items.map(isolate).join(', ') + (lang === 'he' ? ' לרשימה' : ' to the list');
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<AddInput>(addInputSchema, rawInput, 'lists.add');
    const store = storeOf(ctx);
    const others = store.lists(ctx.principal);
    const outcome = store.add(
      ctx.principal,
      input.listId !== undefined ? { listId: input.listId } : { newName: input.newName! },
      input.items,
    );
    if (outcome.kind === 'lists_full') return { text: personalQuestion('lists_full', ctx.lang) };
    if (outcome.kind === 'list_full') return { text: personalQuestion('list_full', ctx.lang) };
    if (outcome.kind === 'gone') return { text: personalQuestion('list_gone', ctx.lang) };

    let text = listText.added(
      outcome.listName,
      outcome.added.map((item) => item.text),
      outcome.skipped,
      outcome.created,
      ctx.lang,
    );
    // A new list while others exist: the name may have meant one of them.
    if (outcome.created && others.length > 0 && others.length <= MAX_NAMES) {
      text += `\n${listText.didYouMean(others.map((list) => list.name), ctx.lang)}`;
    }
    if (outcome.added.length === 0) return { text };
    return {
      text,
      compensating: {
        listId: outcome.listId,
        created: outcome.created,
        items: outcome.added.map(({ id, version }) => ({ id, version })),
      },
      externalRef: outcome.listId,
    };
  },

  async undo(compensating, ctx): Promise<ExecuteResult> {
    const undo = parseInput<z.infer<typeof addUndoSchema>>(addUndoSchema, compensating, 'lists.add');
    const result = storeOf(ctx).undoAdd(ctx.principal, undo.listId, undo.created, undo.items);
    return { text: result === 'done' ? listText.undone(ctx.lang) : listText.undoRefused(result, ctx.lang) };
  },
};

function ready(input: AddInput): ResolveOutcome {
  return { kind: 'ready', input };
}

// -- lists.show ---------------------------------------------------------------

const showInputSchema = z.object({ variants: z.array(z.string().min(1).max(100)).max(5) }).strict();
type ShowInput = z.infer<typeof showInputSchema>;

export const listsShow: ToolDefinition = {
  name: 'lists.show',
  inputSchema: showInputSchema,

  resolve(rawSlots): ResolveOutcome {
    const slots = listsShowSlots.safeParse(rawSlots);
    const variants = slots.success ? (slots.data.list ?? []) : [];
    return { kind: 'ready', input: { variants: variants.filter((v) => listKey(v).length > 0) } satisfies ShowInput };
  },

  preview(): string {
    return 'רשימות';
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<ShowInput>(showInputSchema, rawInput, 'lists.show');
    const store = storeOf(ctx);
    const all = store.lists(ctx.principal);
    if (all.length === 0) return { text: personalQuestion('no_lists', ctx.lang) };

    const one = (list: ListSummary) => ({ text: listText.one(list.name, store.items(list.id), ctx.lang) });
    if (input.variants.length === 0) return all.length === 1 ? one(all[0]!) : { text: listText.all(all, ctx.lang) };

    const found = store.find(ctx.principal, input.variants);
    if (found.length === 1) return one(found[0]!);
    // None by that name, or several: show what there is to choose from.
    return { text: listText.all(found.length > 1 ? found : all, ctx.lang) };
  },
};

// -- lists.remove -------------------------------------------------------------

const removeInputSchema = z
  .object({
    listId: z.string().min(1).max(64),
    listName: z.string().min(1).max(MAX_LIST_NAME_CHARS),
    itemIds: z.array(z.string().min(1).max(64)).min(1).max(20),
  })
  .strict();
type RemoveInput = z.infer<typeof removeInputSchema>;

const removeUndoSchema = z
  .object({ listId: z.string().min(1).max(64), items: z.array(rowVersionSchema).min(1).max(20) })
  .strict();

/** The items each phrase names: an exact one wins; else a single partial match. */
function matchItems(items: readonly ListItem[], phrases: readonly string[]): ListItem[] | 'none' | 'ambiguous' {
  const out = new Map<string, ListItem>();
  for (const phrase of phrases) {
    const key = itemKey(phrase);
    const exact = items.filter((item) => itemKey(item.text) === key);
    const partial = exact.length > 0 ? exact : items.filter((item) => foldForMatch(item.text).includes(key));
    if (partial.length === 0) continue;
    if (partial.length > 1 && exact.length === 0) return 'ambiguous';
    for (const item of partial) out.set(item.id, item);
  }
  return out.size === 0 ? 'none' : [...out.values()];
}

export const listsRemove: ToolDefinition = {
  name: 'lists.remove',
  inputSchema: removeInputSchema,

  resolve(rawSlots, ctx): ResolveOutcome {
    const slots = listsRemoveSlots.safeParse(rawSlots);
    if (!slots.success) return { kind: 'clarify', clarify: { code: 'missing_slot', slot: 'target' } };
    const phrases = cleanItems(slots.data.items);
    if (phrases.length === 0) return { kind: 'clarify', clarify: { code: 'missing_slot', slot: 'target' } };

    const store = storeOf(ctx);
    const list = existingList(store, ctx.principal, slots.data.list);
    if (!isList(list)) return list;
    const items = store.items(list.id);
    const matched = matchItems(items, phrases);
    if (matched === 'none') return { kind: 'clarify', clarify: { code: 'not_found' } };
    if (matched === 'ambiguous') {
      const choices = items
        .filter((item) => phrases.some((phrase) => foldForMatch(item.text).includes(itemKey(phrase))))
        .slice(0, MAX_NAMES)
        .map((item) => ({ id: item.id, label: isolate(item.text) }));
      return { kind: 'clarify', clarify: { code: 'ambiguous', choices } };
    }
    return {
      kind: 'ready',
      input: { listId: list.id, listName: list.name, itemIds: matched.map((item) => item.id) } satisfies RemoveInput,
    };
  },

  preview(rawInput, lang): string {
    const input = parseInput<RemoveInput>(removeInputSchema, rawInput, 'lists.remove');
    return lang === 'he' ? `הסרה מרשימת ${isolate(input.listName)}` : `Remove from ${isolate(input.listName)}`;
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<RemoveInput>(removeInputSchema, rawInput, 'lists.remove');
    const removed = storeOf(ctx).removeItems(input.listId, input.itemIds);
    if (removed.length === 0) return { text: listText.notOnList(input.listName, ctx.lang) };
    return {
      text: listText.removed(input.listName, removed.map((item) => item.text), ctx.lang),
      compensating: { listId: input.listId, items: removed.map(({ id, version }) => ({ id, version })) },
      externalRef: input.listId,
    };
  },

  async undo(compensating, ctx): Promise<ExecuteResult> {
    const undo = parseInput<z.infer<typeof removeUndoSchema>>(removeUndoSchema, compensating, 'lists.remove');
    const result = storeOf(ctx).undoRemove(undo.listId, undo.items);
    return { text: result === 'done' ? listText.undone(ctx.lang) : listText.undoRefused(result, ctx.lang) };
  },
};

// -- lists.delete -------------------------------------------------------------

const deleteInputSchema = z
  .object({ listId: z.string().min(1).max(64), listName: z.string().min(1).max(MAX_LIST_NAME_CHARS), count: z.number().int().min(0) })
  .strict();
type DeleteInput = z.infer<typeof deleteInputSchema>;

export const listsDelete: ToolDefinition = {
  name: 'lists.delete',
  inputSchema: deleteInputSchema,

  resolve(rawSlots, ctx): ResolveOutcome {
    const slots = listsDeleteSlots.safeParse(rawSlots);
    const variants = slots.success ? slots.data.list : undefined;
    const store = storeOf(ctx);
    const all = store.lists(ctx.principal);
    if (all.length === 0) return ask('no_lists');
    // A whole list goes only when named, even if it is the only one.
    if (!variants || variants.length === 0) return whichList(all);
    const found = store.find(ctx.principal, variants);
    if (found.length === 0) return { kind: 'clarify', clarify: { code: 'not_found' } };
    if (found.length > 1) return whichList(found);
    const list = found[0]!;
    return { kind: 'ready', input: { listId: list.id, listName: list.name, count: list.count } satisfies DeleteInput };
  },

  preview(rawInput, lang): string {
    const input = parseInput<DeleteInput>(deleteInputSchema, rawInput, 'lists.delete');
    return listText.deletePreview(input.listName, input.count, lang);
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<DeleteInput>(deleteInputSchema, rawInput, 'lists.delete');
    // Counted now, not at the question: items added since go with it, and say so.
    const deleted = storeOf(ctx).deleteList(input.listId, ctx.principal);
    if (!deleted) return { text: personalQuestion('list_gone', ctx.lang) };
    // Tier 2: the confirmation is the way back, so there is no Undo (the
    // registry test holds every tool above Tier 1 to that).
    return { text: listText.deleted(input.listName, deleted.items.length, ctx.lang), externalRef: input.listId };
  },
};

export const LIST_TOOLS = {
  'lists.add': listsAdd,
  'lists.show': listsShow,
  'lists.remove': listsRemove,
  'lists.delete': listsDelete,
} as const;
