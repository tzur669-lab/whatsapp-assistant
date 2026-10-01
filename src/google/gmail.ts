/**
 * Gmail (2026-10-01), through the `gmail` grant: search and read, and write
 * drafts. Never send — there is no send scope (`grants.ts`), so a draft waits
 * in Gmail for the user to send it themselves.
 *
 * Addresses stay in this file and in stored inputs: what leaves it for a reply
 * is the sender's display name, the subject, the date and the text, which the
 * agent then scrubs on its way to the model (§6.19).
 */
import type { GoogleApi, GoogleResult } from './api.js';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const MAX_BODY_CHARS = 4_000;

export type MailSummary = {
  id: string;
  threadId: string;
  /** The display name, or the address's local part when there is no name. */
  fromName: string;
  /** For a reply draft only. Never rendered. */
  fromAddress: string | null;
  subject: string;
  /** The RFC 822 Message-ID, for a reply's In-Reply-To. */
  messageId: string | null;
  at: number;
  snippet: string;
  unread: boolean;
};

const header = (headers: unknown, name: string): string | null => {
  if (!Array.isArray(headers)) return null;
  const found = headers.find((h) => typeof h === 'object' && h !== null && String((h as { name?: unknown }).name).toLowerCase() === name.toLowerCase());
  const value = (found as { value?: unknown } | undefined)?.value;
  return typeof value === 'string' ? value : null;
};

/** `"Name" <address>` → the name and the address; a bare address → its local part as the name. */
export function parseFrom(value: string): { name: string; address: string | null } {
  const angle = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(value);
  if (angle) {
    const address = angle[2]!.trim();
    const name = angle[1]!.trim() || address.split('@')[0]!;
    return { name: decodeMimeWords(name), address };
  }
  const bare = value.trim();
  return /@/.test(bare) ? { name: bare.split('@')[0]!, address: bare } : { name: decodeMimeWords(bare), address: null };
}

/** `=?UTF-8?B?...?=` and `=?UTF-8?Q?...?=` in a header, decoded. */
export function decodeMimeWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, _charset: string, encoding: string, text: string) => {
    try {
      if (encoding.toUpperCase() === 'B') return utf8(base64ToBytes(text));
      const bytes = text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (__, hex: string) => String.fromCharCode(parseInt(hex, 16)));
      return utf8(Uint8Array.from(bytes, (c) => c.charCodeAt(0)));
    } catch {
      return text;
    }
  });
}

