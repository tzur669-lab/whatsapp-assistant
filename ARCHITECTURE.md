# Architecture

How the code is laid out and how the parts talk. The *why* behind each piece
is in `PLAN.md` (section numbers given); the rules are in `CLAUDE.md`.
Current as of 2026-10-08 (migration 0027).

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
  Gemini (smart conversations only, OpenAI-compatible endpoint)
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
   (`budget.ts`, `models.ts`). Each tool call → `fillUnstatedTime`
   (`tools.ts`: a TimeSpec's missing `meridiem`/`part_of_day` → 'unspecified'
   only where it cannot move the time) → strict Zod → `orchestrator` path below.
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
- **Smart conversations** (2026-10-08, PLAN §6.19): the conversation's mode
  (`smart` | `local`) is recorded once inside `recordInbound`'s transaction
  (`conversation_modes`); a later message declaring the other mode gets 422
  `mode_mismatch`. A smart conversation's own words go to
  `[...smartProviders, ...providers]` (Gemini first, then qwen), the model is
  chosen before the tools (a smart model gets every offered tool, no
  selection, `SMART_NOTE`, its own caps, no facts). Shared text and the
  read-only try stay local. A call to a tool whose `dataSource` is a consent
  source not yet allowed suspends the turn (`agent_turns.kind = 'consent'`)
  with a card (`render/consent.ts`); the tap is handled in code
  (`beginConsent`, `resumeAfterConsent`), and "this conversation" writes
  `conversation_consents`. `settleAgentResult` is the history gate: a reply
  after a source not allowed is stored as a placeholder. `/consents` lists and
  revokes. `GET /app/outbox` carries `smart` (agent on and both keys set).
- **Phone reads** (contacts, notifications, SMS, call log): the turn is suspended,
  encrypted, in `agent_turns` (`agent/turns.ts`); the phone's signed
  `/app/device-result` resumes it once.
- **Missed calls for the digest** (2026-10-06): at the digest hour an empty
  FCM push (`calls_report`) asks the phone; its signed `/app/calls-report`
  lands in `missed_calls` (`core/missed-calls.ts`) for at most the digest's
  20-second wait, and is deleted right after the digest is built.
- **Action cards** (alarm, timer, nav, app, media, settings, compose, file
  export): a pending row with `channel='card'`; the app claims it once
  (`/app/action/claim`) and runs it on the phone.
- **Calls**: `device/calls.ts` writes a 2-minute dispatch, FCM pushes its id,
  the phone fetches, matches the contact locally, and dials after a tap.
