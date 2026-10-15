# Session log (moved out of HANDOFF.md §8, 2026-10-15)

Newest first. Read only when you need the history of a change; HANDOFF.md is the entry point.

- 2026-10-15: Screen agent phase 3, part 2 (plan
  `docs/plans/routine-from-screen-task.md`), app 0.21.0 (versionCode 40), no
  server change, no deploy. `RoutinesActivity` review mode (by draft id; app
  fixed, name empty, working copy kept in `RoutineDrafts` after every edit,
  marked steps, explanation; Save enabled only by `RoutineLogic.dryRunCovers`
  — the run's result intent now carries `routine_step_hash`; a stale id saves
  nothing; a failed review dry run adds the "started on another screen" note),
  the draft at the top of the list, "מה היא עושה?" on every routine.
  `ScreenNotifications.showDraft`/`showDraftSpoiled` (private, own channel,
  one id), posted from `ScreenRun.offerDraft`. `RoutineLogic.explain` (`Line`
  codes), `marksAfterRemove`; `RoutineRecording.SPOIL_REASONS`/`spoiledText`
  (a source-scan test pins every code). Docs: PLAN §6.27 amendment, §6.28,
  §13, §14; screen-agent.md; HANDOFF; ARCHITECTURE; app README. APK
  `C:\Users\tzur6\Downloads\call-companion-0.21.0.apk`. Owed: the phone check
  after M4.
- 2026-10-15: Screen agent phase 3, part 1 (plan
  `docs/plans/routine-from-screen-task.md`): the recorder, app only. New
  `RoutineRecording.kt` (actions that ran → routine steps; selector order
  text/hint → description → one child's text → view id, proved by
  `pickTarget`; the field anchor by binding; spoil codes `no_selector`,
  `typed_differs`, `password`, `not_field`, `scrolled`, `went_back`,
  `not_accepted`, `too_long`, `no_action`, `replayed`) and `RoutineDrafts.kt`
  (one draft in memory, 30 min, synchronized). `ScreenOps.fire` returns
  `Fired(accepted, typedMatched)`; `ScreenRun` records after each journal
  outcome, marks released actions, spoils on a journal replay, and offers the
  draft on `end` `completed_unverified`. Tests `RoutineRecordingTest` (23),
  `RoutineDraftsTest` (4). No version bump, no APK, no server change.

- 2026-10-15: Block L, L6: documents — new `tools/docs.ts`, `render/docs.ts`,
  `DriveClient.createDoc`/`findByOp`/`sourceMime`/`hasScope`, the `drive.file`
  scope, `ExecuteResult.fileCard` and the orchestrator's `fileCardReply`,
  `ToolContext.fileCards`, the `document` offer flag, `RIDE_ALONG` in
  `agent/tool-groups.ts`; app 0.20.0 (`CardLogic.FileCard.mime`, Markdown).
  No migration. Staging deployed (06b52872).

- 2026-10-15: Block L, L5: mail cleanup — new `tools/archive.ts`,
  `tools/archive-store.ts`, `core/mail-archive.ts`, `render/archive.ts`,
  migration 0040 (`mail_archives`), `/unarchive`, the `gmail.modify` scope,
  `GoogleCaller.grantedScopes`, Gmail label and `batchModify` methods,
  `test/security/gmail-endpoints.test.ts`. Not deployed (wrangler login).

- 2026-10-15: Block L, L4: the monthly bookkeeping file — new
  `tools/monthly-pack.ts`, `render/monthly.ts`, migration 0039
  (`monthly_exports`), `/monthly`, `GmailClient.searchCounted`,
  `readBillsCounted`/`buildBillsQueryBetween` (bills.ts), the `monthly` offer
  flag (named-only, excluded from smart conversations), records-group words
  for bookkeeping. Not deployed (wrangler login).

