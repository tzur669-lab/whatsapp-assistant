/**
 * The env contract. Secrets arrive as bindings only (PLAN §7.2) and are never
 * read from files. Nothing here is logged.
 */
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

  // Vars
  WA_PHONE_NUMBER_ID: string;
  GOOGLE_CLIENT_ID: string;
  /**
   * The Worker's own public origin, e.g. `https://wa-assistant-staging.workers.dev`.
   * The OAuth redirect URI is derived from it and must match the one registered
   * with Google exactly (PLAN §6.6).
   */
  PUBLIC_BASE_URL: string;
}
