/**
 * Outbound WhatsApp sends. One command produces at most one message
 * (CLAUDE.md invariant 10), so there is no batching here by design.
 */
import type { ChannelAdapter, OutboundMessage } from '../types.js';
import { classifyMetaError, metaErrorCode } from './errors.js';
import type { WaFailure } from './errors.js';

const GRAPH_VERSION = 'v21.0';
const MAX_BUTTONS = 3;
const SEND_TIMEOUT_MS = 8_000;

export type WhatsAppSenderConfig = {
  phoneNumberId: string;
  accessToken: string;
  /** Injected so tests can supply a fake Meta without touching the network. */
  fetchImpl?: typeof fetch;
};

export class WhatsAppSender implements ChannelAdapter {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: WhatsAppSenderConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async send(message: OutboundMessage): Promise<{ wamid: string }> {
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${this.config.phoneNumberId}/messages`;
    const body = buildSendBody(message);

    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    if (!response.ok) {
      // The body may echo the message that failed, so exactly one field is read
      // from it — the numeric code — and the rest is discarded unread. That one
      // number is the difference between a retry that will work and four that
      // spend the monthly budget to learn nothing (§6.8).
      const code = metaErrorCode(await response.json().catch(() => null));
      throw new SendError(response.status, 'send_failed', code);
    }

    const json = (await response.json()) as { messages?: { id?: string }[] };
    const wamid = json.messages?.[0]?.id;
    if (!wamid) throw new SendError(response.status, 'missing_wamid');
    return { wamid };
  }
}

export class SendError extends Error {
  readonly failure: WaFailure;

  constructor(
    readonly status: number,
    readonly detail = 'send_failed',
    /** Meta's numeric code, when the body carried one. Never its text. */
    readonly metaCode: number | null = null,
  ) {
    const failure = classifyMetaError(metaCode, status || null);
    super(failure.errorCode);
    this.name = 'SendError';
    this.failure = failure;
  }
}

export function buildSendBody(message: OutboundMessage): Record<string, unknown> {
  const buttons = message.buttons ?? [];
  if (buttons.length === 0) {
    return {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: message.to,
      type: 'text',
      text: { body: message.text, preview_url: false },
    };
  }

  if (buttons.length > MAX_BUTTONS) {
    throw new SendError(0, 'too_many_buttons');
  }

  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: message.to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: message.text },
      action: {
        buttons: buttons.map((b) => ({
          type: 'reply',
          reply: { id: b.id, title: b.title },
        })),
      },
    },
  };
}