- 2026-10-15: Block L, L3: calendar suggestions — new `core/suggest-plan.ts`,
  `tools/suggestion-store.ts`, `render/suggestions.ts`, migration 0038
  (`suggestions`, `reminders.event_id`), `/suggest`, button kind `sg`,
  `CalendarClient.getEvent`, `leaveInputFor` (shared by `reminders.leave`),
  `PendingActions.inputOf`, `ReminderStore.pendingLeaves`/`hasPendingLeaveFor`.
  Staging deploy owed (wrangler's Cloudflare login could not be refreshed).

- 2026-10-15: Block L planned (`docs/plans/block-l.md`); L2 built: mail
  follow-ups — new `tools/followup.ts`, `tools/followup-store.ts`,
  `core/followup-check.ts`, `core/followup-tick.ts`, `render/followups.ts`,
  migration 0037 (`mail_followups`), `/followups`, button kind `fu`,
  `GmailClient.thread`, `MailSummary.toHeader`, `PendingActions.supersede`,
  the `followUp` offer flag. The eval runner's decoder now knows `web.read`,
  `reminders.when` and `mail.follow_up` (it decoded only routines and screen).

- 2026-10-14: Images (PLAN §6.32): new `src/vision/read-image.ts`,
  `InboundImage`, route `POST /app/image`, `handleImage` in
  `core/pipeline.ts`, `composeImage`, `VISION_MODELS` (Gemini, every
  conversation — revised the same day: no Groq vision model on the key),
  `image_notice_at`, quota role `vision` and `images`;
  CLAUDE.md invariant 2 amended. No tables or migrations. App 0.19.0
  (`ImageLogic.kt`, `ImagePrep.kt`, 📎, image share target). Staging
  deployed (f8ffb42b; `/app/image` answers 401 unsigned); APK 0.19.0 in
  Downloads, not yet installed. Then Gemini-only reading: staging d80642ac.

- 2026-10-14: Screen agent smarter, from a failed Israel Rail run (the
  station picker hides its search box; qwen typed into a button, `model_error`):
  one corrective call per step on the same model (`whyNot`, `askAgain` in
  `agent/screen-step.ts`), 1,024 completion tokens (qwen's thinking was cut
  off at 150/256), task ceiling 24K, `HistoryEntry.in`, prompt s2, eval case
  `rail-no-field`. No new modules or tables. Staging deployed (4ce52fbf).

- 2026-10-14: App 0.18.2: the `/` list shows each command on its own row,
  the command over what it does, the chat's full width, and offers every
  router command (`/memory`, `/learn`, `/leave`, `/watches`, `/consents`,
  `/misses`, digest sections…) but `/budget` and `/pair`. New
  `test/unit/core/app-commands.test.ts` reads `ChatLogic.kt` against the
  router. Checked on the phone. No server change, no deploy.

- 2026-10-14: App 0.18.1: the location menu names the town ("פועל (רבבה)"),
  checked on the phone. ColorOS's geocoder gave only a road number, so the
  name was dropped and some messages went without a fix (Jerusalem):
  `LocationLogic.townOf`/`ring`, fused provider, the app's last fix reused
  while fresh. No server change, no deploy.

- 2026-10-14: Block K, K2–K4: new `core/learn-review.ts`, `core/habits.ts`,
  `core/learn-export.ts`, migration 0036 (`learn_proposals`), `/leave`,
  `/learn export`, `lp:` buttons, route `GET /app/learn/export`,
  `Repository.leaveDefaultMinutes`, `router.ts` `COMMAND_KINDS`; app 0.18.0
  (`LearnExportLogic.kt`, `DownloadsSave.kt`); `scripts/learn-to-evals.ts`, skill
  `learn-review`, `docs/learn-log.md`. Staging deployed (ab7c7087, migration
  0036; the export route answers 401 unsigned).

- 2026-10-14: Facts said in passing are offered on a card (§6.26):
  `namesRememberAboutMe` (`agent/tool-groups.ts`), `ToolContext.explicitFact`,
  `ResolveOutcome.unrequested`, policy reason `unrequested`, `factText.offer`;
  caps 40 / 1,600; the fitter drops facts oldest first under the one-call
  budget (`promptCeiling` in `agent/loop.ts`). No new modules or tables.
  Staging deployed (9d9b460e).

- 2026-10-14: Block K, K1: the learning journal — new `core/learn-store.ts`,
  `render/learn.ts`, migration 0035 (`learn_events`, `learn_weeks`), `/learn`;
  `TurnContext.learn`, `ExchangeLog.seal`/`writeSealed`/`latest`,
  `Exchange.understood`, `reminders.leave` `stated`, `AppOutbox.expireDue` seqs.
  Staging deployed (d53db582, migration 0035).

- 2026-10-13: Apps 0.17.2–0.17.3, from phone runs: the swipe spans the full
  height (85% → 15%), and keys are taps once the keypad has settled
  (ColorOS ignores `ACTION_CLICK` there; `settled`, `screenSize`). The full
  run passed: unlock, FID results, relock. Installed on the phone.

- 2026-10-13: App 0.17.1, from the first phone run (ColorOS 14): the PIN
  pad never came up — the run screen covered the lock screen and ColorOS
  ignores the dismiss request. The pin-mode screen now steps back and the
  service swipes the keypad up (`swipeUp`, `gesture`). Installed on the phone.

- 2026-10-13: App 0.17.0: routines unlock with a stored PIN — new
  `UnlockLogic.kt`, `UnlockStore.kt`; `RoutineRunner.claimFirst`/`runClaimed`,
  `RoutineAccessibilityService.unlockAndRun`, `RoutineRunActivity` claimed
  and pin modes, `Notifier.unlockFailed`. No server change, no deploy.

- 2026-10-13: Calendar lists grouped by day, time first (`eventText.list`
  takes an optional clock for היום/מחר/אתמול). Render only; no new modules
  or tables. Staging deployed (b93a416e). From now on every server
  change is deployed to staging at the end (standing approval).

- 2026-10-13: Staging deployed (8e7e006c) with block J (J1–J7); APK 0.16.0
  in Downloads.

- 2026-10-13: Block J7: `sameFact` in `tools/memory.ts`, `factText.already`.
  No new modules or tables. Block J complete in code.

- 2026-10-13: Block J6, app 0.16.0: `SpeechLogic.kt`, `Speech.kt`,
  `ChatStore.kindOfMessage`, a settings switch. No server change.

- 2026-10-13: Block J5: new `core/conflicts.ts`; `buildDigest` sections
  (`DigestContext.sections`, `gmail`), `readBills`/`billsDueWithin`/`billLine`
  in `tools/bills.ts`, `Repository.digestSection`. No tables.

- 2026-10-13: Block J4, app 0.15.0: `Watches.kt`, `WatchMatcher.kt` (fixture
  test), `NotificationCollector` hook, FCM `watches`, network-return retry
  (`ACCESS_NETWORK_STATE`). Not deployed, not installed.

- 2026-10-13: Block J4, server: `reminders.when` — new `tools/watch.ts`,
  `tools/watch-store.ts`, `core/watch-match.ts`, `render/watches.ts`,
  migration 0034 `watches`, routes `GET /app/watches`, `POST /app/watch/fired`,
  FCM `watches`, `/watches`, the mail check on `/do/tick`, `GmailClient.listIds`.

- 2026-10-13: Block J3: `web.read` — new `tools/web-read.ts`,
  `lookup/web-page.ts`, `platform/html-text.ts`; `ToolContext.pageText`,
  `OfferOptions.webRead`, `cases.web.yaml`. No tables.

- 2026-10-13: Block J2: new `agent/last-selection.ts` (`LastSelections`,
  `mayInherit`), `agent/briefs.ts`, migration 0033 `last_selection`;
  `selectTools(text, offered, inherited)`, `wireTools(names, { brief })`,
  `AgentDeps.onLocalSelection`, `AgentServices.selections`. Fingerprint
  re-pinned; full evals owed.

- 2026-10-13: Block J planned (`docs/plans/block-j.md`); J1 built: a
  refused call repeated in one turn makes the next call text-only, for a
  model with more than 3 calls (`Loop.retryKeys`, `ToolOutcome.retry.code`
  in `agent/loop.ts`). No new modules, tables or prompt change.

- 2026-10-13: First smart screen run in Waze failed twice. (1) The phone's
  accessibility service was off and the `service_off` end went to the
  reminders conversation: now a task's messages answer the confirming message
  (`screen_tasks.in_reply_to`, migration 0032, `ScreenStore.linkLatest`).
  (2) Gemini failed every step on Waze's Compose home screen: an unlabelled
  clickable now borrows its container's label (`ScreenLogic.lender`, app
  0.14.3, installed on the phone; APK in Downloads). Staging deployed (e12ae6d6).

