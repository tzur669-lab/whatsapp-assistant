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
};

export type InboundEvent = InboundText | InboundButton | InboundUnsupported | InboundStatus;

export type OutboundButton = { id: string; title: string };

export type OutboundMessage = {
  to: string;
  text: string;
  buttons?: OutboundButton[];
};

export interface ChannelAdapter {
  send(message: OutboundMessage): Promise<{ wamid: string }>;
}
