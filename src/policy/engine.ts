/**
 * The policy engine (PLAN §6.4).
 *
 * Takes a tool name and a context, returns a decision. It is a pure function of
 * static config and code — nothing arriving over chat can reach it
 * (CLAUDE.md invariant 8). There is no Tier 4 branch to find, because there is
 * no Tier 4 code path anywhere in the system.
 *
 * The bias is downward: when several rules apply, the most restrictive wins.
 */
import { REGISTRY, TOOL_NAMES } from '../tools/registry.js';
import type { Tier, ToolName } from '../tools/registry.js';
import { STALE_MESSAGE_MS } from '../channels/limits.js';

export type Decision = 'ALLOW' | 'CLARIFY' | 'CONFIRM' | 'DENY';

export type PolicyReason =
  | 'unknown_tool'
  | 'paused'
  | 'rate_limited'
  | 'stale_message'
  | 'forwarded'
  | 'far_future'
  | 'voice_uncertain'
  | 'tier_requires_confirmation'
  | 'allowed';

export type RateLimit = { perHour: number; perDay: number };

export type PolicyContext = {
  nowMs: number;
  /** Meta's timestamp for the message, not ours. */
  messageSentAtMs: number;
  forwarded: boolean;
  paused: boolean;
  usage: { perHour: number; perDay: number };
  limits: Readonly<Record<string, RateLimit>>;
  /** R8: the resolved time is beyond the confirmation horizon. */
  horizonExceeded: boolean;
  /**
   * How the request reached us. A voice note is a transcript of what the user
   * said, not the characters they typed, and they never saw it before it was
   * acted on (PLAN §6.10).
   */
  source?: 'text' | 'voice';
  /**
   * Set for voice. A transcript the recognizer was unsure of is still used — the
   * hopeless ones never get this far — but a write it leads to is put behind a
   * confirmation, where the echoed transcript is there to be checked.
   */
  voiceConfidence?: 'high' | 'uncertain';
};

export type PolicyExtras = {
  /** Attendees make an event external-facing, which is Tier 3 (PLAN §6.4). */
  hasAttendees?: boolean;
};

export type PolicyResult = {
  decision: Decision;
  tier: Tier | null;
  reason: PolicyReason;
  /** Every rule that fired, for the audit log. The first is the deciding one. */
  allReasons: PolicyReason[];
  /** Tier 1 executes immediately and offers an Undo. */
  undoable: boolean;
  /** Tier 3 needs a typed code, not just a button. */
  requiresTypedCode: boolean;
  /**
   * The confirmation happens on the paired phone, not in chat: dispatch, and
   * let its screen ask (PLAN §6.17). Never set on anything but CONFIRM.
   */
  confirmOnDevice: boolean;
};

export const DEFAULT_LIMITS: Readonly<Record<ToolName, RateLimit>> = Object.fromEntries(
  TOOL_NAMES.map((name) => [name, REGISTRY[name].rateLimit]),
) as Record<ToolName, RateLimit>;

const READ_TIER: Tier = 0;

export function decide(tool: ToolName, ctx: PolicyContext, extras: PolicyExtras = {}): PolicyResult {
  const spec = REGISTRY[tool];
  if (!spec) {
    return result('DENY', null, 'unknown_tool', ['unknown_tool']);
  }

  const tier = effectiveTier(tool, extras);
  const isWrite = tier > READ_TIER;
  const reasons: PolicyReason[] = [];

  // Denials first. A denial is never softened by a later rule.
  if (isWrite && ctx.paused) {
    return result('DENY', tier, 'paused', ['paused']);
  }

  const limit = ctx.limits[tool] ?? spec.rateLimit;
  if (ctx.usage.perHour >= limit.perHour || ctx.usage.perDay >= limit.perDay) {
    return result('DENY', tier, 'rate_limited', ['rate_limited']);
  }

  // Escalations. Each is recorded even when another already forced CONFIRM, so
  // the audit log shows everything that was true, not only what decided it.
  if (isWrite && isStale(ctx)) reasons.push('stale_message');
  if (isWrite && ctx.forwarded) reasons.push('forwarded');
  if (isWrite && ctx.horizonExceeded) reasons.push('far_future');
  if (isWrite && ctx.source === 'voice' && ctx.voiceConfidence === 'uncertain') {
    reasons.push('voice_uncertain');
  }
  if (tier >= 2) reasons.push('tier_requires_confirmation');

  if (reasons.length > 0) {
    // The phone's screen is a confirmation that shows the resolved number, out
    // of band from the channel an injection would arrive on. It answers every
    // escalation above — stale, forwarded, voice — as well as the tier.
    if (spec.confirmation === 'device') {
      return result('CONFIRM', tier, reasons[0]!, reasons, { confirmOnDevice: true });
    }
    return result('CONFIRM', tier, reasons[0]!, reasons, {
      requiresTypedCode: tier >= 3,
    });
  }

  return result('ALLOW', tier, 'allowed', ['allowed'], { undoable: tier === 1 });
}

/**
 * A message is stale if it is older than the window — or if it claims to be
 * from the future, which is either a clock problem or an attempt to look fresh.
 */
function isStale(ctx: PolicyContext): boolean {
  const age = ctx.nowMs - ctx.messageSentAtMs;
  return age > STALE_MESSAGE_MS || age < -60_000;
}

/** Attendees turn a Tier 1 event create into a Tier 3 external-facing action. */
function effectiveTier(tool: ToolName, extras: PolicyExtras): Tier {
  if (tool === 'calendar.create_event' && extras.hasAttendees) return 3;
  return REGISTRY[tool].tier;
}

function result(
  decision: Decision,
  tier: Tier | null,
  reason: PolicyReason,
  allReasons: PolicyReason[],
  flags: { undoable?: boolean; requiresTypedCode?: boolean; confirmOnDevice?: boolean } = {},
): PolicyResult {
  return {
    decision,
    tier,
    reason,
    allReasons,
    undoable: flags.undoable ?? false,
    requiresTypedCode: flags.requiresTypedCode ?? false,
    confirmOnDevice: flags.confirmOnDevice ?? false,
  };
}
