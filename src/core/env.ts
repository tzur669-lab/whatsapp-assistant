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
  /**
   * The device companion (PLAN §6.17). Optional: without both, calls answer
   * "not set up" and the device routes refuse everything.
   */
  DEVICE_TOKEN_PEPPER?: string;
  /** The Firebase service account's JSON key, whole. */
  FCM_SA_KEY?: string;

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
}
