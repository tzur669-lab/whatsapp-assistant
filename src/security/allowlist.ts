/**
 * Sender allowlist. Checked only after the HMAC passes, and it fails closed:
 * an empty or unparseable list allows nobody (PLAN §7.1).
 *
 * The numbers themselves live in the `ALLOWLIST_WA_IDS` secret, never in code.
 */

const MIN_DIGITS = 8;
const MAX_DIGITS = 15; // E.164 maximum.

/** Reduce a WhatsApp id to bare digits, or null if it cannot be one. */
export function normalizeWaId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) return null;
  return digits;
}

/** Parse the comma-separated `ALLOWLIST_WA_IDS` value. Malformed entries are dropped. */
export function parseAllowlist(configured: string | null | undefined): string[] {
  if (!configured) return [];
  const out: string[] = [];
  for (const part of configured.split(',')) {
    const id = normalizeWaId(part);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

export function isAllowed(waId: string | null | undefined, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return false;
  const id = normalizeWaId(waId);
  if (!id) return false;
  return allowlist.includes(id);
}
