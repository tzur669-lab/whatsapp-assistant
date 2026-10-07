/**
 * `memory.*` (PLAN §6.26, ROADMAP block H part 18, 2026-10-07): facts about the
 * user, which the model sees on every agent turn.
 *
 * Not private — that is the point of a fact. So what may become one is narrow:
 * only on an explicit "about me" signal (the tool's description), never from
 * someone else's words (a tainted turn is refused), and never with an email, a
 * link, a phone number, a code or a long number in it.
 */
import { z } from 'zod';
import { MAX_FACT_TEXT_CHARS, memoryForgetSlots, memoryRememberSlots } from '../nlu/slot-schemas.js';
import { factText, personalQuestion } from '../render/personal.js';
import { isolate } from '../render/bidi.js';
import { containsPrivateData } from '../security/scrub.js';
import type { FactStore } from './fact-store.js';
import { matchByText } from './match.js';
import { parseInput } from './types.js';
import type { ExecuteResult, PersonalQuestion, ResolveOutcome, ToolContext, ToolDefinition } from './types.js';

const MAX_CHOICES = 5;

const ask = (what: PersonalQuestion): ResolveOutcome => ({ kind: 'clarify', clarify: { code: 'personal', what } });

function storeOf(ctx: ToolContext): FactStore {
  if (!ctx.facts) throw new Error('E_FACTS_UNAVAILABLE');
  return ctx.facts;
}

// -- memory.remember ------------------------------------------------------------

const rememberInputSchema = z.object({ text: z.string().min(1).max(MAX_FACT_TEXT_CHARS) }).strict();
type RememberInput = z.infer<typeof rememberInputSchema>;

export const memoryRemember: ToolDefinition = {
  name: 'memory.remember',
  inputSchema: rememberInputSchema,

  resolve(rawSlots, ctx): ResolveOutcome {
    const slots = memoryRememberSlots.safeParse(rawSlots);
    const text = slots.success ? slots.data.text?.trim() : undefined;
    if (!text) return ask('fact_text');
    if (ctx.tainted) return ask('fact_tainted');
    // The model sees every fact, verbatim: what it must never see stays out.
    if (containsPrivateData(text)) return ask('fact_private');
    return { kind: 'ready', input: { text } satisfies RememberInput };
  },

  preview(rawInput, lang): string {
    return factText.remembered(parseInput<RememberInput>(rememberInputSchema, rawInput, 'memory.remember').text, lang);
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<RememberInput>(rememberInputSchema, rawInput, 'memory.remember');
    // Execute runs with the turn's taint (`orchestrator.execute`): still refused.
    if (ctx.tainted) return { text: personalQuestion('fact_tainted', ctx.lang) };
    if (containsPrivateData(input.text)) return { text: personalQuestion('fact_private', ctx.lang) };
    const outcome = await storeOf(ctx).add(ctx.principal, input.text);
    if (outcome.kind === 'full') return { text: personalQuestion('facts_full', ctx.lang) };
    return {
      text: factText.remembered(outcome.fact.text, ctx.lang),
      compensating: { factId: outcome.fact.id },
      externalRef: outcome.fact.id,
    };
  },

  async undo(compensating, ctx): Promise<ExecuteResult> {
    const { factId } = parseInput<{ factId: string }>(
      z.object({ factId: z.string().min(1).max(64) }).strict(),
      compensating,
      'memory.remember',
    );
    // Gone already is the state the Undo asked for.
    storeOf(ctx).remove(factId, ctx.principal);
    return { text: factText.forgotten(ctx.lang) };
  },
};

// -- memory.forget --------------------------------------------------------------

const forgetInputSchema = z
  .object({ factId: z.string().min(1).max(64), text: z.string().min(1).max(MAX_FACT_TEXT_CHARS) })
  .strict();
type ForgetInput = z.infer<typeof forgetInputSchema>;

export const memoryForget: ToolDefinition = {
  name: 'memory.forget',
  inputSchema: forgetInputSchema,

  resolve(): ResolveOutcome {
    // The facts are ciphertext: found in `resolveAsync`.
    return { kind: 'clarify', clarify: { code: 'missing_slot', slot: 'target' } };
  },

  async resolveAsync(rawSlots, ctx): Promise<ResolveOutcome> {
    const slots = memoryForgetSlots.safeParse(rawSlots);
    const variants = slots.success ? (slots.data.query_variants ?? []) : [];
    const all = await storeOf(ctx).all(ctx.principal);
    if (all.length === 0) return ask('no_facts');
    if (variants.length === 0) return { kind: 'clarify', clarify: { code: 'missing_slot', slot: 'target' } };
    const found = matchByText(all, variants, (fact) => fact.text);
    if (found.length === 0) return { kind: 'clarify', clarify: { code: 'not_found' } };
    if (found.length === 1 && found[0]) {
      return { kind: 'ready', input: { factId: found[0].id, text: found[0].text } satisfies ForgetInput };
    }
    return {
      kind: 'clarify',
      clarify: {
        code: 'ambiguous',
        choices: found.slice(0, MAX_CHOICES).map((fact) => ({ id: fact.id, label: isolate(fact.text) })),
      },
    };
  },

  preview(rawInput, lang): string {
    return factText.forgetPreview(parseInput<ForgetInput>(forgetInputSchema, rawInput, 'memory.forget').text, lang);
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<ForgetInput>(forgetInputSchema, rawInput, 'memory.forget');
    const removed = storeOf(ctx).remove(input.factId, ctx.principal);
    return { text: removed ? factText.forgotten(ctx.lang) : factText.gone(ctx.lang), externalRef: input.factId };
  },
};

export const MEMORY_TOOLS = {
  'memory.remember': memoryRemember,
  'memory.forget': memoryForget,
} as const;
