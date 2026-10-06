# Architecture

How the code is laid out and how the parts talk. The *why* behind each piece
is in `PLAN.md` (section numbers given); the rules are in `CLAUDE.md`.
Current as of 2026-10-06 (migration 0019).

## 1. System diagram

```
            Android app (apps/call-companion, Kotlin)
              │  every request ECDSA-signed (Keystore key)       ▲ FCM push: opaque id only
              ▼                                                  │
 ┌─ Worker: src/index.ts (stateless, Hono) ─────────────────────────────────┐
 │  /app/*, /device/*  → route + byte-counted size cap → forward bytes      │
 │  /wa/webhook        → HMAC → parse → allowlist (frozen, CHANNEL=whatsapp)│
 │  /oauth/google/*    → one-time link / callback                           │
 │  scheduled()        → daily 03:30 UTC cleanup · hourly digest check      │
 └───────────────┬──────────────────────────────────────────────────────────┘
                 ▼
 ┌─ AssistantDO: src/platform/assistant-do.ts (ONE instance, SQLite) ───────┐
 │  verify signature → device active + nonce spent (one transaction) → Zod  │
 │  → dedupe → pipeline (src/core/pipeline.ts)                              │
 │     dedupe · stale check · (transcribe voice) · /commands · buttons &     │
 │     "כן" confirmations · open question answer · agent or parser · act    │
 │  alarm(): due reminders, scheduled reads · outbox re-push                │
 └──┬──────────────┬──────────────┬───────────────┬─────────────────────────┘
    ▼              ▼              ▼               ▼
  Groq          Google APIs     Public lookups   FCM (push to phone)
  (agent,       (Calendar,      (Open-Meteo,
  parser,       Tasks, Gmail,   Hebcal, BoI,
  Whisper)      Drive)          ynet RSS, Wikipedia)
```

## 2. One message, step by step

1. **Ingress** — Worker checks route/channel/size and forwards the raw bytes.
   The DO verifies the ECDSA signature, then in one synchronous transaction
   checks the device and spends the nonce, then strict Zod, then dedupe
   (`recordInbound`). Order is fixed (CLAUDE.md inv. 9). WhatsApp path: HMAC
   first instead.
2. **Deterministic first** (`core/router.ts`, `confirm/`) — slash commands,
   button replies, "כן" to a pending confirmation, an answer to an open
   question. No LLM. Confirmations execute the *stored* input (inv. 7).
3. **Agent** (`agent/loop.ts`, when `AGENT=on`) — per-sender lock
   (`lock.ts`), encrypted short history (`history.ts`), code picks a tool
   group (`tool-groups.ts`), budget reserves tokens before each call
   (`budget.ts`, `models.ts`). Each tool call → `orchestrator` path below.
   Only Tier 0 reads return to the model; any other outcome ends the turn.
4. **Fallback parser** (`nlu/`) — one `IntentDraft` under strict structured
   output; models then `rules-fallback.ts`. If it finds no tool, the backup
   model may answer **read-only**.
5. **Orchestrator** (`core/orchestrator.ts`) — `resolve` (tool + `time/`)
   → `policy/engine.ts` decides ALLOW / CLARIFY / CONFIRM / DENY → Tier 0–1
   run now (Tier 1 gets an Undo, `confirm/undo.ts`), Tier 2–3 become a
   pending row (`confirm/pending.ts`).
6. **Reply** — rendered by `render/*` (Hebrew in `he.ts`, bidi isolates in
   `bidi.ts`), defanged, written to the outbox and returned in the response.

Special shapes:
- **Phone reads** (contacts, notifications, SMS): the turn is suspended,
  encrypted, in `agent_turns` (`agent/turns.ts`); the phone's signed
  `/app/device-result` resumes it once.
- **Action cards** (alarm, timer, nav, app, media, settings, compose, file
  export): a pending row with `channel='card'`; the app claims it once
  (`/app/action/claim`) and runs it on the phone.
- **Calls**: `device/calls.ts` writes a 2-minute dispatch, FCM pushes its id,
  the phone fetches, matches the contact locally, and dials after a tap.

## 3. Modules (`src/`)

