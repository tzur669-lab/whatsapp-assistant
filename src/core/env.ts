/**
 * The env contract. Secrets arrive as bindings only (PLAN §7.2) and are never
 * read from files. Nothing here is logged.
 */
export type ChannelMode = 'whatsapp' | 'app' | 'off';

/** Anything but the two other known values is WhatsApp, the historic default. */
export function channelOf(env: { CHANNEL?: string | undefined }): ChannelMode {
  const value = (env.CHANNEL ?? '').trim().toLowerCase();
  return value === 'app' || value === 'off' ? value : 'whatsapp';
}

export interface AppEnv {
  ENVIRONMENT: string;

  // Secrets
  WA_APP_SECRET: string;
  WA_VERIFY_TOKEN: string;
  WA_ACCESS_TOKEN: string;
  ALLOWLIST_WA_IDS: string;
  GROQ_API_KEY: string;
  GOOGLE_CLIENT_SECRET: string;
  TOKEN_ENC_KEY_V1: string;
  LOG_HASH_KEY: string;
  /**
   * The device companion (PLAN §6.17). Optional: without both, calls answer
   * "not set up" and the device routes refuse everything.
   */
  DEVICE_TOKEN_PEPPER?: string;
  /** The Firebase service account's JSON key, whole. */
  FCM_SA_KEY?: string;
  /**
   * The bootstrap pairing code (§6.18): 20 Crockford characters, typed into the
   * app by hand and never sent. Each value works once; a new one re-arms it.
   */
  PAIR_BOOTSTRAP_CODE?: string;
  /**
   * Finnhub's free key, for US stock quotes (PLAN §6.24). Optional: without it
   * a US quote answers "unavailable"; TASE needs no key.
   */
  QUOTES_API_KEY?: string;
  /**
   * Google AI Studio's key, for the smart conversations' Gemini model
   * (2026-10-08). Optional and server-side only: never sent to the app, never in
   * a reply, never logged. Without it (or without `GROQ_API_KEY`) no smart
   * provider is built.
   */
  GEMINI_API_KEY?: string;

  // Vars
  WA_PHONE_NUMBER_ID: string;
  GOOGLE_CLIENT_ID: string;
  /**
   * The Worker's own public origin, e.g. `https://wa-assistant-staging.workers.dev`.
   * The OAuth redirect URI is derived from it and must match the one registered
   * with Google exactly (PLAN §6.6).
   */
  PUBLIC_BASE_URL: string;
  /** Overrides the service account's own project id. Usually left empty. */
  FCM_PROJECT_ID?: string;
  /**
   * Which channel the assistant speaks on (§6.18): `whatsapp` (the default,
   * and what an unset value means), `app`, or `off` — the kill switch, where
   * every channel route answers 404 and nothing is delivered.
   *
   * With `app`, the WhatsApp secrets may be empty, but `ALLOWLIST_WA_IDS` must
   * stay set and unchanged: the principal every record belongs to is derived
   * from its first entry.
   */
  CHANNEL?: string;
  /**
   * `on` turns on the tool-calling agent (PLAN §6.19); anything else keeps the
   * single-shot parser. Off until Groq Zero Data Retention is confirmed on,
   * because the agent sends calendar titles and conversation history.
   */
  AGENT?: string;
}

export function agentEnabled(env: { AGENT?: string | undefined }): boolean {
  return (env.AGENT ?? '').trim().toLowerCase() === 'on';
}