- 2026-10-13: Screen agent follows the conversation: `screen_tasks.mode` and
  `screen_model_day` (migration 0031), `SCREEN_SMART_MODELS` and the
  screen-only `gemini-3.5-flash` (`SCREEN_ONLY_MODELS`), the next model of the
  family within a step, `TokenBudget.isOutForDay`, `ToolContext.smart`; cap
  3 → 10 a day; app 0.14.2 (disclosure names Gemini; APK in Downloads). Plan
  `docs/plans/screen-model-by-mode.md`. Staging deployed (5d807cd8).

- 2026-10-13: Screen agent: `soundOf` hears a word-initial ו or any וו as
  the w/v of an English app name ("וויז" = Waze, "ויבר" = Viber). No new
  modules or tables. Staging deployed
  (109046f7).

- 2026-10-12: First phone run of the screen agent (staging 9c5e9299, app
  0.14.1). Fixed: a routine named for the app hid `screen.task`
  (`selectTools`); "פיד" vs the phone's label "Fid" (`soundOf` in
  `findApp`/`namesScreenTask`); a still-loading app ended the task
  `tree_unusable` (`ScreenRun` reads again up to 6 s); a chat approval left
  the app behind (`released` brings it back, `ScreenOps.inFront`). The run
  reached step 1 (type, held for "ask every tap"), approved, then
  `screen_changed` (the map tab grew chips). The day's 3 calls were spent
  (a refused call counts); `done` on the phone is still owed.