| Folder | Responsibility | PLAN |
|---|---|---|
| `index.ts` | Worker routes, cron entry, forward to DO | §3.2, §6.18 |
| `platform/` | **Only** Cloudflare code: the DO, SQL adapter, inlined migrations | §3.3–3.4 |
| `channels/app/` | App ingress checks, request schemas, signature/pairing verify, outbox | §6.18 |
| `channels/whatsapp/` | Frozen channel: HMAC verify, parse, send, media/voice download | §6.1 |
| `core/` | `pipeline` (inbound order), `router` (commands), `orchestrator` (resolve→policy→act), `repo`/`sql` (data access), `digest`, `birthdays`, `scheduled-read`, `quota`, `timing`, `env` | §6.4, §6.12 |
| `agent/` | Bounded tool loop, prompt (a8), compact catalog, tool groups, model table, token budget, history, lock, suspended turns | §6.19 |
| `nlu/` | Fallback parser: prompt (v6), `IntentDraft` schema, slot schemas, Groq provider, rules fallback, weekday check, clarification answers | §6.2, §6.11 |
| `tools/` | `registry.ts` (single source of truth: name, tier, slots, scopes, flags) + one file per area; `*-store.ts` hold SQL; `match.ts` finds targets | §6.4 |
| `policy/` | Pure tier decision; WhatsApp 24 h window/budget | §6.4 |
| `confirm/` | Pending confirmations, Undo offers, open questions | §6.5, §6.11 |
| `time/` | `resolve` (R1–R12), `tz`, Hebrew lexicon, ranges, recurrence, past days, sunset, Shabbat/chag | §6.3, §6.13 |
| `google/` | OAuth (PKCE), per-area grants with encrypted refresh tokens, Calendar/Tasks/Gmail/Drive clients | §6.6 |
| `ical/` | Subscribed calendar feeds: URL guard, fetch, parse, cache, merge | §6.15 |
| `lookup/` | Public keyless data for `info.lookup` + calculator grammar | §6.4 |
| `device/` | Paired-phone state, FCM v1 (no SDK), call dispatch | §6.17 |
| `voice/` | Whisper transcription + confidence gate | §6.10 |
| `security/` | AES-GCM crypto, HMAC, redacting logger, `scrubForModel`/defang, allowlist | §7 |
| `render/` | Every user-facing string (Hebrew/English templates, time format, bidi) | §6.3 |

**Tools by tier** (from `tools/registry.ts`; parser sees only the first 8 marked *):
- Tier 0 (read): `reminders.list`*, `calendar.list_events`*, `calendar.free_time`, `phone.contacts|notifications|sms`, `info.lookup`, `tasks.list`, `mail.search`, `drive.search`, `notes.find`, `expenses.summary`, `calc.compute`
- Tier 1 (runs now; Undo where reversible; cards run on the phone): `reminders.create`*, `reminders.repeat|at_rest|scheduled_read`, `calendar.create_event`* (Tier 3 with attendees), `tasks.add|complete`, `notes.save`, `expenses.add|export`, cards `alarm.set`, `timer.set`, `nav.go`, `app.open`, `media.play`, `settings.set`
- Tier 2 (confirm): `reminders.cancel`*, `reminders.move`, `calendar.move_event`*, `calendar.delete_event`*, `mail.draft`, `notes.delete`
- Tier 3 (confirm on phone): `calls.place`*, `message.compose`

## 4. Storage

One SQLite DB inside the DO. Schema = `migrations/0001…0019` (registered in
`platform/migrations.ts`). Tables by area:

| Area | Tables |
|---|---|
| Messages & audit | `inbound_messages`, `outbound_messages`, `audit_log`, `counters`, `window_state`, `settings` |
| Confirm / Undo / questions | `pending_actions` (also cards), `undo_actions`, `open_questions` |
| Reminders | `reminders`, `reminder_series` |
| Google | `integrations` (encrypted refresh tokens per grant), `oauth_links`, `oauth_states` |
| App & phone | `devices`, `device_pairings`, `app_outbox`, `app_nonces`, `call_dispatches` |
| Agent | `conversation_turns` (encrypted history), `agent_turns` (suspended), `agent_lock` |
| Quota | `groq_limits`, `groq_token_spend`, `worker_requests` |
| Data | `ical_feeds`, `ical_events`, `birthdays`, `notes`, `expenses` |

Access goes through `core/sql.ts` (`SqlDriver`) so tests run
the same code on Node SQLite (`test/integration/sqlite-driver.ts`).

## 5. Coupled vs. isolated

**Intentionally isolated**
- Cloudflare ↔ everything else (`platform/` only; Plan B is Node + SQLite).
- Model ↔ data: the model never sees ids, numbers, addresses, tokens, notes;
  reads are scrubbed; ids are found by `tools/match.ts` from `query_variants`.
- Parser catalog ↔ agent catalog (`PARSER_TOOL_NAMES`): new tools don't touch
  the parser or `pnpm eval`.
- Each Google area is its own grant and token.
- Rendering ↔ logic: `resolve`/policy return codes; `render/` makes words.

**Coupled on purpose (change together)**
- `tools/registry.ts` ↔ `agent/tool-groups.ts` ↔ `test/evals/fingerprint.ts` ↔ `models.ts` evaluated fingerprint.
- `channels/app/parse.ts` + `verify.ts` ↔ app's `Protocol.kt` (shared test vectors).
- `migrations/*.sql` ↔ `platform/migrations.ts`.
- `nlu/slot-schemas.ts` `DateSpec`/`TimeSpec` ↔ `time/resolve.ts` types.
- Agent prompt version ↔ eval recordings.

## 6. Tests (`test/`)

`unit/` (mirrors `src/`), `integration/` (fakes: Groq, NLU, agent, phone,
DO state, logger; Workers-strict `fetch`; Node SQLite driver), `security/` (ingress, log canaries, ban-list,
secret scan), `evals/` (YAML corpora `cases.he|en|phone.yaml`, runners for
parser, agent and turn evals; recordings are git-ignored). Clocks are frozen;
no network in unit tests.
