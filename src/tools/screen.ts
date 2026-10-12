/**
 * `screen.task` (PLAN §6.28): the screen agent does one task inside one app on
 * the phone — "תחפש בפיד סטימצקי".
 *
 * Tier 2: the user confirms a card that names the app, the task and every
 * text the agent may type, word for word, and only then is the task made.
 * Code finds the app among the ones the user turned on on the phone
 * (invariant 5). The texts to type are checked against the message's own
 * words: the model may only point at what the user wrote, and the phone types
 * the stored value. A turn that read someone else's text cannot start one.
 *
 * Private: its replies hold the user's task and inputs, which no model reads
 * back. Offered only when the message names the screen agent or an app on
 * its list (`namesScreenTask`), so it never costs the full catalog's tokens.
 */
import { z } from 'zod';
import { foldForMatch, matchByText } from './match.js';
import { screenText } from '../render/screen.js';
import type { ScreenQuestion } from '../render/screen.js';
import type { ExecuteResult, ResolveOutcome, ToolContext, ToolDefinition } from './types.js';
import { parseInput } from './types.js';
import {
  MAX_SCREEN_INPUT,
  MAX_SCREEN_INPUTS,
  MAX_SCREEN_LABEL,
  MAX_SCREEN_TASK,
  SCREEN_ROUTINE_GUARD_MS,
  SCREEN_TASKS_PER_DAY,
} from './screen-store.js';
import type { AllowedApp } from './screen-store.js';

export const screenInputSchema = z
  .object({
    package: z.string().min(1).max(200),
    appLabel: z.string().min(1).max(MAX_SCREEN_LABEL),
    task: z.string().min(1).max(MAX_SCREEN_TASK),
    inputs: z.array(z.string().min(1).max(MAX_SCREEN_INPUT)).max(MAX_SCREEN_INPUTS),
  })
  .strict();

type ScreenInput = z.infer<typeof screenInputSchema>;

const slotsSchema = z
  .object({
    app: z.string().optional(),
    task: z.string().optional(),
    inputs: z.array(z.string()).optional(),
  })
  .passthrough();

/**
 * Text as an input is compared with the message: NFC, no bidi marks or
 * zero-width characters, no niqqud, spaces collapsed, case folded — as the
 * phone's `RoutineLogic.normalize`, plus niqqud.
 */
export function normalizeInput(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .replace(/[\u0591-\u05C7]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Whether every input is said, as is, in the user's own message. */
export function inputsSaid(inputs: readonly string[], message: string): boolean {
  const said = normalizeInput(message);
  return inputs.every((input) => {
    const wanted = normalizeInput(input);
    return wanted.length > 0 && said.includes(wanted);
  });
}

export const screenTask: ToolDefinition = {
  name: 'screen.task',
  inputSchema: screenInputSchema,

  resolve(rawSlots, ctx): ResolveOutcome {
    if (ctx.channel !== 'app') return ask('not_app');
    if (ctx.tainted) return ask('tainted');
    const store = ctx.screen;
    const allowed = store?.allowed(ctx.principal) ?? [];
    if (!store || allowed.length === 0) return ask('no_apps');
    const labels = allowed.map((app) => app.label);

    const parsed = slotsSchema.safeParse(rawSlots);
    const slots = parsed.success ? parsed.data : {};
    const named = slots.app?.trim() ?? '';
    let app: AllowedApp | null;
    if (named === '') {
      if (allowed.length !== 1) return ask('app', labels);
      app = allowed[0]!;
    } else {
      const found = findApp(allowed, named);
      if (found === 'none') return ask('app_unknown', labels);
      if (found === 'many') return ask('app', labels);
      app = found;
    }

    const task = slots.task?.trim() ?? '';
    if (task === '' || task.length > MAX_SCREEN_TASK) return ask('task');
    const inputs = (slots.inputs ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
    if (inputs.length > MAX_SCREEN_INPUTS || inputs.some((value) => value.length > MAX_SCREEN_INPUT)) {
      return ask('input_not_said');
    }
    if (!inputsSaid(inputs, ctx.userText ?? '')) return ask('input_not_said');

    const blocked = startBlocked(ctx);
    if (blocked) return ask(blocked);

    const input: ScreenInput = { package: app.package, appLabel: app.label, task, inputs };
    return { kind: 'ready', input };
  },

  preview(rawInput, lang): string {
    const input = parseInput<ScreenInput>(screenInputSchema, rawInput, 'screen.task');
    return screenText.preview(input, lang);
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<ScreenInput>(screenInputSchema, rawInput, 'screen.task');
    // Execute runs with the turn's taint: still refused.
    if (ctx.tainted) return { text: screenText.question('tainted', ctx.lang) };
    const store = ctx.screen;
    if (!store) return { text: screenText.question('no_apps', ctx.lang) };
    // Between the card and the tap the phone may have turned the app off.
    const app = store.allowedApp(ctx.principal, input.package);
    if (!app) return { text: screenText.question('app_unknown', ctx.lang, store.allowed(ctx.principal).map((a) => a.label)) };
    const blocked = startBlocked(ctx);
    if (blocked) return { text: screenText.question(blocked, ctx.lang) };

    // The stored, confirmed input — never a re-parse (invariant 7).
    const task = await store.create({
      principal: ctx.principal,
      package: input.package,
      appLabel: app.label,
      task: input.task,
      inputs: input.inputs,
    });
    return { text: screenText.started(app.label, ctx.lang), externalRef: task.taskId, rescheduleAlarm: true };
  },
};

/** Why no task may start now, or null: one at a time, three a day, routines first. */
function startBlocked(ctx: ToolContext): ScreenQuestion | null {
  const store = ctx.screen;
  if (!store) return 'no_apps';
  if (store.active(ctx.principal)) return 'busy';
  if (store.countToday(ctx.principal) >= SCREEN_TASKS_PER_DAY) return 'daily_cap';
  const soon = (ctx.routines?.open(ctx.principal) ?? []).some((run) => run.dueAtUtc - ctx.nowMs < SCREEN_ROUTINE_GUARD_MS);
  if (soon) return 'routine_soon';
  return null;
}

/** The one allowed app the words name: its label or package exactly, else one that matches by text. */
export function findApp(allowed: readonly AllowedApp[], named: string): AllowedApp | 'none' | 'many' {
  const wanted = foldForMatch(named);
  const exact = allowed.filter((app) => foldForMatch(app.label) === wanted || app.package.toLowerCase() === named.toLowerCase());
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return 'many';
  const partial = matchByText(allowed, [named], (app) => app.label);
  if (partial.length === 1) return partial[0]!;
  return partial.length === 0 ? 'none' : 'many';
}

/**
 * Whether the message names the screen agent or an app on its list (PLAN
 * §6.28): only then is `screen.task` offered. Code reads the words.
 */
export function namesScreenTask(text: string, allowed: readonly AllowedApp[]): boolean {
  if (allowed.length === 0) return false;
  if (/סוכן\s*(?:ה)?מסך|על המסך|במסך|\bscreen agent\b|\bon (?:the|my) screen\b/i.test(text)) return true;
  const folded = foldForMatch(text);
  return allowed.some((app) => {
    const label = foldForMatch(app.label);
    return label.length > 1 && folded.includes(label);
  });
}

function ask(what: ScreenQuestion, labels?: readonly string[]): ResolveOutcome {
  return { kind: 'clarify', clarify: { code: 'screen', what, ...(labels ? { labels: [...labels] } : {}) } };
}