- 2026-10-12: Staging deployed (9643484a) with the screen agent (migration
  0030); the five `/app/screen/*` routes answer 401 unsigned.

- 2026-10-12: Screen agent, phases 1–2 (PLAN §6.28, ROADMAP block I):
  `screen.task`, `tools/screen-store.ts`, `agent/screen-step.ts`,
  `agent/screen-policy.ts`, `render/screen.ts`, migration 0030, routes
  `/app/screen/*`, FCM `screen*`, buttons `sa:`/`ss:`, `pnpm eval:screen`;
  app 0.14.0 (`ScreenLogic`, `ScreenRun`, `ScreenJournal`, allowlist screen).
  CLAUDE.md invariants 2, 3, 5, 10 amended. Not deployed.

- 2026-10-12: Staging deployed (df45a4c6) with Batches 09 (server text) and 14.

- 2026-10-12: Staging deployed (1cf2b868) with Batches 07, 08, 11, 12, 13.
  Batch 09: app 0.13.5 types through the field anchor (`field_changed`),
  «שיחה רגילה» replaces «שיחה מקומית»; APK in Downloads, phone check (M4)
  owed. Batch 14: reminders that ended and audit rows are kept 90 days
  (`purgeSettledBefore`, `purgeAuditBefore` in `runMaintenance`). No tables or
  migrations.

- 2026-10-12: Batch 13 done: `/wa/webhook` reads through `readCapped`
  (bytes, streamed, cancelled at the cap) and signs the bytes; decoded only
  after the HMAC. No new modules or tables.

- 2026-10-12: Batch 12 done: `scrubForModel`/`containsPrivateData` catch
  phones with `.` `/` `()` and non-ASCII email local parts, with dates and
  times masked first (`security/scrub.ts`); provider 500/503/non-JSON tests.
  No new modules or tables.

- 2026-10-12: Batch 11 done: `AgentLock.heldBy`; a `running` turn with no
  live lock answers `unknown` (`duplicateStatus`, `appDeviceResult`); three
  failed pushes in a row set `lastErrorCode` (`Repository.bumpPushFailures`).
  No tables or migrations.

