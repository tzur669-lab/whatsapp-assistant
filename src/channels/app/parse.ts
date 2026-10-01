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

/** A client message id: a v4-shaped uuid, lowercase. */
export const MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The inbound cap on text, the same as a typed WhatsApp message would get. */
export const MAX_TEXT_CHARS = 2_000;
export const MAX_ACK_SEQS = 200;

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
 * Where the phone is (2026-10-01), when the user allowed it: for the weather
 * and the Hebrew calendar's times in this message only. The app rounds it to
 * two decimals; this side rounds again when it is used.
 */
export const locationSchema = z
  .object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
  })
  .strict();

const messageSchema = z.discriminatedUnion('kind', [
  z
    .object({
      id: messageId,
      kind: z.literal('text'),
      text: z.string().min(1).max(MAX_TEXT_CHARS),
      conversationId,
      location: locationSchema.optional(),
    })
    .strict(),
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
 * The push address, and what this build of the app can do (PLAN §6.20). An
 * unknown capability is a refusal, like any unknown field: the list is closed.
 */
const pushTokenSchema = z
  .object({
    pushToken: z.string().min(1).max(4_096),
    // `cards`: runs action cards (§6.20). `device_query`: answers phone reads (§6.21).
    caps: z.array(z.enum(['cards', 'device_query'])).max(8).optional(),
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
 * the recording: `@31.77,35.21`. Null when absent or off-shape.
 */
export const VOICE_LOCATION = /^@(-?[0-9]{1,2}\.[0-9]{1,2}),(-?[0-9]{1,3}\.[0-9]{1,2})$/;

export function parseVoiceLocation(segment: string | null): z.infer<typeof locationSchema> | null {
  if (segment === null) return null;
  const match = VOICE_LOCATION.exec(segment);
  if (!match) return null;
  const parsed = locationSchema.safeParse({ latitude: Number(match[1]), longitude: Number(match[2]) });
  return parsed.success ? parsed.data : null;
}

export function parseDeviceResult(body: Uint8Array): z.infer<typeof deviceResultSchema> | null {
  return parseWith(deviceResultSchema, body);
}

export function parseClaim(body: Uint8Array): z.infer<typeof claimSchema> | null {
  return parseWith(claimSchema, body);
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
