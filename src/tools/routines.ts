/**
 * `routine.run` (PLAN §6.27, stage 2): run one of the user's routines now or
 * at a time, inside the next seven days.
 *
 * The model names a routine; code finds it among the names the paired app
 * synced (invariant 5) and computes the time (invariant 4). Tier 2: the user
 * confirms in the chat, and only then is the run scheduled. At the due time it
 * runs with no further tap (decision D1), after a notice with a cancel button
 * two minutes before. The steps never leave the phone; the confirmed run is
 * bound to the steps' hash, and a routine edited after the confirmation does
 * not run.
 *
 * A turn that read someone else's text cannot schedule one at all.
 */
import { z } from 'zod';
import { resolveWhen } from '../time/resolve.js';
import type { DateSpec, TimeSpec } from '../time/resolve.js';
import { ZONE } from '../time/tz.js';
import { foldForMatch, matchByText } from './match.js';
import { personalQuestion } from '../render/personal.js';
import { routineText } from '../render/routines.js';
import type { RoutineView } from '../render/routines.js';
import type { ExecuteResult, PersonalQuestion, ResolveOutcome, ToolContext, ToolDefinition } from './types.js';
import { parseInput } from './types.js';
import { MAX_APP_LABEL, MAX_ROUTINE_NAME, ROUTINE_HORIZON_MS } from './routine-store.js';
import type { RoutineName, RoutineStore } from './routine-store.js';

const HASH = /^[0-9a-f]{64}$/;

export const routineInputSchema = z
  .object({
    routineId: z.string().min(1).max(64),
    name: z.string().min(1).max(MAX_ROUTINE_NAME),
    appLabel: z.string().min(1).max(MAX_APP_LABEL),
    stepHash: z.string().regex(HASH),
    dueAtUtc: z.number().int().positive(),
    tz: z.string().min(1).max(64),
    /** No day or time was said: it runs as soon as it is confirmed. */
    now: z.boolean(),
  })
  .strict();

type RoutineInput = z.infer<typeof routineInputSchema>;

const slotsSchema = z
  .object({
    routine: z.array(z.string()).optional(),
    date: z.unknown().optional(),
    time: z.unknown().optional(),
  })
  .passthrough();

export const routineRun: ToolDefinition = {
  name: 'routine.run',
  inputSchema: routineInputSchema,

  resolve(rawSlots, ctx): ResolveOutcome {
    if (ctx.tainted) return ask('routine_tainted');
    const slots = slotsSchema.safeParse(rawSlots);
    const variants = slots.success ? (slots.data.routine ?? []).map((v) => v.trim()).filter((v) => v.length > 0) : [];

    const names = storeOf(ctx)?.names(ctx.principal) ?? [];
    if (names.length === 0) return ask('no_routines');
    if (variants.length === 0) return ask('routine_name');

    const found = findRoutine(names, variants);
    if (found === 'none') return ask('routine_unknown');
    if (found === 'many') return ask('routine_ambiguous');

    const date = slots.success ? (slots.data.date as DateSpec | undefined) : undefined;
    const time = slots.success ? (slots.data.time as TimeSpec | undefined) : undefined;
    let dueAtUtc = ctx.nowMs;
    let tz = ZONE;
    const now = date === undefined && time === undefined;
    if (!now) {
      const when = resolveWhen({ date, time }, { nowMs: ctx.nowMs });
      if (when.kind === 'clarify') return { kind: 'clarify', clarify: { code: 'time', detail: when } };
      dueAtUtc = when.utcMs;
      tz = when.zone;
      if (dueAtUtc - ctx.nowMs > ROUTINE_HORIZON_MS) return ask('routine_far');
    }

    const input: RoutineInput = {
      routineId: found.routineId,
      name: found.name,
      appLabel: found.appLabel,
      stepHash: found.stepHash,
      dueAtUtc,
      tz,
      now,
    };
    return { kind: 'ready', input };
  },

  preview(rawInput, lang): string {
    const input = parseInput<RoutineInput>(routineInputSchema, rawInput, 'routine.run');
    return routineText.preview(viewOf(input), lang);
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<RoutineInput>(routineInputSchema, rawInput, 'routine.run');
    // Execute runs with the turn's taint (`orchestrator.execute`): still refused.
    if (ctx.tainted) return { text: personalQuestion('routine_tainted', ctx.lang) };
    const store = storeOf(ctx);
    if (!store) return { text: personalQuestion('no_routines', ctx.lang) };

    // Between the confirmation and now the phone may have synced a change.
    // The run is bound to the steps that were confirmed, or it is not made.
    const current = store.names(ctx.principal).find((r) => r.routineId === input.routineId);
    if (!current || current.stepHash !== input.stepHash) {
      return { text: routineText.changed(input, ctx.lang) };
    }

    const dueAtUtc = input.now ? ctx.nowMs : input.dueAtUtc;
    const { run } = store.schedule({
      principal: ctx.principal,
      routine: { routineId: input.routineId, name: input.name, appLabel: input.appLabel, stepHash: input.stepHash },
      dueAtUtc,
      tz: input.tz,
    });
    return {
      text: routineText.scheduled({ ...viewOf(input), dueAtUtc }, ctx.lang),
      externalRef: run.runId,
      rescheduleAlarm: true,
    };
  },
};

/**
 * The one routine the words name: an exact name first, else one whose name
 * holds the words or is held by them. Several → ask for the full name; a
 * guess never runs something in another app.
 */
export function findRoutine(names: readonly RoutineName[], variants: readonly string[]): RoutineName | 'none' | 'many' {
  const wanted = variants.map(foldForMatch).filter((v) => v.length > 0);
  const exact = names.filter((r) => wanted.includes(foldForMatch(r.name)));
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return 'many';
  const partial = matchByText(names, variants, (r) => r.name);
  if (partial.length === 1) return partial[0]!;
  return partial.length === 0 ? 'none' : 'many';
}

function viewOf(input: RoutineInput): RoutineView {
  return { name: input.name, appLabel: input.appLabel, dueAtUtc: input.dueAtUtc, tz: input.tz, now: input.now };
}

function storeOf(ctx: ToolContext): RoutineStore | undefined {
  return ctx.routines;
}

function ask(what: PersonalQuestion): ResolveOutcome {
  return { kind: 'clarify', clarify: { code: 'personal', what } };
}
