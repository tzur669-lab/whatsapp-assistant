# Runbook

Operational procedures for the WhatsApp assistant. See `PLAN.md` for why any of
it is the way it is; this file is only what to do.

## What exists today

**Worker routes**

| Route | Purpose |
|---|---|
| `GET /health` | Public liveness. Returns `ok` and nothing about state. |
| `GET /wa/webhook` | Meta's subscription handshake. |
| `POST /wa/webhook` | Inbound messages. HMAC first, then parse, then allowlist. |
| `GET /oauth/google/start?id=…` | Redeems a one-time connect link, redirects to Google. |
| `GET /oauth/google/callback` | Exchanges the code and stores the grant. |
| `POST /device/pair` | The phone app trades a `/pair` code for its device token. |
| `GET /device/dispatch/:id` | The app fetches a call request after the push wakes it. Device token only. |
| `POST /device/report` | The app reports how a call ended: a count and an outcome, never a name or number. |
| `POST /device/push-token` | The app sends its rotated FCM address. |

**Durable Object** — one instance, `AssistantDO` named `singleton`. It holds the
SQLite schema, the reminder alarm, and every confirmation gate.

**Scheduled work**

- Daily cron at 03:30 UTC: purges inbound and outbound records over 30 days old,
  expires unanswered confirmations, undos, snooze offers and open questions,
  clears spent OAuth rows, and re-arms the alarm.
- Hourly cron: asks whether this is the digest hour locally (PLAN §6.12). The
  schedule is deliberately dumb — the hour is a setting, and the Durable Object
  is what decides.
- The alarm itself fires per reminder, not on a schedule.

**Chat commands** — `/help`, `/status`, `/digest`, `/shabbat`, `/ical`,
`/birthday`, `/pause`, `/resume`, `/budget`, `/connect google`, `/pair`,
`/pair off`, `/ping`.

## Deploying to staging

```
pnpm typecheck && pnpm lint && pnpm test
pnpm deploy:staging
```

Production deploys are manual and human-only (PLAN §9).

## Required configuration

Secrets: see PLAN §7.2, set with `wrangler secret put <NAME> --env <env>`.

For **staging**, `scripts/set-staging-secrets.ps1` does it in one pass: it
generates the internal keys (`TOKEN_ENC_KEY_V1`, `LOG_HASH_KEY`,
`DEVICE_TOKEN_PEPPER`, `WA_VERIFY_TOKEN`) from a CSPRNG — first run only — and
asks for the external ones with hidden input. It is fixed to staging and writes
nothing to disk. Run it yourself; Claude Code never sets secrets.

    powershell -ExecutionPolicy Bypass -File scripts\set-staging-secrets.ps1

Staging lives at `https://wa-assistant-staging.moneytime-pro-api.workers.dev`.

Vars in `wrangler.jsonc` per environment:

| Var | Value |
|---|---|
| `WA_PHONE_NUMBER_ID` | From the Meta app's WhatsApp product page. |
| `GOOGLE_CLIENT_ID` | From Google Cloud → Credentials. |
| `PUBLIC_BASE_URL` | The Worker's own origin, no trailing slash. |

`PUBLIC_BASE_URL` has to match the redirect URI registered with Google
**exactly**, including scheme and host. `<PUBLIC_BASE_URL>/oauth/google/callback`
is what the callback is built from, and Google compares it character by
character. A mismatch shows up as `redirect_uri_mismatch` on the consent screen.

## Connecting Google

1. Send `/connect google` from an allowlisted number.
2. Open the link within 10 minutes. It works once.
3. Grant both calendar scopes.
4. The bot sends a confirmation; `/status` then shows the calendar as connected.

If the link is spent or expired, ask for a new one — the page will not say which
of the two it was, on purpose.

## Diagnosing

**`/status` first.** It reports the integration state, pending reminders,
messages used this month, NLU fallbacks today, the last error code, and — only
when they are in use — the digest hour, the Shabbat hold, a subscribed feed and
any undelivered messages. Features that are off stay off the report, so the
lines that are there are the ones worth reading.

| Symptom | Likely cause | Check |
|---|---|---|
| No replies at all | Webhook signature or allowlist | Logs for `signature_rejected`, `sender_dropped` |
| Replies, no reminders arriving | 24h window shut, or budget spent | `/budget`; logs for `delivery_deferred` |
| "לא הבנתי" on everything | NLU quota exhausted | `/status` fallback count; logs for `nlu_exhausted` |
| Calendar says not connected | Grant revoked or lapsed | Logs for `google_disconnected`; re-run `/connect google` |
| Reminder arrived twice | Should be impossible | Check `reminders.status` and `lease_until`; this is a bug, not an operation |
| Reminder said sent, never arrived | Meta accepted it and then failed | `/status` undelivered count; `outbound_messages.error_code` for the wamid |
| No digest | Off, wrong hour, or the window was shut | `/digest` reports the setting; logs for `digest_skipped` |
| Nothing arrives on Shabbat | Working as asked | `/shabbat` reports it; logs for `delivery_deferred` with `rest_period` |
| Subscribed calendar is stale | The refresh is failing | `/ical` reports the last error code; logs for `ical_fetch_failed` |

Every log line carries a stable `errorCode`. None of them carries message
content, a phone number, a transcript, or a token — if you need to correlate a
line with a message, use the `wamid`.

## When something is wrong and you want it to stop

`/pause` denies every write immediately and survives a redeploy. Reminders
already scheduled still fire; nothing new is created, moved or deleted.
`/resume` undoes it.

To stop everything including deliveries, clear `ALLOWLIST_WA_IDS` — inbound
messages are then dropped before any parsing, and see `ops/revoke-tokens.md`.

## Budget

1,000 free service messages per number per month, with no payment method on the
account, which is the deliberate cost cap (PLAN §5). At 800 the next reply
carries a warning. At 1,000, delivery stops: reminders route to a Google
Calendar popup instead, and `/budget` says so. The counter resets on the first
of the month in `Asia/Jerusalem`, not UTC.

## Migrations

`migrations/*.sql` is the reviewed source of truth; `src/platform/migrations.ts`
inlines them as text modules because a Worker bundle has no filesystem. Both
have to be updated together, and the numbering has to match.

Migrations must stay backward-compatible for one version, so a rollback does not
strand the schema.
