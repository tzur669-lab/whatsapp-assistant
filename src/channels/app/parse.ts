/**
 * Request bodies on the app channel (PLAN §6.18).
 *
 * Every schema is strict: an unknown field is a refusal, not something to
 * ignore. In particular nothing here has a `from` — who is writing is decided
 * by the signature, never by the body.
 *
 * Bodies arrive as bytes, already size-capped by the Worker. Decoding is fatal
 * on bad UTF-8, so a malformed body cannot become a different string.
 */
import { z } from 'zod';
import { phoneReadResultSchema } from '../../tools/phone-reads.js';
import type { ConversationMode } from '../types.js';
import { MAX_APP_LABEL, MAX_ROUTINE_NAME, MAX_ROUTINES } from '../../tools/routine-store.js';
import { RUN_REASONS } from '../../render/routines.js';
import { MAX_SCREEN_APPS, MAX_SCREEN_LABEL } from '../../tools/screen-store.js';
import { screenSchema, stepReportSchema } from '../../agent/screen-step.js';

/** A client message id: a v4-shaped uuid, lowercase. */
export const MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The inbound cap on text, the same as a typed WhatsApp message would get. */
export const MAX_TEXT_CHARS = 2_000;
export const MAX_ACK_SEQS = 200;
/**
 * Text shared into the app from another one (block F, 2026-10-06). Someone
 * else wrote it: the turn is tainted. Capped for the agent's token budget.
 */
export const MAX_SHARED_CHARS = 1_200;

const messageId = z
  .string()
  .transform((value) => value.toLowerCase())
  .pipe(z.string().regex(MESSAGE_ID));

/** The alphabet `buttonId` in `confirm/pending.ts` produces, and nothing else. */
const buttonIdSchema = z.string().min(1).max(256).regex(/^[a-z0-9:]+$/);

/**
 * The conversation in the app a message was written in (2026-10-01): the
 * agent's memory is kept per conversation. A uuid, like a message id; absent
 * means the one shared thread.
 */
const conversationId = messageId.optional();

/**
 * The conversation's mode (smart conversations), declared by every text
 * message and voice note. The server records the first one and refuses a
 * message that disagrees (422). Absent means local, so an older app works.
 * Never on a button: a button runs in the mode already recorded.
 */
export const CONVERSATION_MODES = ['smart', 'local'] as const satisfies readonly ConversationMode[];
const modeSchema = z.enum(CONVERSATION_MODES);

/**
 * The town the phone's geocoder found for its location (2026-10-01), which the
 * reply names. Letters, spaces and a few marks only: no digits, so never a
 * street number, and nothing a link could be made of.
 */
export const MAX_PLACE_NAME_CHARS = 40;
export const placeNameSchema = z
  .string()
  .min(1)
  .max(MAX_PLACE_NAME_CHARS)
  .regex(/^[\p{L}\p{M}][\p{L}\p{M} '"׳״.-]*$/u);

/**
 * Where the phone is (2026-10-01), when the user allowed it: for the weather
 * and the Hebrew calendar's times in this message only. The app rounds it to
 * two decimals; this side rounds again when it is used.
 */
export const locationSchema = z
  .object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    name: placeNameSchema.optional(),
  })
  .strict();

const messageSchema = z.union([
  z
    .object({
      id: messageId,
      kind: z.literal('text'),
      text: z.string().min(1).max(MAX_TEXT_CHARS),
      shared: z.string().min(1).max(MAX_SHARED_CHARS).optional(),
      conversationId,
      location: locationSchema.optional(),
      mode: modeSchema.optional(),
    })
    .strict()
    // A command is the user's alone: none can carry someone else's text.
    .refine((message) => message.shared === undefined || !message.text.trimStart().startsWith('/')),
  z.object({ id: messageId, kind: z.literal('button'), buttonId: buttonIdSchema, conversationId }).strict(),
]);

export type AppMessage = z.infer<typeof messageSchema>;

const ackSchema = z
  .object({ seqs: z.array(z.number().int().positive()).min(1).max(MAX_ACK_SEQS) })
  .strict();

