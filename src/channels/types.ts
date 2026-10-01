/**
 * Channel-neutral inbound/outbound shapes. WhatsApp is the only adapter in v1,
 * but the risk register (PLAN §12) calls for being able to swap it quickly.
 */

/**
 * Where the phone is, as the app sends it with a message (2026-10-01): two
 * decimals, about a kilometre. For this one message only — never stored,
 * never logged, never shown to the model.
 */
export type DeviceLocation = { latitude: number; longitude: number };

export type InboundText = {
  kind: 'text';
  wamid: string;
  from: string;
  sentAtMs: number;
  text: string;
  forwarded: boolean;
  /** The app's conversation this was written in (§6.18). Absent: the one shared thread. */
  conversationId?: string;
  /** The phone's location when this was sent, when the user allowed it. */
  location?: DeviceLocation;
};

/**
 * A recorded voice note, or an attached audio file. The webhook carries only a
 * media id — the audio itself is fetched separately, authenticated, and never
 * stored (PLAN §6.1, §6.10).
 */
export type InboundAudio = {
  kind: 'audio';
  wamid: string;
  from: string;
  sentAtMs: number;
  mediaId: string;
  mimeType: string;
  /**
   * The recording itself, when the channel delivers it in the request (the
   * app, §6.18) rather than as a media id to fetch. In memory only — never
   * stored, never logged.
   */
  bytes?: Uint8Array;
  /** True for a pressed-and-held voice note, false for an attached audio file. */
  voiceNote: boolean;
  forwarded: boolean;
  conversationId?: string;
  location?: DeviceLocation;
};

export type InboundButton = {
  kind: 'button';
  wamid: string;
  from: string;
  sentAtMs: number;
  buttonId: string;
  forwarded: boolean;
  conversationId?: string;
};

export type InboundUnsupported = {
  kind: 'unsupported';
  wamid: string;
  from: string;
  sentAtMs: number;
  messageType: string;
  forwarded: boolean;
};

export type InboundStatus = {
  kind: 'status';
  wamid: string;
  status: string;
  sentAtMs: number;
  recipient: string;
  /**
   * Meta's numeric code on a `failed` status. Only the number is carried: the
   * rest of the error object echoes the message that failed (§6.8).
   */
  errorCode?: number;
  /** `service` | `utility` | … — what the message was billed as, if stated. */
  pricingCategory?: string;
};

export type InboundEvent =
  | InboundText
  | InboundAudio
  | InboundButton
  | InboundUnsupported
  | InboundStatus;

export type OutboundButton = { id: string; title: string };

export type OutboundMessage = {
  to: string;
  text: string;
  buttons?: OutboundButton[];
  /**
   * The one-time connect link is the only link that must stay clickable.
   * Everything else is defanged where it leaves (PLAN §6.19).
   */
  keepLinks?: true;
};

export interface ChannelAdapter {
  send(message: OutboundMessage): Promise<{ wamid: string }>;
}
