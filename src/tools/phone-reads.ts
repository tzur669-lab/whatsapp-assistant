/**
 * Phone reads: contacts, notifications, SMS (PLAN §6.21).
 *
 * The server cannot read these; the paired phone can. So a phone read never
 * executes here. `resolve` turns the agent's slots into one exact, validated
 * query; policy rules on it like any Tier 0 read; and the agent's turn is then
 * suspended while the phone answers (`src/agent/turns.ts`). `execute` refuses:
 * reaching it would mean a phone read ran on the server.
 *
 * What travels is closed both ways. The query is a kind from a fixed list and
 * bounded words; the answer is a capped list of display fields that the phone
 * has already minimized — contact names only, no numbers, one-time codes
 * dropped — and that this side caps and cleans again before anything reads it.
 * Every answer is text someone else wrote, so it taints the turn.
 */
import { z } from 'zod';
import type { ToolName } from './registry.js';
import type { ExecuteResult, ResolveOutcome, ToolDefinition } from './types.js';
import { ToolInputError } from './types.js';
import {
  MAX_APP_NAME_CHARS,
  MAX_NOTIFICATION_HOURS,
  MAX_QUERY_CHARS,
  MAX_QUERY_VARIANTS,
  MAX_SENDER_CHARS,
  MAX_SMS_HOURS,
  phoneContactsSlots,
  phoneNotificationsSlots,
  phoneSmsSlots,
} from '../nlu/slot-schemas.js';

/** A day: the phone's notification buffer, and enough for "what did I get today". */
const DEFAULT_HOURS = 24;

/** The query the phone receives. Strict, closed, capped. */
export const phoneReadInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('contacts'),
      queries: z.array(z.string().min(1).max(MAX_QUERY_CHARS)).min(1).max(MAX_QUERY_VARIANTS),
    })
    .strict(),
  z
    .object({
      kind: z.literal('notifications'),
      app: z.string().min(1).max(MAX_APP_NAME_CHARS).optional(),
      hours: z.number().int().min(1).max(MAX_NOTIFICATION_HOURS),
    })
    .strict(),
  z
    .object({
      kind: z.literal('sms'),
      sender: z.string().min(1).max(MAX_SENDER_CHARS).optional(),
      hours: z.number().int().min(1).max(MAX_SMS_HOURS),
    })
    .strict(),
]);

export type PhoneReadInput = z.infer<typeof phoneReadInputSchema>;
export type PhoneReadKind = PhoneReadInput['kind'];

export const MAX_PHONE_ITEMS = 20;
export const MAX_ITEM_TEXT_CHARS = 300;
const MAX_NAME_CHARS = 60;
const MAX_ITEM_TITLE_CHARS = 100;

/**
 * One item as the phone sends it. Every field optional and capped; which ones
 * are read depends on the query's kind, and the rest are ignored.
 */
const phoneItemSchema = z
  .object({
    name: z.string().min(1).max(MAX_NAME_CHARS).optional(),
    app: z.string().min(1).max(MAX_APP_NAME_CHARS).optional(),
    sender: z.string().min(1).max(MAX_NAME_CHARS).optional(),
    title: z.string().max(MAX_ITEM_TITLE_CHARS).optional(),
    text: z.string().max(MAX_ITEM_TEXT_CHARS).optional(),
    at: z.number().int().nonnegative().optional(),
  })
  .strict();

/** The phone's answer. `denied`: the permission is not granted on the phone. */
export const phoneReadResultSchema = z
  .object({
    status: z.enum(['ok', 'denied', 'unsupported']),
    items: z.array(phoneItemSchema).max(MAX_PHONE_ITEMS).default([]),
  })
  .strict();

export type PhoneReadResult = z.infer<typeof phoneReadResultSchema>;
export type PhoneItem = z.infer<typeof phoneItemSchema>;

function ready(input: PhoneReadInput): ResolveOutcome {
  const parsed = phoneReadInputSchema.safeParse(input);
  if (!parsed.success) throw new ToolInputError('phone_read');
  return { kind: 'ready', input: parsed.data };
}

function readTool(name: ToolName, resolve: (slots: unknown) => ResolveOutcome): ToolDefinition {
  return {
    name,
    inputSchema: phoneReadInputSchema,
    resolve: (slots) => resolve(slots),
    // A read asks no confirmation, so there is nothing to preview.
    preview: () => '',
    async execute(): Promise<ExecuteResult> {
      throw new ToolInputError(name);
    },
  };
}

export const phoneContacts = readTool('phone.contacts', (raw) => {
  const slots = phoneContactsSlots.parse(raw);
  if (!slots.query_variants) return { kind: 'clarify', clarify: { code: 'phone_missing', what: 'contact' } };
  return ready({ kind: 'contacts', queries: slots.query_variants });
});

export const phoneNotifications = readTool('phone.notifications', (raw) => {
  const slots = phoneNotificationsSlots.parse(raw);
  return ready({
    kind: 'notifications',
    ...(slots.app_name ? { app: slots.app_name } : {}),
    hours: slots.hours ?? DEFAULT_HOURS,
  });
});

export const phoneSms = readTool('phone.sms', (raw) => {
  const slots = phoneSmsSlots.parse(raw);
  return ready({
    kind: 'sms',
    ...(slots.sender ? { sender: slots.sender } : {}),
    hours: slots.hours ?? DEFAULT_HOURS,
  });
});

export const PHONE_READ_TOOLS: Readonly<Partial<Record<ToolName, ToolDefinition>>> = {
  'phone.contacts': phoneContacts,
  'phone.notifications': phoneNotifications,
  'phone.sms': phoneSms,
};
