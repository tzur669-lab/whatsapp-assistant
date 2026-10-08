/**
 * Google Tasks tools (2026-10-01): `tasks.list` (Tier 0), `tasks.add` and
 * `tasks.complete` (Tier 1, each with an Undo). Agent-only.
 *
 * A list is found by the name the user said — "קניות", "רשימת הקניות" — in
 * code; a task is found by `query_variants`, in code (invariant 5). Ids go
 * into the stored input and the Undo, never to the model. Titles come back
 * rendered by code; a list read taints the turn, since a task made from a
 * Gmail message carries that message's subject.
 */
import { z } from 'zod';
import { MAX_LIST_CHARS, MAX_TITLE_CHARS, tasksAddSlots, tasksCompleteSlots, tasksListSlots } from '../nlu/slot-schemas.js';
import { resolveDay } from '../time/resolve.js';
import type { DateSpec } from '../time/resolve.js';
import { localPartsOf, ZONE } from '../time/tz.js';
import type { LocalParts } from '../time/tz.js';
import { taskText } from '../render/tasks.js';
import { eventText } from '../render/events.js';
import type { GoogleFailure } from '../google/api.js';
import type { TaskList, TasksClient } from '../google/tasks.js';
import { foldForMatch, matchByText } from './match.js';
import { parseInput } from './types.js';
import type { ExecuteResult, ResolveOutcome, ToolContext, ToolDefinition } from './types.js';

const MAX_LISTS_SHOWN = 5;
const MAX_LISTS_SEARCHED = 6;
const MAX_CHOICES = 5;

/** "רשימת הקניות" names the list "קניות". */
export function listNameOf(said: string): string {
  return said
    .trim()
    .replace(/^(?:ב|ל)?(?:רשימת|רשימה של|הרשימה של)\s+/u, '')
    .replace(/^ה(?=\S{3,})/u, '')
    .replace(/\s+list$/i, '')
    .trim();
}

/** The list the user named, matched in code; none named means the first (Google's default). */
export function findList(lists: readonly TaskList[], said: string | undefined): TaskList | null {
  if (!said) return lists[0] ?? null;
  const name = listNameOf(said);
  const exact = lists.find((list) => foldForMatch(list.title) === foldForMatch(name));
  if (exact) return exact;
  const matches = matchByText(lists, [name, said], (list) => list.title);
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

const failure = (error: GoogleFailure, ctx: ToolContext): ExecuteResult => {
  if (error.code === 'not_connected' || error.code === 'disconnected') return { text: eventText.grantNotConnected('tasks', ctx.lang) };
  ctx.log.warn('tasks_failed', { errorCode: error.code });
  return { text: taskText.unavailable(ctx.lang) };
};

const notConnected = (ctx: ToolContext): ExecuteResult => ({ text: eventText.grantNotConnected('tasks', ctx.lang) });

// -- tasks.list ---------------------------------------------------------------

const listInputSchema = z.object({ list: z.string().min(1).max(MAX_LIST_CHARS).optional() }).strict();
type ListInput = z.infer<typeof listInputSchema>;

export const tasksList: ToolDefinition = {
  name: 'tasks.list',
  inputSchema: listInputSchema,

  resolve(rawSlots): ResolveOutcome {
    const slots = tasksListSlots.safeParse(rawSlots);
    const list = slots.success ? slots.data.list?.trim() : undefined;
    return { kind: 'ready', input: { ...(list ? { list } : {}) } satisfies ListInput };
  },

  preview: () => 'הצגת רשימות',

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<ListInput>(listInputSchema, rawInput, 'tasks.list');
    if (!ctx.tasks) return notConnected(ctx);

    const lists = await ctx.tasks.lists();
    if (!lists.ok) return failure(lists.error, ctx);
    if (lists.value.length === 0) return { text: taskText.noLists(ctx.lang) };

    const chosen = input.list ? findList(lists.value, input.list) : null;
    if (input.list && !chosen) return { text: taskText.noSuchList(input.list, lists.value.map((l) => l.title), ctx.lang) };

    const shown = chosen ? [chosen] : lists.value.slice(0, MAX_LISTS_SHOWN);
    const sections: Array<{ title: string; items: string[] }> = [];
    for (const list of shown) {
      const tasks = await ctx.tasks.openTasks(list.id);
      if (!tasks.ok) return failure(tasks.error, ctx);
      sections.push({ title: list.title, items: tasks.value.map((task) => task.title) });
    }
    return { text: taskText.lists(sections, ctx.lang) };
  },
};