const pairSchema = z
  .object({
    publicKey: z.string().min(40).max(200).regex(/^[A-Za-z0-9+/]+={0,2}$/),
    pushToken: z.string().min(1).max(4_096),
    timestamp: z.number().int().positive(),
    mac: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type PairRequest = z.infer<typeof pairSchema>;

/**
 * What this build of the app can do. `cards`: runs action cards (§6.20).
 * `device_query`: answers phone reads (§6.21). `file`: saves the file a card
 * carries (2026-10-05). `calls_report`: answers the digest's ask for missed
 * calls (2026-10-06).
 */
export const KNOWN_CAPS = ['cards', 'device_query', 'file', 'calls_report'] as const;
export type Cap = (typeof KNOWN_CAPS)[number];

/**
 * The push address and the caps (PLAN §6.20). A cap this server does not know
 * is dropped, not refused (2026-10-06): a newer app on an older server — or
 * after a rollback — must still get its pushes. Only known caps are kept, so
 * nothing the phone made up is stored; the length caps stay.
 */
const pushTokenSchema = z
  .object({
    pushToken: z.string().min(1).max(4_096),
    caps: z
      .array(z.string().min(1).max(32))
      .max(16)
      .transform((caps) => caps.filter((cap): cap is Cap => (KNOWN_CAPS as readonly string[]).includes(cap)))
      .optional(),
  })
  .strict();

/** The phone's answer to the digest's ask (2026-10-06): names or none, and times. Never a number. */
const callsReportSchema = z
  .object({
    calls: z
      .array(
        z
          .object({
            name: z.string().min(1).max(60).optional(),
            at: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();

/** A tap on a card, or the app running one on its own: claim it, or refuse it. */
const claimSchema = z
  .object({
    actionId: z.string().regex(/^[0-9a-f]{24}$/),
    nonce: z.string().regex(/^[0-9a-f]{32}$/),
    verb: z.enum(['ok', 'no']),
  })
  .strict();

/** What happened on the phone. An outcome, never what was matched. */
const actionReportSchema = z
  .object({
    actionId: z.string().regex(/^[0-9a-f]{24}$/),
    outcome: z.enum(['done', 'failed', 'no_match', 'unsupported']),
  })
  .strict();

/**
 * The phone's answer to a read (§6.21). The query id names the suspended turn;
 * the result is capped and strict, and checked against the turn's own query
 * kind only when the turn is rendered.
 */
const deviceResultSchema = z
  .object({
    queryId: z.string().regex(/^[0-9a-f]{32}$/),
    result: phoneReadResultSchema,
  })
  .strict();

/**
 * A voice note's location, which rides in its signed path because the body is
 * the recording: `@31.77,35.21`, then optionally the town's name as the hex of
 * its UTF-8 (`,d799d7a8...`). Null when absent or off-shape.
 */
export const VOICE_LOCATION = /^@(-?[0-9]{1,2}\.[0-9]{1,2}),(-?[0-9]{1,3}\.[0-9]{1,2})(?:,((?:[0-9a-f]{2}){1,160}))?$/;

export function parseVoiceLocation(segment: string | null): z.infer<typeof locationSchema> | null {
  if (segment === null) return null;
  const match = VOICE_LOCATION.exec(segment);
  if (!match) return null;
  let name: string | undefined;
  if (match[3] !== undefined) {
    const bytes = new Uint8Array(match[3].length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(match[3].slice(i * 2, i * 2 + 2), 16);
    try {
      name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch {
      return null;
    }
  }
  const parsed = locationSchema.safeParse({
    latitude: Number(match[1]),
    longitude: Number(match[2]),
    ...(name === undefined ? {} : { name }),
  });
  return parsed.success ? parsed.data : null;
}

export function parseDeviceResult(body: Uint8Array): z.infer<typeof deviceResultSchema> | null {
  return parseWith(deviceResultSchema, body);
}

export function parseClaim(body: Uint8Array): z.infer<typeof claimSchema> | null {
  return parseWith(claimSchema, body);
}

/**
 * Routines (PLAN §6.27). The sync carries the user's names for them, each
 * routine's id, the target app's label and the SHA-256 of its steps — never a
 * step. The claim and the result name a run by its opaque id; a result is
 * codes only, never what was on the screen.
 */
const routineSyncSchema = z
  .object({
    routines: z
      .array(
        z
          .object({
            id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
            name: z.string().trim().min(1).max(MAX_ROUTINE_NAME),
            appLabel: z.string().trim().min(1).max(MAX_APP_LABEL),
            stepHash: z.string().regex(/^[0-9a-f]{64}$/),
          })
          .strict(),
      )
      .max(MAX_ROUTINES),
  })
  .strict();

const routineClaimSchema = z.object({ runId: z.string().regex(/^[0-9a-f]{32}$/) }).strict();

const routineResultSchema = z
  .object({
    runId: z.string().regex(/^[0-9a-f]{32}$/),
    outcome: z.enum(['verified', 'tapped_unverified', 'failed_before_tap', 'failed_after_tap', 'blocked', 'changed']),
    reason: z.enum(RUN_REASONS).optional(),
  })
  .strict();

export function parseRoutineSync(body: Uint8Array): z.infer<typeof routineSyncSchema> | null {
  return parseWith(routineSyncSchema, body);
}

export function parseRoutineClaim(body: Uint8Array): z.infer<typeof routineClaimSchema> | null {
  return parseWith(routineClaimSchema, body);
}

export function parseRoutineResult(body: Uint8Array): z.infer<typeof routineResultSchema> | null {
  return parseWith(routineResultSchema, body);
}

/**
 * A watch the phone matched (block J, J4, PLAN §6.30): its id and when the
 * phone saw the event. No text of the event: it never leaves the phone.
 */
const watchFiredSchema = z
  .object({
    watchId: z.string().regex(/^[0-9a-f]{32}$/),
    matchedAt: z.number().int().positive(),
  })
  .strict();

export function parseWatchFired(body: Uint8Array): z.infer<typeof watchFiredSchema> | null {
  return parseWith(watchFiredSchema, body);
}

/**
 * The screen agent (PLAN §6.28). The allowlist is package names, the app's own
 * label and the "ask before every tap" switch. A step carries the screen — raw
 * element text, kept in memory for this one request, never stored or logged —
 * and the report on the previous action, as codes. Nothing here carries an
 * input or a text to type: those exist only on the server, sealed.
 */
const SCREEN_ID = /^[0-9a-f]{32}$/;
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;

const screenAllowSchema = z
  .object({
    apps: z
      .array(
        z
          .object({
            package: z.string().max(200).regex(PACKAGE),
            label: z.string().trim().min(1).max(MAX_SCREEN_LABEL),
            askEveryTap: z.boolean(),
          })
          .strict(),
      )
      .max(MAX_SCREEN_APPS),
  })
  .strict();

const screenClaimSchema = z.object({ taskId: z.string().regex(SCREEN_ID) }).strict();

const screenStepSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('screen'),
      taskId: z.string().regex(SCREEN_ID),
      step: z.number().int().min(1).max(64),
      screen: screenSchema,
      report: stepReportSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('poll'), taskId: z.string().regex(SCREEN_ID), step: z.number().int().min(1).max(64) }).strict(),
  z
    .object({
      kind: z.literal('hold'),
      taskId: z.string().regex(SCREEN_ID),
      step: z.number().int().min(1).max(64),
      actionId: z.string().regex(SCREEN_ID),
      cls: z.enum(['uncertain', 'sensitive']),
      why: z.enum(['sensitive', 'ask_every_tap', 'unlabelled', 'generic', 'submit_not_search', 'after_form']),
    })
    .strict(),
]);

const screenApproveSchema = z
  .object({
    taskId: z.string().regex(SCREEN_ID),
    actionId: z.string().regex(SCREEN_ID),
    nonce: z.string().regex(SCREEN_ID),
    verdict: z.enum(['yes', 'no']),
  })
  .strict();

/** The phone's own ends of a task (docs/plans/screen-agent.md, section C). */
export const SCREEN_END_REASONS = [
  'stopped_user',
  'stopped_restart',
  'locked',
  'app_missing',
  'app_not_front',
  'launch_confirm',
  'left_app',
  'service_off',
  'deadline',
  'step_limit',
  'not_allowed',
  'screen_changed',
  'target_ambiguous',
  'uncertain',
  'unreachable',
  'error',
] as const;

const screenResultSchema = z
  .object({
    taskId: z.string().regex(SCREEN_ID),
    reason: z.enum(SCREEN_END_REASONS),
    report: stepReportSchema.optional(),
  })
  .strict();

export function parseScreenAllow(body: Uint8Array): z.infer<typeof screenAllowSchema> | null {
  return parseWith(screenAllowSchema, body);
}

export function parseScreenClaim(body: Uint8Array): z.infer<typeof screenClaimSchema> | null {
  return parseWith(screenClaimSchema, body);
}

export function parseScreenStep(body: Uint8Array): z.infer<typeof screenStepSchema> | null {
  return parseWith(screenStepSchema, body);
}

export function parseScreenApprove(body: Uint8Array): z.infer<typeof screenApproveSchema> | null {
  return parseWith(screenApproveSchema, body);
}

export function parseScreenResult(body: Uint8Array): z.infer<typeof screenResultSchema> | null {
  return parseWith(screenResultSchema, body);
}

export function parseActionReport(body: Uint8Array): z.infer<typeof actionReportSchema> | null {
  return parseWith(actionReportSchema, body);
}

const reportSchema = z
  .object({
    dispatchId: z.string().regex(/^[0-9a-f]{32}$/),
    matched: z.enum(['none', 'one', 'many']),
    outcome: z.enum(['placed', 'cancelled', 'no_match']),
  })
  .strict();

export function parseMessage(body: Uint8Array): AppMessage | null {
  return parseWith(messageSchema, body);
}

export function parseAck(body: Uint8Array): { seqs: number[] } | null {
  return parseWith(ackSchema, body);
}

export function parsePair(body: Uint8Array): PairRequest | null {
  return parseWith(pairSchema, body);
}

export function parsePushToken(body: Uint8Array): z.infer<typeof pushTokenSchema> | null {
  return parseWith(pushTokenSchema, body);
}

export function parseCallsReport(body: Uint8Array): z.infer<typeof callsReportSchema> | null {
  return parseWith(callsReportSchema, body);
}

export function parseReport(body: Uint8Array): z.infer<typeof reportSchema> | null {
  return parseWith(reportSchema, body);
}

function parseWith<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, body: Uint8Array): T | null {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body));
  } catch {
    return null;
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
