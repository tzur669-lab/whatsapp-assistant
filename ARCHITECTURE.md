# Architecture

How the code is laid out and how the parts talk. The *why* behind each piece
is in `PLAN.md` (section numbers given); the rules are in `CLAUDE.md`.
Current as of 2026-10-14 (migration 0035).

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
   first instead. An image (`POST /app/image`, §6.32) is read here by
   `vision/read-image.ts` and continues as shared text: forwarded, tainted.
2. **Deterministic first** (`core/router.ts`, `confirm/`) — slash commands,
   button replies, "כן" to a pending confirmation, an answer to an open
   question. No LLM. Confirmations execute the *stored* input (inv. 7).
3. **Agent** (`agent/loop.ts`, when `AGENT=on`) — per-sender lock
   (`lock.ts`, its TTL derived from the turn deadline in `limits.ts`; no
   model call or tool starts past it, and then no parser either; as an
   `AbortSignal` it cuts the model call and a resolve's or read's requests in
   flight, bound by `tools/turn-signal.ts` — never a write's `execute`), encrypted short history (`history.ts`), code picks a tool
   group (`tool-groups.ts`; a short follow-up that names none inherits the
   previous local turn's groups from `last-selection.ts`, block J2a, and the
   full set goes with the short descriptions in `briefs.ts`, J2b), budget
   reserves tokens before each call
   (`budget.ts`, `models.ts`). Each tool call → `fillUnstatedTime`
   (`tools.ts`: a TimeSpec's missing `meridiem`/`part_of_day` → 'unspecified'
   only where it cannot move the time; `liftMonthFromDate` for a calendar
   read's month sent inside `date`) → strict Zod → `orchestrator` path below.
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
  read-only try stay local. Every model in it is offered what a local turn
  would be, less the consent sources it may not ask for; `private` tools are
  offered (2026-10-11) and never answer to a model. A call to a tool whose
  `dataSource` is a consent source not yet allowed, and whose `consent` rule is
  `always`, suspends the turn (`agent_turns.kind = 'consent'`)
  with a card (`render/consent.ts`); the tap is handled in code
  (`beginConsent`, `resumeAfterConsent`), and "this conversation" writes
  `conversation_consents`. A write whose replies only echo its own call
  (`exempt-own-input`, e.g. `reminders.create`) never asks. `settleAgentResult`
  is the history gate: a reply after a source not allowed is stored as a
  placeholder; an own-input write's reply is kept. Each entry carries `src`
  (its sources, inherited from the history it saw); the read replays a reply
  whose source is not allowed now, or an untagged one, as the placeholder
  (`replayByConsent`, 2026-10-12). A smart suspended turn keeps
  `historySources`; a resume holding a source no longer allowed ends
  (`mayResend` in `loop.ts`). `/consents` lists and
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
| `core/` | `pipeline` (inbound order; `settleAgentResult` is the history gate), `router` (commands), `orchestrator` (resolve→policy→act), `repo`/`sql` (data access; conversation modes), `exchanges` ("לא הבנת" capture, never given to the agent), `learn-store` (the learning journal, block K, never given to the agent), `learn-review` + `habits` (the weekly review and its proposals, K2), `learn-export` (the export, K3), `digest`, `birthdays`, `missed-calls`, `scheduled-read`, `quota` (also `SqlDayRequestCounter`: requests per model per Pacific day), `timing`, `env` | §6.4, §6.12 |
| `agent/` | Bounded tool loop, prompt (a10, plus `SMART_NOTE` s2 for smart models), compact catalog (`smartOfferedTools` for smart conversations), tool groups (1–3 → union), history fitter, model table (`MODELS`, `SMART_MODELS`), token and request budget, Groq and Gemini providers, history, lock, suspended turns (phone or consent), `consents.ts` (consent sources, `consentNeededFor`/`echoesOwnInput` from each tool's `consent` rule, `conversation_consents`, `cs:`/`cr:` button ids) | §6.19 |
| `nlu/` | Fallback parser: prompt (v6), `IntentDraft` schema, slot schemas, Groq provider, rules fallback, weekday check, clarification answers | §6.2, §6.11 |
| `tools/` | `registry.ts` (single source of truth: name, tier, slots, scopes, flags, required `dataSource`, and `consent` rule for a consent source) + one file per area; `*-store.ts` hold SQL; `turn-signal.ts` binds a context's network clients to the turn deadline; `match.ts` finds targets; `routines.ts` + `routine-store.ts`: `routine.run` and the run lifecycle (synced names, one claim per run); `screen.ts` + `screen-store.ts`: `screen.task`, the allowlist and the task state machine (sealed task and inputs, one conditional UPDATE per move) | §6.4, §6.19, §6.27, §6.28 |
| `policy/` | Pure tier decision; WhatsApp 24 h window/budget | §6.4 |
| `confirm/` | Pending confirmations, Undo offers, open questions | §6.5, §6.11 |
| `time/` | `resolve` (R1–R12), `tz`, Hebrew lexicon (and `timeWordsNamed`, the am/pm and part-of-day check), ranges, recurrence, past days, sunset, Shabbat/chag | §6.3, §6.13 |
| `google/` | OAuth (PKCE), per-area grants with encrypted refresh tokens, Calendar/Tasks/Gmail/Drive/Contacts (birthdays only) clients | §6.6 |
| `ical/` | Subscribed calendar feeds: URL guard, fetch, parse, cache, merge | §6.15 |
| `lookup/` | Public keyless data for `info.lookup` + calculator grammar; `quotes.ts`: stock quotes (Finnhub US with `QUOTES_API_KEY` in a header, Yahoo TASE), units normalized once | §6.4, §6.24 |
| `device/` | Paired-phone state, FCM v1 (no SDK), call dispatch | §6.17 |
| `voice/` | Whisper transcription + confidence gate | §6.10 |
| `vision/` | `read-image.ts`: an image read by one Gemini call (`VISION_MODELS`, every conversation), fixed prompt, no tools; the text it read is quoted as shared text by `handleImage` in `core/pipeline.ts` | §6.32 |
| `security/` | AES-GCM crypto, HMAC, redacting logger, `scrubForModel`/defang, allowlist | §7 |
| `render/` | Every user-facing string (Hebrew/English templates, time format, bidi); `consent.ts`: the consent card, its buttons and `/consents`; `routines.ts`: routine confirmations, notices and results (`RUN_REASONS`); `screen.ts`: the screen agent's card, approval card, busy reply and end messages | §6.3, §6.19, §6.27, §6.28 |

**Tools by tier** (from `tools/registry.ts`; parser sees only the first 8 marked *):
- Tier 0 (read): `reminders.list`*, `calendar.list_events`*, `calendar.free_time`, `phone.contacts|notifications|sms|calls`, `info.lookup`, `tasks.list`, `mail.search|bills`, `drive.search`, `notes.find`, `lists.show`, `portfolio.show`, `expenses.summary`, `calc.compute`, `birthdays.upcoming`
- Tier 1 (runs now; Undo where reversible; cards run on the phone): `reminders.create`*, `reminders.repeat|at_rest|scheduled_read|leave`, `calendar.create_event`* (Tier 3 with attendees), `tasks.add|complete`, `notes.save`, `lists.add|remove`, `memory.remember`, `portfolio.update`, `expenses.add|export|monthly_pack`, `mail.follow_up`, cards `alarm.set`, `timer.set`, `nav.go`, `app.open`, `media.play`, `settings.set`
- Tier 2 (confirm): `reminders.cancel`*, `reminders.move`, `calendar.move_event`*, `calendar.delete_event`*, `mail.draft`, `notes.delete`, `lists.delete`, `memory.forget`, `routine.run` (private; offered only when a synced routine is named; refuses a tainted turn; runs at its time with no tap), `screen.task` (private; offered only when the screen agent or an allowed app is named; refuses a tainted turn; each sensitive or uncertain step stops again for approval), `mail.archive` (offered only when "archive" is said; `/unarchive` restores), `docs.create` (offered only when a document is asked for; refuses a tainted turn; Drive and a phone file card)
- Tier 3 (confirm on phone): `calls.place`*, `message.compose`

## 4. Storage

One SQLite DB inside the DO. Schema = `migrations/0001…0028` (registered in
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
| Learning (0035–0036, block K) | `learn_events` (miss / rephrase / undo / confirm_no / leave; text AES-GCM per row, `meta` closed codes; 60 days, newest 200), `learn_weeks` (counters per Sunday-week, 26 weeks), `learn_proposals` (K2: one row per answer, `group_id`, nonce hash, 6 days, ended rows 90 days); state in `settings` (`learn_on`, `learn_notice_seen`, `learn_notice_sent`, `learn_since`, `learn_version_since`, `learn_review_sent_on`, `leave_default_min`) |
| Watches (0034, block J4) | `watches` (source, normalized and said keywords, sender, the reminder text in plain text like `reminders.text`, fires left, cooldown, end, Gmail `last_checked` and the last 50 seen ids; active → spent / cancelled; purged 90 days after) |
| Mail archives (0040, block L5) | `mail_archives` (the confirmed ids until 7 days, `op` pending/done/failed/restored, the 5-minute `exec_until` fence, the batch label's name and id and `label_state` unknown/present/none/deleted/kept, `/unarchive`'s claim and token, cleanup attempts and backoff) |
| Monthly file (0039, block L4) | `monthly_exports` (principal, month, sent at): written only in the transaction that queues the month's card |
| Calendar suggestions (0038, block L3) | `suggestions` (event id, day, open → checking (2-minute lease, claim token) → used / dismissed, nonce hash, the card's pending id; unique per event and day; kept 30 days) and `reminders.event_id` (the event a leave reminder is for) |
| Mail follow-ups (0037, block L2) | `mail_followups` (the sent mail's thread, id, RFC Message-ID, To header for the draft only, subject, deadline; open → answered / bounced / unsure / notified → used / dismissed, or cancelled; nonce hash, attempts, day marker, the draft card's pending id; settled kept 90 days) |
| Inherited groups (0033, block J2a) | `last_selection` (one row per conversation: the latest local agent turn's tool groups as code names, its starting taint, `ran` once that turn ran tools from them; ordered by `seq`, 10 min, purged on every alarm) |
| Screen agent (0030, §6.28) | `screen_allow` (the phone's sync: package, label, ask-every-tap), `screen_tasks` (one row per confirmed task: sealed task and inputs, status confirmed → pushed → running ⇄ awaiting_approval → released → … → stopped/preempted/deadline/done/failed/unknown, the decided action as codes and the phone's binding, past steps as codes, the approval and stop nonces, tokens reserved, `mode` local/smart since 0031, `in_reply_to` since 0032: the confirming message, so the task's messages go to its conversation), `screen_model_day` (0031: screen tokens per Groq model per day) |
| Routines (0028–0029, §6.27) | `routine_names` (the app's sync: id, name, app label, step hash, list position — never steps), `routine_runs` (one row per confirmed run, with its card time and the card's and notice's cancel hashes: scheduled → noticed → pushed → claimed → done/unverified/failed/unknown, or cancelled/expired/changed) |
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
- `tools/registry.ts` ↔ `agent/tool-groups.ts` ↔ `test/evals/fingerprint.ts` ↔ `models.ts` evaluated fingerprint. `agent/briefs.ts` is hashed too (the brief full catalog, J2b): editing a brief moves the Groq fingerprint.
- Digest sections (J5, §6.12): `core/digest.ts` ↔ `core/conflicts.ts` and `tools/bills.ts` (`readBills`, shared with `mail.bills`) ↔ `render/digest.ts`; `core/router.ts` (`/digest conflicts|bills on|off`) ↔ `core/repo.ts` (`digestSection`) ↔ `assistant-do.ts` `maybeSendDigest`.
- Facts (§6.26): `agent/tool-groups.ts` `namesRememberAboutMe` → `ToolContext.explicitFact` (set in `pipeline.ts` `turnOf` from the words) → `tools/memory.ts` `resolve` (`unrequested`) → `policy/engine.ts` reason `unrequested` → confirm card; `agent/loop.ts` drops facts oldest first under `promptCeiling`.
- Learning (K1, §6.31): `core/learn-store.ts` (`LearnStore`, `KIND_SINCE`, `LearnSink`) ↔ `core/orchestrator.ts` (`TurnContext.learn`: `audit` marks understood; executed / undo / confirm_no signals) ↔ `core/pipeline.ts` (`/learn`, `keepExchange` → `rephrasePair` with `ExchangeLog.seal`/`writeSealed`/`latest`, `copyMissToJournal`, `writeLearnSignals`, the `messages` counter) ↔ `assistant-do.ts` (`acceptReply` marks the notice row, `appAck` → `acked`, `serviceOutbox` → `expired`, the tick's `maybeSendLearnNotice`, WhatsApp send → `noticeDelivered`, `runMaintenance` → `purge`) ↔ `render/learn.ts`. `reminders.leave` input carries `stated`.
- Learning (K2–K4): the tick's `maybeSendLearnReview` (`assistant-do.ts`) → `planReview` (`core/learn-review.ts`, `core/habits.ts`; `LearnStore.firstMessageTimes` reads `inbound_messages` minus `router.ts` `COMMAND_KINDS`) → one transaction: `markReviewSent`, `insertGroup`, outbox rows with `lp:` buttons. `pipeline.ts` answers `lp:` (`learnProposalButton` → `LearnStore.answerProposal` → `Repository.setDigestHour` / `setLeaveDefaultMinutes`) and `/leave` (`leaveCommand`; `reminders.leave` reads `leaveDefaultMinutes`). `GET /app/learn/export` (`ingress.ts` → `appLearnExport` → `core/learn-export.ts`). App: `LearnExportLogic.kt`, `DownloadsSave.kt`, `Api.learnExport`. Claude Code: `scripts/learn-to-evals.ts`, `.claude/skills/learn-review/`.
- Watches (J4, §6.30): `tools/watch.ts` (`reminders.when`, `namesWatch`) ↔ `tools/watch-store.ts` (`fire` = claim + `ReminderStore.schedule` in one transaction; `checkMailWatches`, `mailQuery`) ↔ `core/watch-match.ts` = the app's `WatchMatcher.kt` (both against `test/fixtures/watch-normalize.json`) ↔ `channels/app/parse.ts` (`parseWatchFired`) / `ingress.ts` ↔ `assistant-do.ts` (`appWatches`, `appWatchFired`, the tick, `pushWatches` → `device/fcm.ts` `watchesChanged`) ↔ the app's `CompanionMessagingService` (`kind: watches`); `core/pipeline.ts` (`watch` offer on the app channel, `/watches`); `google/gmail.ts` `listIds`.
- Documents (L6, §6.37): `tools/docs.ts` (`docs.create`, `namesDocument`, `cleanDocText`, `docFileName`) ↔ `google/drive.ts` (`createDoc`, `findByOp`, `sourceMime`, `hasScope`, `DRIVE_FILE_SCOPE`) ↔ `core/orchestrator.ts` (`fileCardReply`: `ExecuteResult.fileCard` → a card, direct and confirmed path) ↔ `core/pipeline.ts` (`document` offer flag, `ToolContext.fileCards` from the device's `file` capability) ↔ `render/phone.ts` file mime ↔ the app's `CardLogic.fileCard`/`DeviceActions`; `agent/tool-groups.ts` `RIDE_ALONG`; `render/docs.ts`.
- Mail cleanup (L5, §6.36): `tools/archive.ts` (`mail.archive`, `namesArchive`, `archiveQuery`) ↔ `core/mail-archive.ts` (`runArchive`, `restoreNewest`, `cleanArchiveLabels`, `isDefiniteFailure`) ↔ `tools/archive-store.ts` ↔ `google/gmail.ts` (`listIdsBounded`, `createLabel`, `labelName`, `listLabels`, `deleteLabel`, `batchModify`, `hasScope`) ↔ `google/api.ts` (`GoogleCaller.grantedScopes`) ↔ `core/pipeline.ts` (`/unarchive`, `archive` offer flag) ↔ `assistant-do.ts` (`cleanArchiveLabels` on the tick, purge); `render/archive.ts`; `test/security/gmail-endpoints.test.ts`.
- The monthly file (L4, §6.35): `tools/monthly-pack.ts` (`expenses.monthly_pack`, `namesMonthlyPack`, `monthSpan`, `monthlyCsv`, `buildMonthlyPack`) ↔ `tools/bills.ts` (`readBillsCounted`, `buildBillsQueryBetween`) ↔ `google/gmail.ts` (`searchCounted`) ↔ `tools/expense-store.ts` (`between`, `cell`, `BOM`) ↔ `assistant-do.ts` (`maybeSendMonthlyPack` on the tick) ↔ `agent/tools.ts` (`monthly` offer flag; excluded in `smartOfferedTools`) ↔ `core/pipeline.ts` (`/monthly`, `Repository.monthlyEnabled`); `render/monthly.ts`.
- Calendar suggestions (L3, §6.34): `core/suggest-plan.ts` (`localDay`, `eventsToSuggest`, `placesOverlap`, pure) ↔ `tools/suggestion-store.ts` (`offer` = day guard + rows + notices in one transaction; `claim`/`complete`/`close`/`release` fenced by `claim_token`; `reissue`) ↔ `assistant-do.ts` (`maybeSendSuggestions` on the tick, purge) ↔ `core/orchestrator.ts` (`sg:` → `answerSuggestion`, `CalendarClient.getEvent`, `leaveInputFor` from `tools/reminders.ts`, `PendingActions.inputOf`/`supersede`) ↔ `core/pipeline.ts` (`/suggest`, `Repository.suggestionsEnabled`); `render/suggestions.ts`; `ReminderStore.pendingLeaves`/`hasPendingLeaveFor`.
- Mail follow-ups (L2, §6.33): `tools/followup.ts` (`mail.follow_up`, `namesFollowUp`, `toLineOf`) ↔ `tools/followup-store.ts` (`settle` = row + notice in one transaction, `tap` = row + draft card, `PendingActions.supersede`) ↔ `core/followup-check.ts` (`classifyThread`, pure) ↔ `core/followup-tick.ts` (`checkFollowUps`) ↔ `assistant-do.ts` (the tick, `runMaintenance` purge) ↔ `core/orchestrator.ts` (`fu:` → `answerFollowUp`) ↔ `core/pipeline.ts` (`followUp` offer on the app channel, `/followups`); `google/gmail.ts` `thread`, `MailSummary.toHeader`; `render/followups.ts`.
- `web.read` (J3, §6.29): `core/pipeline.ts` (`singleHttpsUrl` → `webRead` offer) ↔ `agent/tools.ts` (`OfferOptions.webRead`, `TAINTING_TOOLS`) ↔ `agent/tool-groups.ts` (rides along in any selection) ↔ `tools/web-read.ts` (link from `userText`) ↔ `lookup/web-page.ts` (guard, fetch) ↔ `platform/html-text.ts` (`HTMLRewriter`, `ToolContext.pageText`, wired in `assistant-do.ts`); `test/security/turn-signal-fetch.test.ts` places its fetch.
- Inherited groups (J2a): `core/pipeline.ts` reads `LastSelections.inherited` before the turn and passes `onLocalSelection` (writes at plan time, `seq` from `inboundSeq`) ↔ `agent/loop.ts` ↔ `selectTools(text, offered, inherited)`; `settleAgentResult` calls `markRan` for the same `seq` (never the read-only try).
- `tools/registry.ts` `dataSource` and `consent` ↔ `agent/consents.ts` ↔ `render/consent.ts` ↔ the history gate in `pipeline.ts` ↔ the smart fingerprint (`SMART_CATALOG_POLICY`).
- `channels/app/parse.ts` + `verify.ts` ↔ app's `Protocol.kt` (shared test vectors).
- `migrations/*.sql` ↔ `platform/migrations.ts`.
- A network client on `ToolContext` ↔ `tools/turn-signal.ts` `withTurnSignal` (bind it to the turn deadline) ↔ the fetch inventory in `test/security/turn-signal-fetch.test.ts`.
- Screen agent: `agent/screen-step.ts` (prompt, closed action schema, element schema, one Groq call per step, `runScreenStep`) ↔ `agent/screen-policy.ts` ↔ the app's `ScreenLogic.kt` (both against `test/fixtures/screen-policy.json`) ↔ `tools/screen-store.ts` ↔ `channels/app/parse.ts` (`/app/screen/allow|claim|step|approve|result`, `SCREEN_END_REASONS`) ↔ `channels/app/ingress.ts` ↔ the app's `Protocol.kt`/`ScreenRun.kt`/`ScreenJournal.kt`; `device/fcm.ts` `screenTask` ↔ `CompanionMessagingService.kt`; `core/pipeline.ts` (`namesScreenTask` offer, the busy reply) ↔ `agent/tool-groups.ts` (`screen` kept in any selection) ↔ `core/orchestrator.ts` (`sa:`/`ss:` buttons); `agent/models.ts` `SCREEN_MODELS` (Groq, a local task) / `SCREEN_SMART_MODELS` + `SCREEN_ONLY_MODELS` (Gemini, a smart task; 2026-10-13), the mode carried by `ToolContext.smart` → the confirmed input → `screen_tasks.mode`; `screen_model_day` caps each Groq model's daily share; `routine` pushes preempt a task (`assistant-do.ts`).
- Routines: `tools/routine-store.ts` ↔ `channels/app/parse.ts` (`/app/routines`, `/app/routine/claim`, `/app/routine/result`) ↔ `channels/app/ingress.ts` ↔ the app's `RoutineRunner.kt`/`RoutineLogic.stepHash` (since 0.17 a locked phone with a stored PIN claims first: `UnlockLogic.kt`/`UnlockStore.kt` → `RoutineAccessibilityService.unlockAndRun`, app only); `render/routines.ts` `RUN_REASONS` ↔ the app's reason codes; `core/pipeline.ts` `namesRoutine` ↔ `agent/tools.ts` `routines` offer ↔ `agent/tool-groups.ts` (routine kept in any selection).
- A routine from a screen task (app only, 0.21, plan `docs/plans/routine-from-screen-task.md`): `ScreenRun` → `RoutineRecording.kt` (actions that ran → steps; `SPOIL_REASONS` ↔ `spoiledText`) → `RoutineDrafts.kt` (one draft, memory only, 30 min) → `ScreenNotifications.showDraft`/`showDraftSpoiled` → `RoutinesActivity` review (Save gated by `RoutineLogic.dryRunCovers`: the dry run's `stepHash` extra) → `RoutineStore.save`. `RoutineLogic.explain` ↔ the `explain_*` strings. The server never sees a draft.
- `nlu/slot-schemas.ts` `DateSpec`/`TimeSpec` ↔ `time/resolve.ts` types.
- Agent prompt version ↔ eval recordings.

## 6. Tests (`test/`)

`unit/` (mirrors `src/`), `integration/` (fakes: Groq, NLU, agent, phone,
DO state, logger; Workers-strict `fetch`; Node SQLite driver), `security/` (ingress, log canaries, ban-list, the fetch inventory for the turn signal,
secret scan), `evals/` (YAML corpora `cases.he|en|phone.yaml`, runners for
parser, agent and turn evals; recordings are git-ignored). Clocks are frozen;
no network in unit tests.