- **"Time to leave" reminders** (`reminders.leave`, ROADMAP #5, 2026-10-06):
  `resolveAsync` finds a timed calendar event (by title words, or the next
  one) and sets the reminder's due time to its start minus a travel time (the
  user's, else 30 min). The event's title is stored as the reminder text and
  its location as `reminders.place`, so delivery (`assistant-do.ts`) attaches
  a Waze nav card. A calendar title is someone else's words, so the turn and
  `reminders.list` (when any shown reminder has a place) are tainted.
- **Text shared into the app** (`channels/app/shared.ts`, ROADMAP #17,
  2026-10-06): an OS share composes the user's own text with the shared text
  under a header (`composeShared`), marks the inbound event `forwarded`, and
  skips every deterministic shortcut in `pipeline.ts` (commands, plain "כן",
  the open question) — those are the user's alone, never someone else's text.
  `forwarded` also sets `TurnContext.tainted`, and a parser-path reply to it
  is `private`. In the app (0.11) the share lands in `ChatActivity`
  (`ACTION_SEND`, text only) and waits above the field for the user's request.
- **The app as the default assistant and the widget** (0.11, ROADMAP #19,
  #22): `ChatActivity` also answers `ACTION_ASSIST`; it and the widget's 🎤
  button arm a tap-to-talk mode, but nothing records before the user's tap
  (the activity is exported). `AssistantWidget` shows the newest reminder,
  kept in its own preferences by `Sync` (`WidgetLogic`; a private row shows
  no text).

## 3. Modules (`src/`)

| Folder | Responsibility | PLAN |
|---|---|---|
| `index.ts` | Worker routes, cron entry, forward to DO | §3.2, §6.18 |
| `platform/` | **Only** Cloudflare code: the DO, SQL adapter, inlined migrations | §3.3–3.4 |
| `channels/app/` | App ingress checks, request schemas, signature/pairing verify, outbox | §6.18 |
| `channels/whatsapp/` | Frozen channel: HMAC verify, parse, send, media/voice download | §6.1 |
| `core/` | `pipeline` (inbound order; `settleAgentResult` is the history gate), `router` (commands), `orchestrator` (resolve→policy→act), `repo`/`sql` (data access; conversation modes), `exchanges` ("לא הבנת" capture, never given to the agent), `digest`, `birthdays`, `missed-calls`, `scheduled-read`, `quota` (also `SqlDayRequestCounter`: requests per model per Pacific day), `timing`, `env` | §6.4, §6.12 |
| `agent/` | Bounded tool loop, prompt (a10, plus `SMART_NOTE` s1 for smart models), compact catalog (`smartOfferedTools` for smart conversations), tool groups (1–3 → union), history fitter, model table (`MODELS`, `SMART_MODELS`), token and request budget, Groq and Gemini providers, history, lock, suspended turns (phone or consent), `consents.ts` (consent sources, `conversation_consents`, `cs:`/`cr:` button ids) | §6.19 |
| `nlu/` | Fallback parser: prompt (v6), `IntentDraft` schema, slot schemas, Groq provider, rules fallback, weekday check, clarification answers | §6.2, §6.11 |
| `tools/` | `registry.ts` (single source of truth: name, tier, slots, scopes, flags, required `dataSource`) + one file per area; `*-store.ts` hold SQL; `match.ts` finds targets | §6.4, §6.19 |
| `policy/` | Pure tier decision; WhatsApp 24 h window/budget | §6.4 |
| `confirm/` | Pending confirmations, Undo offers, open questions | §6.5, §6.11 |
| `time/` | `resolve` (R1–R12), `tz`, Hebrew lexicon (and `timeWordsNamed`, the am/pm and part-of-day check), ranges, recurrence, past days, sunset, Shabbat/chag | §6.3, §6.13 |
| `google/` | OAuth (PKCE), per-area grants with encrypted refresh tokens, Calendar/Tasks/Gmail/Drive/Contacts (birthdays only) clients | §6.6 |
| `ical/` | Subscribed calendar feeds: URL guard, fetch, parse, cache, merge | §6.15 |
| `lookup/` | Public keyless data for `info.lookup` + calculator grammar; `quotes.ts`: stock quotes (Finnhub US with `QUOTES_API_KEY` in a header, Yahoo TASE), units normalized once | §6.4, §6.24 |
| `device/` | Paired-phone state, FCM v1 (no SDK), call dispatch | §6.17 |
| `voice/` | Whisper transcription + confidence gate | §6.10 |
| `security/` | AES-GCM crypto, HMAC, redacting logger, `scrubForModel`/defang, allowlist | §7 |
| `render/` | Every user-facing string (Hebrew/English templates, time format, bidi); `consent.ts`: the consent card, its buttons and `/consents` | §6.3, §6.19 |

**Tools by tier** (from `tools/registry.ts`; parser sees only the first 8 marked *):
- Tier 0 (read): `reminders.list`*, `calendar.list_events`*, `calendar.free_time`, `phone.contacts|notifications|sms|calls`, `info.lookup`, `tasks.list`, `mail.search|bills`, `drive.search`, `notes.find`, `lists.show`, `portfolio.show`, `expenses.summary`, `calc.compute`, `birthdays.upcoming`
- Tier 1 (runs now; Undo where reversible; cards run on the phone): `reminders.create`*, `reminders.repeat|at_rest|scheduled_read|leave`, `calendar.create_event`* (Tier 3 with attendees), `tasks.add|complete`, `notes.save`, `lists.add|remove`, `memory.remember`, `portfolio.update`, `expenses.add|export`, cards `alarm.set`, `timer.set`, `nav.go`, `app.open`, `media.play`, `settings.set`
- Tier 2 (confirm): `reminders.cancel`*, `reminders.move`, `calendar.move_event`*, `calendar.delete_event`*, `mail.draft`, `notes.delete`, `lists.delete`, `memory.forget`
- Tier 3 (confirm on phone): `calls.place`*, `message.compose`

## 4. Storage

One SQLite DB inside the DO. Schema = `migrations/0001…0027` (registered in
`platform/migrations.ts`). Tables by area:

| Area | Tables |
|---|---|
| Messages & audit | `inbound_messages`, `outbound_messages`, `audit_log`, `counters`, `window_state`, `settings` |
| Confirm / Undo / questions | `pending_actions` (also cards), `undo_actions`, `open_questions` |
| Reminders | `reminders`, `reminder_series` |
| Google | `integrations` (encrypted refresh tokens per grant), `oauth_links`, `oauth_states` |
| App & phone | `devices`, `device_pairings`, `app_outbox`, `app_nonces`, `call_dispatches` |
| Agent | `conversation_turns` (encrypted history), `agent_turns` (suspended; 0027 adds `kind` phone/consent, `nonce_hash`, `source`, `conversation`), `agent_lock` |
| Smart conversations (0026) | `conversation_modes` (mode per app conversation, recorded once), `conversation_consents` (sources allowed for one conversation); both purged after 30 days unused and by `/forget`, `/pair off` |
| Misses (§6.23) | `last_exchange` (encrypted, 1 h), `misses` (encrypted, 30 days); `inbound_messages.seq` + `settings.inbound_seq` order arrivals |
| Quota | `groq_limits`, `groq_token_spend`, `worker_requests`, `model_day_requests` (Gemini requests per Pacific day, 0026) |
| Data | `ical_feeds`, `ical_events`, `birthdays`, `notes`, `lists`, `list_items`, `facts` (encrypted; the model sees them), `holdings` (the portfolio, soft-delete + version), `quote_cache` (public prices, no principal), `expenses`, `missed_calls` (minutes only) |

Access goes through `core/sql.ts` (`SqlDriver`) so tests run
the same code on Node SQLite (`test/integration/sqlite-driver.ts`).

## 5. Coupled vs. isolated

**Intentionally isolated**
- Cloudflare ↔ everything else (`platform/` only; Plan B is Node + SQLite).
- Model ↔ data: the model never sees ids, numbers, addresses, tokens, notes, lists;
  reads are scrubbed; ids are found by `tools/match.ts` from `query_variants`.
- Local ↔ smart models: `SMART_MODELS` is never in `MODELS`; a local
  conversation, cron, shared text and the read-only try never reach Gemini.
- Parser catalog ↔ agent catalog (`PARSER_TOOL_NAMES`): new tools don't touch
  the parser or `pnpm eval`.
- Each Google area is its own grant and token.
- Rendering ↔ logic: `resolve`/policy return codes; `render/` makes words.

**Coupled on purpose (change together)**
- `tools/registry.ts` ↔ `agent/tool-groups.ts` ↔ `test/evals/fingerprint.ts` ↔ `models.ts` evaluated fingerprint.
- `tools/registry.ts` `dataSource` ↔ `agent/consents.ts` ↔ `render/consent.ts` ↔ the history gate in `pipeline.ts` ↔ the smart fingerprint (`SMART_CATALOG_POLICY`).
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