function base64ToBytes(base64: string): Uint8Array {
  const normal = base64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normal + '='.repeat((4 - (normal.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const utf8 = (bytes: Uint8Array) => new TextDecoder('utf-8').decode(bytes);

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d{1,5});/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** A message's text: its text/plain part, else its HTML with the tags taken out. */
export function bodyOf(payload: unknown): string {
  const parts: Array<{ mime: string; data: string }> = [];
  const walk = (part: unknown, depth: number) => {
    if (typeof part !== 'object' || part === null || depth > 6) return;
    const record = part as { mimeType?: unknown; body?: { data?: unknown }; parts?: unknown };
    if (typeof record.mimeType === 'string' && typeof record.body?.data === 'string') {
      parts.push({ mime: record.mimeType, data: record.body.data });
    }
    if (Array.isArray(record.parts)) for (const child of record.parts) walk(child, depth + 1);
  };
  walk(payload, 0);

  const plain = parts.find((p) => p.mime === 'text/plain');
  const html = parts.find((p) => p.mime === 'text/html');
  try {
    if (plain) return utf8(base64ToBytes(plain.data)).replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_BODY_CHARS);
    if (html) {
      const text = utf8(base64ToBytes(html.data))
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
        .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
        .replace(/<[^>]+>/g, '');
      return decodeEntities(text).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim().slice(0, MAX_BODY_CHARS);
    }
  } catch {
    return '';
  }
  return '';
}

/** A draft as RFC 2822, UTF-8 throughout: headers as encoded words, the body base64. */
export function draftRaw(draft: { to: string | null; subject: string; body: string; inReplyTo: string | null }): string {
  const encodedSubject = `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(draft.subject)))}?=`;
  const bodyBytes = new TextEncoder().encode(draft.body);
  let bodyBase64 = '';
  {
    let binary = '';
    for (const byte of bodyBytes) binary += String.fromCharCode(byte);
    bodyBase64 = btoa(binary).replace(/.{1,76}/g, '$&\r\n');
  }
  const lines = [
    ...(draft.to ? [`To: ${draft.to}`] : []),
    `Subject: ${encodedSubject}`,
    ...(draft.inReplyTo ? [`In-Reply-To: ${draft.inReplyTo}`, `References: ${draft.inReplyTo}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    bodyBase64,
  ];
  return bytesToBase64Url(new TextEncoder().encode(lines.join('\r\n')));
}

export class GmailClient {
  constructor(private readonly api: GoogleApi) {}

  /** Up to `max` messages matching a Gmail query that code built. Newest first. */
  async search(query: string, max: number): Promise<GoogleResult<MailSummary[]>> {
    const list = await this.api.call(`${BASE}/messages?q=${encodeURIComponent(query)}&maxResults=${max}`);
    if (!list.ok) return list;
    const ids = ((list.value as { messages?: unknown }).messages ?? []) as Array<{ id?: unknown }>;
    const out: MailSummary[] = [];
    for (const entry of Array.isArray(ids) ? ids.slice(0, max) : []) {
      if (typeof entry.id !== 'string') continue;
      const message = await this.api.call(
        `${BASE}/messages/${encodeURIComponent(entry.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Message-ID`,
      );
      if (!message.ok) continue;
      const summary = this.summaryOf(message.value);
      if (summary) out.push(summary);
    }
    return { ok: true, value: out };
  }

  /** One message's text, for "what does it say". */
  async body(id: string): Promise<GoogleResult<string>> {
    const message = await this.api.call(`${BASE}/messages/${encodeURIComponent(id)}?format=full`);
    if (!message.ok) return message;
    return { ok: true, value: bodyOf((message.value as { payload?: unknown }).payload) };
  }

  async createDraft(draft: {
    to: string | null;
    subject: string;
    body: string;
    threadId: string | null;
    inReplyTo: string | null;
  }): Promise<GoogleResult<string>> {
    const result = await this.api.call(`${BASE}/drafts`, {
      method: 'POST',
      body: JSON.stringify({
        message: { raw: draftRaw(draft), ...(draft.threadId ? { threadId: draft.threadId } : {}) },
      }),
    });
    if (!result.ok) return result;
    const id = (result.value as { id?: unknown }).id;
    return typeof id === 'string' ? { ok: true, value: id } : { ok: false, error: { code: 'invalid_response' } };
  }

  private summaryOf(raw: unknown): MailSummary | null {
    const record = raw as {
      id?: unknown;
      threadId?: unknown;
      internalDate?: unknown;
      snippet?: unknown;
      labelIds?: unknown;
      payload?: { headers?: unknown };
    };
    if (typeof record.id !== 'string' || typeof record.threadId !== 'string') return null;
    const from = parseFrom(header(record.payload?.headers, 'From') ?? '');
    const at = Number(record.internalDate);
    return {
      id: record.id,
      threadId: record.threadId,
      fromName: from.name.slice(0, 80) || '—',
      fromAddress: from.address,
      subject: decodeMimeWords(header(record.payload?.headers, 'Subject') ?? '').slice(0, 200) || '(ללא נושא)',
      messageId: header(record.payload?.headers, 'Message-ID'),
      at: Number.isFinite(at) ? at : 0,
      snippet: decodeEntities(typeof record.snippet === 'string' ? record.snippet : '').slice(0, 300),
      unread: Array.isArray(record.labelIds) && record.labelIds.includes('UNREAD'),
    };
  }
}
