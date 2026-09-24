/**
 * Channel-neutral inbound/outbound shapes. WhatsApp is the only adapter in v1,
 * but the risk register (PLAN §12) calls for being able to swap it quickly.
 */

export type InboundText = {
  kind: 'text';
  wamid: string;
  from: string;
  sentAtMs: number;
  text: string;
  forwarded: boolean;
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
  /** True for a pressed-and-held voice note, false for an attached audio file. */
  voiceNote: boolean;
  forwarded: boolean;
};

export type InboundButton = {
  kind: 'button';
  wamid: string;
  from: string;
  sentAtMs: number;
  buttonId: string;
  forwarded: boolean;
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
};

export interface ChannelAdapter {
  send(message: OutboundMessage): Promise<{ wamid: string }>;
}