- 2026-10-12: Batch 08 done: run reason `field_changed` on the server
  (`render/routines.ts`); `RoutineLogic.anchorAfter`/`anchoredField` and
  `Pick.FieldChanged` in the app, tested, not wired into runs (Batch 09,
  server deployed first). No tables, migrations or version bump.

- 2026-10-12: Batch 07 done: the turn deadline is an `AbortSignal` that cuts
  the model call and a resolve's or read's requests in flight (new
  `src/tools/turn-signal.ts`, `withSignal` on the Google clients,
  `complete(…, { signal })`); no execute starts after it, a read returned
  after it is dropped, and a write's `execute` never sees it. New
  `test/security/turn-signal-fetch.test.ts` places every `fetch` call site.
  No tables or migrations.

- 2026-10-12: Staging deployed (db0fe6f4) with Batches 05–06 and the calendar's
  past reads. No migration, no app change.

- 2026-10-12: `calendar.list_events` reads past and future with no limit:
  `days_ago`, `last_week`/`this_month`/`last_month`/`next_month`, `month`/`year`
  (read windows in `time/range.ts`); `DateSpec` years from 1970. Catalog
  ~50 tokens larger. No new modules or tables.

- 2026-10-12: Batch 06 done: new `src/agent/limits.ts` (`TURN_DEADLINE_MS`
  60 s, `MAX_WRITE_MS`, `LOCK_TTL_MS` 220 s); `drive` ends `deadline`, which
  the pipeline answers with no parser or read-only try; one `agent_turn` log
  record per loop. M6 (a week of staging, then read `agent_turn`) can start.

- 2026-10-12: Batch 05 done: `errorCodeOf` in `orchestrator.ts` (no error
  text in `errorCode`), new `test/security/error-log-canary.test.ts`, a
  ban-list tripwire, `E_UNCLASSIFIED` and ancestor-only cycle check in
  `redact.ts`. No new modules or tables.

- 2026-10-12: Batch 04 done: a smart suspended turn stores `historySources`
  (`turns.ts`); `mayResend` in `loop.ts` ends a resume whose history or tool
  results hold a source not allowed now (no model call). "This time" = one
  turn (D1), written in `consents.ts` and PLAN §6.19. No new modules or tables. Staging deployed with Batches 02–04 (d76e775c).

- 2026-10-12: Batch 03 done (decisions D1 = placeholder, D2 = yes): history
  entries carry `src` (`history.ts` `provenanceOf`, `replayByConsent`); a
  smart conversation replays a revoked or untagged reply as `[מידע אישי]`.
  No new modules or tables.

- 2026-10-12: Batch 02 done: `evaluated.judging` (`judgingHash` in
  `test/evals/fingerprint.ts`), `deploy:staging` runs the fingerprint and
  new `test/unit/config/release-gate.test.ts` first, runbook "Release gate".
  Eval tooling and config tests only; no bot behaviour change.

- 2026-10-12: `docs/IMPROVEMENT_PLAN.md` + `docs/IMPLEMENTATION_BATCHES.md`
  (review and batches). Batch 01 done: eval exit codes, model id/provider in
  both fingerprints (Groq pins now one per model), recordings keep their
  fingerprint. Eval tooling only; no `src/` change.

- 2026-10-12: App 0.13.4: routine title always RTL; a check waits up to
  60 s (`MAX_WAIT_SECONDS`). Staging deployed (918e1386). On the phone the
  scheduled run from chat gave card, notice and result. Note: installing a
  new APK makes the phone forget "allow opening Fid always".

- 2026-10-12: Routines from chat, a card, numbers (app 0.13.2, migration 0029
  `routine_cards`): `selectTools` gives a routine-only message the routine +
  time tools; `RoutineStore.takeAnnouncements`, `notice_hash`,
  `routine_names.position`; `findRoutine` by number; `routineText.card`.
  No new modules or tools.

- 2026-10-11: Routines, typing (app 0.13.1): `TYPE_TEXT`, `SUBMIT`,
  `RoutineLogic.pickField`; checks skip fields; server wording only
  (`render/routines.ts`). A run starts the app fresh; taps wait up to 10 s
  for their target; the routines screen shows its buttons on two rows.
  Staging deployed (version c3b2cffb). No new modules, tools, tables or
  reason codes.

