/**
 * `calls.place` — "תתקשר לדוד דני" (PLAN §6.17).
 *
 * The Worker cannot place a call. It hands the words to the paired phone, which
 * matches them against its own contacts and shows the resolved number behind a
 * full-screen tap. That tap is the Tier 3 factor, so this tool has no confirm
 * button in chat and no typed code (§6.5): the policy engine marks its
 * confirmation as happening on the device, and the orchestrator dispatches.
 *
 * The reply comes later, and only once — when the phone reports how it ended or
 * the dispatch expires unanswered (invariant 10).
 */
import { z } from 'zod';
import { callsPlaceSlots, MAX_QUERY_CHARS, MAX_QUERY_VARIANTS } from '../nlu/slot-schemas.js';
import { callText } from '../render/calls.js';
import { parseInput } from './types.js';
import type { ResolveOutcome, ToolDefinition } from './types.js';

const inputSchema = z
  .object({
    queryVariants: z.array(z.string().min(1).max(MAX_QUERY_CHARS)).min(1).max(MAX_QUERY_VARIANTS),
  })
  .strict();

type CallInput = z.infer<typeof inputSchema>;

/**
 * Anything that could be a phone number. Five digits is below any dialable
 * number and above anything a name contains ("דני 2" is a name, "050-12" is
 * not one). A `+` before a digit is an international prefix.
 */
export function looksLikeNumber(text: string): boolean {
  const digits = text.replace(/\D/g, '');
  return digits.length >= 5 || /\+\s*\d/.test(text);
}

export const callsPlace: ToolDefinition = {
  name: 'calls.place',
  inputSchema,

  resolve(rawSlots): ResolveOutcome {
    const slots = callsPlaceSlots.safeParse(rawSlots);
    const variants = slots.success
      ? (slots.data.query_variants ?? []).map((v) => v.trim()).filter((v) => v.length > 0)
      : [];
    if (variants.length === 0) {
      return { kind: 'clarify', clarify: { code: 'missing_slot', slot: 'target' } };
    }

    // The most important rule in §6.17: no text — mine, forwarded, injected or
    // misheard — can name a destination that was not already on the phone.
    if (variants.some(looksLikeNumber)) {
      return { kind: 'clarify', clarify: { code: 'call_number_refused' } };
    }

    return { kind: 'ready', input: { queryVariants: variants } satisfies CallInput };
  },

  preview(input, lang) {
    const { queryVariants } = parseInput<CallInput>(inputSchema, input, 'calls.place');
    return callText.preview(queryVariants[0] ?? '', lang);
  },

  async execute(input, ctx) {
    const { queryVariants } = parseInput<CallInput>(inputSchema, input, 'calls.place');
    if (!ctx.calls) return { text: callText.notConfigured(ctx.lang) };

    const sent = await ctx.calls.dispatch(ctx.principal, queryVariants);
    if (sent.ok) return { text: '', replyLater: true, externalRef: sent.dispatchId };
    return {
      text: sent.reason === 'no_device' ? callText.noDevice(ctx.lang) : callText.phoneUnavailable(ctx.lang),
    };
  },
};