// -- tasks.add ----------------------------------------------------------------

const addInputSchema = z
  .object({
    title: z.string().min(1).max(MAX_TITLE_CHARS),
    list: z.string().min(1).max(MAX_LIST_CHARS).optional(),
    /** `YYYY-MM-DD`, a local date. */
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .strict();
type AddInput = z.infer<typeof addInputSchema>;

const undoSchema = z.object({ listId: z.string().min(1).max(200), taskId: z.string().min(1).max(200) }).strict();

const isoDate = (day: LocalParts) => `${day.year}-${String(day.month).padStart(2, '0')}-${String(day.day).padStart(2, '0')}`;

export const tasksAdd: ToolDefinition = {
  name: 'tasks.add',
  inputSchema: addInputSchema,

  resolve(rawSlots, ctx): ResolveOutcome {
    const slots = tasksAddSlots.safeParse(rawSlots);
    if (!slots.success) return { kind: 'clarify', clarify: { code: 'missing_slot', slot: 'text' } };
    const title = slots.data.text?.trim();
    if (!title) return { kind: 'clarify', clarify: { code: 'missing_slot', slot: 'text' } };

    let dueDate: string | undefined;
    if (slots.data.date) {
      const when = resolveDay(slots.data.date as DateSpec, { nowMs: ctx.nowMs });
      if (when.kind === 'clarify') return { kind: 'clarify', clarify: { code: 'time', detail: when } };
      dueDate = isoDate(localPartsOf(when.utcMs, ZONE));
    }
    const list = slots.data.list?.trim();
    return {
      kind: 'ready',
      input: { title, ...(list ? { list } : {}), ...(dueDate ? { dueDate } : {}) } satisfies AddInput,
    };
  },

  preview(rawInput, lang): string {
    const input = parseInput<AddInput>(addInputSchema, rawInput, 'tasks.add');
    return taskText.addPreview(input.title, input.list ? listNameOf(input.list) : null, lang);
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<AddInput>(addInputSchema, rawInput, 'tasks.add');
    if (!ctx.tasks) return notConnected(ctx);

    const lists = await ctx.tasks.lists();
    if (!lists.ok) return failure(lists.error, ctx);

    // A list the user named that does not exist yet is made: "תוסיף חלב
    // לרשימת קניות" on a first day should just work.
    let list = findList(lists.value, input.list);
    let created = false;
    if (!list) {
      const made = await ctx.tasks.createList(input.list ? listNameOf(input.list) : 'המשימות שלי');
      if (!made.ok) return failure(made.error, ctx);
      list = made.value;
      created = true;
    }

    const added = await ctx.tasks.add(list.id, input.title, input.dueDate ?? null);
    if (!added.ok) return failure(added.error, ctx);

    const due = input.dueDate ? localPartsOfDate(input.dueDate) : null;
    return {
      text: taskText.added(input.title, list.title, created, due, ctx.lang),
      compensating: { listId: list.id, taskId: added.value.id },
      externalRef: added.value.id,
    };
  },

  async undo(compensating, ctx): Promise<ExecuteResult> {
    const { listId, taskId } = parseInput<z.infer<typeof undoSchema>>(undoSchema, compensating, 'tasks.add');
    if (!ctx.tasks) return notConnected(ctx);
    const removed = await ctx.tasks.remove(listId, taskId);
    if (!removed.ok) return failure(removed.error, ctx);
    return { text: taskText.undoneAdd(ctx.lang) };
  },
};

function localPartsOfDate(iso: string): LocalParts {
  const [year, month, day] = iso.split('-').map(Number) as [number, number, number];
  return localPartsOf(Date.UTC(year, month - 1, day, 9), ZONE);
}

// -- tasks.complete -------------------------------------------------------------

const completeInputSchema = z
  .object({
    listId: z.string().min(1).max(200),
    taskId: z.string().min(1).max(200),
    title: z.string().min(1).max(MAX_TITLE_CHARS),
    listTitle: z.string().min(1).max(MAX_TITLE_CHARS),
  })
  .strict();
type CompleteInput = z.infer<typeof completeInputSchema>;

export const tasksComplete: ToolDefinition = {
  name: 'tasks.complete',
  inputSchema: completeInputSchema,

  resolve(): ResolveOutcome {
    // The tasks live behind the network: `resolveAsync` does the work.
    return { kind: 'clarify', clarify: { code: 'missing_slot', slot: 'target' } };
  },

  async resolveAsync(rawSlots, ctx): Promise<ResolveOutcome> {
    const slots = tasksCompleteSlots.safeParse(rawSlots);
    const variants = slots.success ? (slots.data.query_variants ?? []) : [];
    if (variants.length === 0) return { kind: 'clarify', clarify: { code: 'missing_slot', slot: 'target' } };
    if (!ctx.tasks) return { kind: 'clarify', clarify: { code: 'grant_missing', grant: 'tasks' } };

    const lists = await ctx.tasks.lists();
    if (!lists.ok) {
      return lists.error.code === 'not_connected' || lists.error.code === 'disconnected'
        ? { kind: 'clarify', clarify: { code: 'grant_missing', grant: 'tasks' } }
        : { kind: 'clarify', clarify: { code: 'not_found' } };
    }
    const named = slots.success ? slots.data.list : undefined;
    const searched = named ? [findList(lists.value, named)].filter((l): l is TaskList => l !== null) : lists.value.slice(0, MAX_LISTS_SEARCHED);

    const found: CompleteInput[] = [];
    for (const list of searched) {
      const tasks = await ctx.tasks.openTasks(list.id);
      if (!tasks.ok) continue;
      for (const task of matchByText(tasks.value, variants, (t) => t.title)) {
        found.push({ listId: list.id, taskId: task.id, title: task.title, listTitle: list.title });
      }
    }

    if (found.length === 0) return { kind: 'clarify', clarify: { code: 'not_found' } };
    if (found.length === 1) return { kind: 'ready', input: found[0]! };
    return {
      kind: 'clarify',
      clarify: {
        code: 'ambiguous',
        choices: found.slice(0, MAX_CHOICES).map((item) => ({ id: item.taskId, label: `${item.title} (${item.listTitle})` })),
      },
    };
  },

  preview(rawInput, lang): string {
    const input = parseInput<CompleteInput>(completeInputSchema, rawInput, 'tasks.complete');
    return taskText.completePreview(input.title, input.listTitle, lang);
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<CompleteInput>(completeInputSchema, rawInput, 'tasks.complete');
    if (!ctx.tasks) return notConnected(ctx);
    const done = await ctx.tasks.setDone(input.listId, input.taskId, true);
    if (!done.ok) return failure(done.error, ctx);
    return {
      text: taskText.completed(input.title, input.listTitle, ctx.lang),
      compensating: { listId: input.listId, taskId: input.taskId },
      externalRef: input.taskId,
    };
  },

  async undo(compensating, ctx): Promise<ExecuteResult> {
    const { listId, taskId } = parseInput<z.infer<typeof undoSchema>>(undoSchema, compensating, 'tasks.complete');
    if (!ctx.tasks) return notConnected(ctx);
    const reopened = await ctx.tasks.setDone(listId, taskId, false);
    if (!reopened.ok) return failure(reopened.error, ctx);
    return { text: taskText.undoneComplete(ctx.lang) };
  },
};

export const TASK_TOOLS = {
  'tasks.list': tasksList,
  'tasks.add': tasksAdd,
  'tasks.complete': tasksComplete,
} as const;

/** Exported for the tests' sake: how a task's choice is labelled. */
export type { TasksClient };