- 2026-10-11: Routines, stage 2 (+ the core of stage 3): `routine.run`
  (`tools/routines.ts`, Tier 2, private, `refusesTainted`), `tools/routine-store.ts`,
  `render/routines.ts`, migration 0028 (`routine_names`, `routine_runs`), routes
  `/app/routines`, `/app/routine/claim`, `/app/routine/result`, FCM `kind: routine`,
  cancel button `rt:`; app `RoutineRunner.kt`, `RoutineRunActivity.kt`. Offered only
  when a routine is named; Groq fingerprint unchanged (`cases.routines.yaml`).

- 2026-10-11: Routines, stage 1 (app 0.13.0): `RoutineLogic.kt`,
  `RoutineStore.kt`, `RoutineAccessibilityService.kt`, `RoutinesActivity.kt`,
  PLAN §6.27. App only; no server modules, tools or tables changed.

- 2026-10-11: Smart conversations: `private` tools are offered (as in a local
  turn; their replies never reach a model or the history); a required
  `consent` rule per consent-source tool (`always` | `exempt-own-input`,
  `registry.ts`; `consentNeededFor`/`echoesOwnInput` in `agent/consents.ts`):
  six writes that only echo their call run with no card and keep their reply
  in the history; `SMART_NOTE` s2 (TimeSpec keys), `SMART_CATALOG_POLICY` /3.
  Groq fingerprint unchanged. No new modules or tables.

- 2026-10-08: Smart model `gemini-3.5-flash` → `gemini-3.5-flash-lite` (3.5
  Flash's free tier stopped after ~25 requests a day; the user's choice);
  placeholder limits 15/min, 500/day. Agent tool calls: a TimeSpec without
  `meridiem`/`part_of_day` gets 'unspecified' only where that cannot move the
  time (`fillUnstatedTime` in `agent/tools.ts`, `timeWordsNamed` in
  `time/hebrew-lexicon.ts`; PLAN §6.19). Groq fingerprint unchanged. No new
  modules or tables.

- 2026-10-08: Gemini model `gemini-2.5-flash` → `gemini-3.5-flash`
  (`reasoningEffort: 'low'`); Gemini 3 thought signatures kept on
  `ToolCall.signature`, sent back, stored with suspended turns (Groq wire
  unchanged); a smart model's 503/500 rests it on the 429 ladder; eval ledger
  guards a smart model by requests per Pacific day. No new modules or tables.

- 2026-10-08: Smart conversations, slice 6: `smart` flag on the outbox
  response; app 0.12.0 (smart/local choice, badge, mode in body and voice
  path, 422 not retried, DB v4). Server before APK.

- 2026-10-08: Smart conversations, slice 5: the consent gate
  (`agent/consents.ts`, `render/consent.ts`, migration 0027 `agent_turns.kind`
  etc.). In a smart conversation a tool of an unconsented source suspends the
  turn (`kind: 'consent'`) with a card `cs:<queryId>:<nonce>:<once|conv|no>`;
  mail, SMS, contacts and notifications only allow "this time". `/consents`
  lists and revokes. Voice, shared text and the read-only try never suspend.

- 2026-10-08: Smart conversations, slice 4: a smart conversation's own words
  run on `[...smartProviders, ...providers]`; the model is chosen before the
  tools; a smart model gets `SMART_NOTE` (s1), its own caps and no facts. Until
  the consent gate (slice 5) every model in a smart conversation is offered
  public tools only (`smartOfferedTools`), and `settleAgentResult` stores
  placeholders for non-public tool replies and for shared text. Groq
  fingerprint unchanged; `smartFingerprintFor` pins Gemini evals.

- 2026-10-08: Smart conversations, slice 3: a conversation's mode (`smart` |
  `local`) is recorded once inside `recordInbound`'s transaction
  (`conversation_modes`, plus `conversation_consents` for slice 5, both in
  migration 0026); a different mode later gets 422 `mode_mismatch`. Text
  carries `mode` in the body, voice as a path segment. Not used yet.

