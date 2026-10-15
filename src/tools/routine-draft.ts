/**
 * `routine.draft` (docs/plans/routine-builder.md, part 1): the bot drafts a
 * routine — "תבנה שגרה: באפליקציית הנוכחות ללחוץ כניסה" — from the user's
 * words and the app's first screen. Nothing runs now.
 *
 * Tier 2: the card names the app, the goal and every word and text the draft
 * may use, each found as is in the message (code checks, at resolve). Code
 * finds the app among the ones the user turned on for the screen agent
 * (invariant 5). After the tap the phone opens the app, reads its first
 * screen (taps nothing) and asks the server for the steps; the user saves the
 * routine on the phone after a dry run. The server never saves one.
 *
 * Private: its replies hold the user's words. The message itself is never
 * kept (a voice transcript, invariant 13): only the confirmed input is.
 * Offered only when the words ask to build a routine and the app can.
 */
import { z } from 'zod';
import { draftText } from '../render/routine-draft.js';
import { screenText } from '../render/screen.js';
import type { ScreenQuestion } from '../render/screen.js';
import type { ExecuteResult, ResolveOutcome, ToolContext, ToolDefinition } from './types.js';
import { parseInput } from './types.js';
import { findApp, inputsSaid } from './screen.js';
import { MAX_SCREEN_LABEL } from './screen-store.js';
import type { AllowedApp } from './screen-store.js';
import {
  DRAFT_ROUTINE_GUARD_MS,
  MAX_DRAFT_GOAL,
  MAX_DRAFT_INPUT,
  MAX_DRAFT_INPUTS,
  MAX_DRAFT_WORD,
  MAX_DRAFT_WORDS,
} from './routine-draft-store.js';

export const draftInputSchema = z
  .object({
    package: z.string().min(1).max(200),
    appLabel: z.string().min(1).max(MAX_SCREEN_LABEL),
    goal: z.string().min(1).max(MAX_DRAFT_GOAL),
    inputs: z.array(z.string().min(1).max(MAX_DRAFT_INPUT)).max(MAX_DRAFT_INPUTS),
    words: z.array(z.string().min(1).max(MAX_DRAFT_WORD)).max(MAX_DRAFT_WORDS),
    /** Confirmed in a smart conversation: Gemini drafts it. Set by code from the turn, never by the model. */
    smart: z.literal(true).optional(),
  })
  .strict();

type DraftInput = z.infer<typeof draftInputSchema>;

const slotsSchema = z
  .object({
    app: z.string().optional(),
    goal: z.string().optional(),
    inputs: z.array(z.string()).optional(),
    words: z.array(z.string()).optional(),
  })
  .passthrough();

export const routineDraft: ToolDefinition = {
  name: 'routine.draft',
  inputSchema: draftInputSchema,

  resolve(rawSlots, ctx): ResolveOutcome {
    if (ctx.channel !== 'app') return ask('not_app');
    if (ctx.tainted) return ask('tainted');
    const allowed = ctx.screen?.allowed(ctx.principal) ?? [];
    if (!ctx.screen || !ctx.drafts || allowed.length === 0) return ask('no_apps');
    const labels = allowed.map((app) => app.label);

    const parsed = slotsSchema.safeParse(rawSlots);
    const slots = parsed.success ? parsed.data : {};
    const named = slots.app?.trim() ?? '';
    let app: AllowedApp;
    if (named === '') {
      if (allowed.length !== 1) return ask('app', labels);
      app = allowed[0]!;
    } else {
      const found = findApp(allowed, named);
      if (found === 'none') return ask('app_unknown', labels);
      if (found === 'many') return ask('app', labels);
      app = found;
    }

    const goal = slots.goal?.trim() ?? '';
    if (goal === '' || goal.length > MAX_DRAFT_GOAL) return ask('goal');
    const said = ctx.userText ?? '';
    const inputs = cleaned(slots.inputs);
    if (inputs.length > MAX_DRAFT_INPUTS || inputs.some((v) => v.length > MAX_DRAFT_INPUT) || !inputsSaid(inputs, said)) {
      return ask('input_not_said');
    }
    const words = cleaned(slots.words);
    if (words.length > MAX_DRAFT_WORDS || words.some((v) => v.length > MAX_DRAFT_WORD) || !inputsSaid(words, said)) {
      return ask('word_not_said');
    }

    const blocked = startBlocked(ctx);
    if (blocked) return ask(blocked);

    const input: DraftInput = {
      package: app.package,
      appLabel: app.label,
      goal,
      inputs,
      words,
      ...(ctx.smart ? { smart: true as const } : {}),
    };
    return { kind: 'ready', input };
  },

  preview(rawInput, lang): string {
    const input = parseInput<DraftInput>(draftInputSchema, rawInput, 'routine.draft');
    return draftText.preview(input, lang);
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<DraftInput>(draftInputSchema, rawInput, 'routine.draft');
    // Execute runs with the turn's taint: still refused.
    if (ctx.tainted) return { text: screenText.question('tainted', ctx.lang) };
    if (!ctx.screen || !ctx.drafts) return { text: screenText.question('no_apps', ctx.lang) };
    // Between the card and the tap the phone may have turned the app off.
    const app = ctx.screen.allowedApp(ctx.principal, input.package);
    if (!app) return { text: screenText.question('app_unknown', ctx.lang, ctx.screen.allowed(ctx.principal).map((a) => a.label)) };
    const blocked = startBlocked(ctx);
    if (blocked) return { text: screenText.question(blocked, ctx.lang) };

    // The stored, confirmed input — never a re-parse (invariant 7).
    const draft = await ctx.drafts.create({
      principal: ctx.principal,
      package: input.package,
      appLabel: app.label,
      goal: input.goal,
      inputs: input.inputs,
      words: input.words,
      mode: input.smart ? 'smart' : 'local',
    });
    return { text: draftText.started(app.label, ctx.lang), externalRef: draft.draftId, rescheduleAlarm: true };
  },
};

/** Why no draft may start now, or null: nothing else reading the screen, and routines first. */
function startBlocked(ctx: ToolContext): ScreenQuestion | null {
  if (ctx.screen?.active(ctx.principal)) return 'busy';
  if (ctx.drafts?.active(ctx.principal)) return 'draft_open';
  const soon = (ctx.routines?.open(ctx.principal) ?? []).some((run) => run.dueAtUtc - ctx.nowMs < DRAFT_ROUTINE_GUARD_MS);
  if (soon) return 'draft_routine_soon';
  return null;
}

function cleaned(values: readonly string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
}

/**
 * Whether the words ask to build a routine (docs/plans/routine-builder.md):
 * the routine word and a build verb. Unlike `namesRoutine`, it needs no
 * synced routine. Code reads the words; only then is `routine.draft` offered.
 */
export function namesRoutineBuild(text: string): boolean {
  if (!/שגר|רוטינ|\broutines?\b/i.test(text)) return false;
  return /(?<![א-ת])[ותש]?(?:תבנה|תבני|לבנות|בנה|בני|תיצור|תיצרי|ליצור|צור|צרי|תכין|תכיני|להכין|הכן|תגדיר|להגדיר|תעשה לי)(?![א-ת])|\b(?:build|create|make|set up|draft)\b/i.test(text);
}

function ask(what: ScreenQuestion, labels?: readonly string[]): ResolveOutcome {
  return { kind: 'clarify', clarify: { code: 'screen', what, ...(labels ? { labels: [...labels] } : {}) } };
}
