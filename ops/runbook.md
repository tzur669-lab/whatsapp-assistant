# Runbook

Operational procedures for the WhatsApp assistant. Fill in as phases land.

## Phase 1 — what exists today

- Worker routes: `GET /health`, `GET /wa/webhook` (handshake), `POST /wa/webhook`.
- One Durable Object (`AssistantDO`, name `singleton`) holding the SQLite schema.
- Daily cron at 03:30 UTC purges inbound records older than 30 days.

## Deploying to staging

```
pnpm typecheck && pnpm lint && pnpm test
pnpm deploy:staging
```

Production deploys are manual and human-only (PLAN §9).

## Required secrets (staging and production set separately)

See PLAN §7.2. Set with:

```
wrangler secret put <NAME> --env <staging|production>
```

`WA_APP_SECRET`, `WA_VERIFY_TOKEN`, `WA_ACCESS_TOKEN`, `ALLOWLIST_WA_IDS`,
`GROQ_API_KEY`, `GOOGLE_CLIENT_SECRET`, `TOKEN_ENC_KEY_V1`, `LOG_HASH_KEY`.

Vars (`WA_PHONE_NUMBER_ID`, `GOOGLE_CLIENT_ID`) go in `wrangler.jsonc`.

## Webhook not delivering

1. `GET /health` returns `ok`?
2. Meta app dashboard → Webhooks → is `messages` still subscribed?
3. Logs: look for `signature_rejected` (wrong `WA_APP_SECRET`) or
   `sender_dropped` (number missing from `ALLOWLIST_WA_IDS`).
4. Meta retries for ~24h, so a fixed secret usually backfills on its own.

## Rolling back

```
wrangler rollback --env production   # human only
```

Migrations must stay backward-compatible for one version (PLAN §9).