- 2026-10-08: Smart conversations, slice 2: `SMART_MODELS` (Gemini Flash, role
  `smart`, read-only, not used by any turn yet), `createGeminiAgentProvider`,
  request limits per minute/day in `TokenBudget` (day count in SQLite,
  `core/quota.ts`, migration 0026 `model_day_requests`, Pacific day), 429
  backoff 1/2/5/10 min, optional `GEMINI_API_KEY`. The narrow 429-body
  exception is documented in `agent/provider.ts`.

- 2026-10-08: Smart conversations, slice 1 (plan: Gemini "smart" chats next to
  local Groq ones, a consent gate per data source). Every tool now declares a
  required `dataSource` in the registry; `calendar.move_event`/`delete_event`
  taint; replayed history replies pass `scrubForModel`. No new modules or tables.

- 2026-10-08: `notes.find` answers "פתק 3" with that note; notes keep their
  newest-first number in every list. `resolveDay` (`time/resolve.ts`): reads
  about "today" after noon no longer ask "למתי לקבוע?". No new modules or tables.

- 2026-10-08: Block H part 19: `portfolio.update`/`portfolio.show` (private),
  `lookup/quotes.ts` (Finnhub US, Yahoo TASE), `holding-store.ts`, migration
  0025, `portfolio` as a scheduled topic, `QUOTES_API_KEY` (optional secret).
  Agent wire: number slots are `integer` only with `.int()`.

- 2026-10-07: Block H part 18: `memory.*`, `/memory`, `/forget memory`, facts in
  the agent's user turn (invariant 2 amended), migration 0024, examples after
  "לא הבנתי".

- 2026-10-07: Block H part 17: tool-group unions, `CHARS_PER_TOKEN` 3.0 (measured),
  history fitter, prompt a10, `lists.*` (PLAN §6.25), migration 0023.

- 2026-10-07: Block H part 16: "לא הבנת" / `/missed` / `/misses` (PLAN §6.23).
  New `core/exchanges.ts`, `render/misses.ts`, migration 0022
  (`last_exchange`, `misses`, `inbound_messages.seq`).

- 2026-10-07: Block H planned (seven review rounds); part 15 built: `notes.find`
  strips generic words and never dead-ends; rules-fallback pattern for
  "מה הפתקים שלי". No new modules or tables.

- 2026-10-06: "התראות" also selects the time group (`agent/tool-groups.ts`), so asking
  for active alerts offers `reminders.list`/`cancel` again; sharper
  `phone.notifications` description. Evals owed (PLAN §13).

- 2026-10-06: CI was red since 14:48 on `pnpm audit` only (new advisories in
  tinypool, source-map-js, sharp, vitest). vitest 3 → 4.1.11 (drops tinypool),
  pnpm overrides for `source-map-js` and `sharp`. No source code changed.

- 2026-10-06: Block F, server side of part 11 and 12: `reminders.leave`
  ("time to leave" for a calendar event, a Waze card on delivery) and text
  shared into the app (`channels/app/shared.ts`, tainted, skips the
  deterministic shortcuts in `pipeline.ts`). Migration 0021.
- 2026-10-06: Block F finished: agent prompt a9 (one sentence for
  `reminders.leave`); `lv-` evals 4/4 on gpt-oss-120b; app 0.11.0 — share
  target, default assistant (`ACTION_ASSIST`), tap-to-talk, home-screen
  widget.

- 2026-10-06: Added HANDOFF.md (imported by CLAUDE.md), ARCHITECTURE.md,
  README.md. PLAN §8 now points to ARCHITECTURE.md. No code changed.

- 2026-10-06: Stop hook `.claude/hooks/docs-guard.mjs` enforces the update
  rule below.

- 2026-10-06: Block E (contacts grant, bills, call log, missed calls in the
  digest, Spotify, Waze to a contact or event). Migration 0020, app 0.10.0.

- 2026-10-06: SETUP.md — every step from zero for a newcomer (and their AI).
  README: Contacts, migration 0020, pre-commit hook note. No code changed.
