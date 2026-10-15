# HANDOFF — read this first

The single entry point for a new session. Dense on purpose: it says what the
system is, where things live, and what breaks easily, then links out. It does
**not** repeat the rules in `CLAUDE.md` (always loaded) or the spec in
`PLAN.md` (read by section, never whole).

_Last updated: 2026-10-15 · server at migration 0039 · agent prompt a10 + smart note s2 + screen step s2 · parser prompt v6 · app 0.20.0 in progress (0.19.0 built, 0.18.2 on the phone) · smart model gemini-3.5-flash-lite · vision v1_

## 1. What this is

A single-user personal assistant (reminders, Google Calendar/Tasks/Gmail/Drive/
Contacts birthdays, phone actions and reads, public lookups, notes, lists, facts, a stock portfolio, expenses). Hebrew first, English works.

- **Server:** TypeScript on Cloudflare Workers Free + **one** SQLite-backed
  Durable Object (`AssistantDO`). $0 recurring cost is priority #1 (PLAN §1).
- **Client:** the Android app in `apps/call-companion/` (Kotlin, same repo,
  own Gradle build). WhatsApp still exists in code but is frozen behind
  `CHANNEL` (staging `app`, production `whatsapp`).
- **LLM:** Groq free tier. A bounded tool-calling **agent** (`AGENT=on`) with
  the single-shot **parser** as fallback. Models: `qwen3.8-27b` (primary, may
  write) and `gpt-oss-120b` (backup, read-only) — `src/agent/models.ts`.
- **Smart conversations** (2026-10-08, PLAN §6.19): a conversation opened as
  smart tries **Gemini's free tier** first (`SMART_MODELS`, `gemini-3.5-flash-lite`,
  needs `GEMINI_API_KEY`), then qwen (also while Gemini rests after a 503/500). Gemini may train on what it gets, so the
  user's data reaches it only for a source allowed on a consent card (writes
  that only echo the user's own call never ask, and private tools are offered
  but never answer to a model; 2026-10-11). Local conversations are unchanged
  and never reach Gemini.
- **Screen agent** (2026-10-12, PLAN §6.28): `screen.task` does one task
  inside one app the user turned on, reading its screen as text. The phone is
  eyes and hands; each step is one model call on the server, in the family of
  the conversation the task was confirmed in (2026-10-13): a regular one asks
  qwen then gpt-oss-120b (Groq), a smart one Gemini Flash-Lite then 3.5 Flash,
  never crossing. 10 tasks a day; each Groq model gives the screen at most 50K
  tokens a day. Code stops before every sensitive or uncertain tap.
- **Images** (2026-10-14, PLAN §6.32): an image sent with a request is
  shared text one step earlier. One read call to Gemini Flash-Lite (in every
  conversation: the Groq key has no vision model; needs `GEMINI_API_KEY`)
  turns it into text, quoted under the request as someone else's words:
  tainted, every write confirms, the local models run the turn. Only the
  image reaches Gemini; the first answer says so once. Never stored or logged.

## 2. The one idea

**The model proposes, code decides.** Every tool call or parsed draft goes
strict Zod → weekday check → `resolve` (code computes time, code finds
targets) → policy (tier) → confirm → execute → reply rendered by code.
Details: CLAUDE.md invariants 1–13, PLAN §3.1, §6.19.

## 3. Request path (app channel)

```
app ─signed HTTPS─► Worker src/index.ts (route, size cap, forward bytes)
  └► AssistantDO src/platform/assistant-do.ts (signature, device, nonce, dedupe)
      └► pipeline src/core/pipeline.ts
           commands / buttons / open question  → deterministic, no LLM
           text → agent src/agent/loop.ts  (reads may loop; any write ends turn)
                smart conversation: Gemini first, consent card per data source
                └ fallback: parser src/nlu/ → orchestrator src/core/orchestrator.ts
           reply → outbox src/channels/app/outbox.ts (+ HTTP response)
alarm()/cron → reminders, digest, scheduled reads → outbox → FCM push
```

Full map with every module: [ARCHITECTURE.md](ARCHITECTURE.md).

## 4. If you touch X, be careful with Y

| You touch | Watch out for |
|---|---|
| a tool (`src/tools/`) | Use the `add-tool` skill. Registry → one group in `agent/tool-groups.ts` → eval cases. Changing groups changes the eval fingerprint (`test/evals/fingerprint.ts`). New Google scope = stop and ask. |
| a tool's `dataSource` (required in `registry.ts`) | A consent source, `public` or `private`, chosen by what its replies may carry (card, candidate list, Undo included), **not** by read/write: `reminders.leave` and `nav.go` are `calendar`. It decides the consent card, the smart catalog and the history placeholder. Unsure → stop and ask. |
| a tool's `consent` rule (required with a consent source, 2026-10-11) | `always`, or `exempt-own-input` — no consent card, reply kept in the smart history — **only** if every reply path (success, question, choice list, confirm card, Undo, refusals, errors) holds nothing but the call's own arguments, code-computed dates/times and fixed strings. Prove it from `resolve`/`preview`/`execute`/render code and add it to the pinned list in `test/unit/tools/data-source.test.ts` and `smart-own-input.test.ts`; a reply that names a found record, list, contact or count stays `always`. Unsure → `always`. |
| smart conversations / the consent gate | History is written only by `settleAgentResult` (the one `history.append`, which tags each entry's `src`) and filtered by current consent at the one read (`replayByConsent` in `pipeline.ts`, 2026-10-12): never write or replay history elsewhere. A smart suspended state carries `historySources`, and a resume goes through `mayResend` (`loop.ts`): a new resume path must too. Never offer an unconsented source on a turn that cannot suspend — voice, shared text, the read-only try. Private tools are offered there (their replies never reach a model or the history). `SMART_MODELS` never joins `MODELS`. Consent taps are code only (`beginConsent`, one transaction, before any await). |
| `src/agent/budget.ts` `CHARS_PER_TOKEN` | Measured, not guessed: refresh `test/fixtures/token-calibration.json` from a real run (`scripts/calibration-sample.ts` overwrites it: merge, don't replace) and keep the 99% test green. Too low and messages that name no tool group fail the turn cap. |
| `src/agent/` prompt, catalog, models | `pnpm eval:agent` (use `--filter`; a full run can burn a model's daily 200K tokens). `canWrite` in `models.ts` changes only after a human reads an eval report. |
| `src/nlu/` | `pnpm eval`; "no invented slots" and "missing-slot detection" must stay 100%. The parser catalog is pinned to `PARSER_TOOL_NAMES` — new tools are agent-only. |
| anything a model can read | Pass it through `scrubForModel`; decide **taint** (text someone else wrote → every resulting write CONFIRMs). A `terminal` read or a card still taints through `TAINTING_TOOLS` / `Reply.tainting` (fixed 2026-10-06). A tool whose `resolveAsync` finds someone else's words (a calendar title in `reminders.leave`) sets `ResolveOutcome.tainting`, carried onto the reply (2026-10-06). Private tools (`notes.*`, `lists.*`, `portfolio.*`) never reach the model or history. Facts (`memory.*`) are the opposite on purpose: the model sees them every turn, so `containsPrivateData` must refuse anything it must not see (PLAN §6.26). |
| `pipeline.ts` return paths, `core/exchanges.ts` | Only turns that reached a model write `last_exchange` (via `respondWithModels` and `resumeFromPhone`); commands, confirmations, answers and the busy reply must not. Never hand `ExchangeLog` to the agent (PLAN §6.23). |
| time/date logic | Only `src/time/resolve.ts` (forward), `src/time/past-day.ts` (expenses, backward) or the calendar read windows in `src/time/range.ts` (either way, 2026-10-12). DST: next fall-back 2026-10-25. Never default a missing time. |
| routines (`tools/routine*.ts`, `routine_runs`) | A run moves one way, one conditional `UPDATE` at a time; the claim is the only thing that lets the phone run it, once, on time, with the confirmed step hash. Never retry a claimed run. `routine.run` is offered only when `namesRoutine` says so — never add it to the full catalog. Reason codes are closed on both sides (`RUN_REASONS` ↔ the app's `RoutineRunner`). PLAN §6.27. |
| the learning journal (`core/learn-store.ts`, `/learn`, block K) | Never give `LearnStore` to the agent or a model. A proposal applies only through a command's own setter, in `answerProposal`'s one transaction; a new `PROPOSAL_KINDS` entry needs its command first (and the migration's CHECK). A new command kind goes into `router.ts` `COMMAND_KINDS` (it fails to compile otherwise), or it would count as a habit. The export only through `scrubForModel` and `fitRecords`' byte cap. A new kind needs a `KIND_SINCE` entry, a `LEARN_NOTICE_VERSION` bump and its notice line (`render/learn.ts`, tested): nothing is collected before its notice is delivered. Every computation reads from `startOf(feature)`, never earlier. Plan `docs/plans/block-k.md` (K1 build notes win). |
| a migration | Add `migrations/00NN_*.sql` **and** register it in `src/platform/migrations.ts`. Backward-compatible for one version. |
| the stored-PIN unlock (the app's `UnlockLogic.kt`, `UnlockStore.kt`) | Routines only, never a screen task. The PIN never leaves the phone; the claim comes before the unlock; one attempt until the PIN is saved again. `dispatchGesture` and `GLOBAL_ACTION_LOCK_SCREEN` live only in `press`/`relock` (`UnlockScanTest`). PLAN §6.27. |
| the screen agent (`tools/screen*.ts`, `agent/screen-*.ts`, the app's `Screen*.kt`) | Read `docs/plans/screen-agent.md` first. The word lists live in code on both sides and must equal `test/fixtures/screen-policy.json` (a test on each side). Every status move is one conditional UPDATE; never retry an action — a `started` journal entry is `uncertain`. Screen text is never stored, logged or put in history, and goes only to the task's family: `SCREEN_MODELS` (Groq) for `mode: 'local'`, `SCREEN_SMART_MODELS` (Gemini) for `'smart'` — the mode rides in the confirmed input and the task row, never re-read from the turn. A Groq model's screen share is `SCREEN_GROQ_DAY_TOKENS`. `screen.task` is offered only when named: never add it to the full catalog. A step prompt change is `pnpm eval:screen`. |
| images (`vision/read-image.ts`, `handleImage`, `/app/image`) | Read `docs/plans/image-input.md`. The read text goes only through `handleImage`'s synthetic text event (`forwarded: true`): never widen `respondToText` to take the image, never hand `data` past it. `VISION_MODELS` is Gemini only (the user's choice: no Groq vision model on the key), never Gemini Flash (the screen's 20 a day); without the Gemini key images are "not available", never Groq. Only the image goes to it, never the request. `MAX_IMAGE_BYTES` equals `Protocol.MAX_IMAGE_BYTES` in the app. The base64 check is a negated class on purpose (CPU). A prompt change bumps `VISION_PROMPT_VERSION`. |
| `src/channels/app/parse.ts` or the wire protocol | The app has a matching `Protocol.kt` with test vectors. **Deploy the server before installing a new APK**, or the old server rejects the new app. |
| a Tier 0–1 write's `execute` that calls Google (or the turn deadline) | The enumeration in `src/agent/limits.ts`: more sequential `GoogleApi.call`s than `MAX_WRITE_CALLS` means raising it, or the lock can expire under a running write. `TURN_DEADLINE_MS` is provisional (M6). |
| outbound `fetch` | Call `fetch` through a closure, never `this.fetchImpl(...)` — Workers throws "Illegal invocation" (tests use `test/integration/workers-fetch.ts` to catch it). A new call site must be placed in `test/security/turn-signal-fetch.test.ts`; one a tool reaches takes the turn signal (`AbortSignal.any`), and a new network client on `ToolContext` is bound in `tools/turn-signal.ts`. |
| Cloudflare APIs | Only inside `src/platform/`. The ban-list test enforces it. |
| logging | Only `src/security/redact.ts`. Log canary tests must stay green. |
| Groq budget | 8K tokens/min, 200K/day **per model**; the daily limit is in no header. Measured, not guessed: `scripts/bench-tokens.ts`. |

## 5. Commands

`pnpm typecheck && pnpm lint && pnpm test` before calling anything done.
`pnpm eval` / `pnpm eval:agent [--filter p-] [--resume] [--select-tools] [--model <id>]` (a `SMART_MODELS` id runs as a smart turn and needs `GEMINI_API_KEY` in `.dev.vars`).
`eval:agent` exits 0 only for a complete pass, 1 on a gate miss, 2 when incomplete; a recording from another environment is refused (header of `test/evals/run-agent-evals.ts`).
`pnpm deploy:staging` at the end of every task that changes server code (standing approval, 2026-10-13). Production, secrets, rollback: human only.
App: `cd apps/call-companion && ./gradlew testDebugUnitTest`.
Network on the hotspot: `NODE_OPTIONS=--dns-result-order=ipv4first` for wrangler.

## 6. Where the current work is

- **Routines** (PLAN §6.27, plan `docs/plans/routines.md`): "open the
  attendance app in 15 minutes and tap כניסה". Stages 1–2 and the core of 3
  are built (app 0.13.0, migration 0028, decisions D1–D4 approved); app
  0.13.1 adds typing a fixed text and the keyboard's Enter ("open FID and
  search סטימצקי", plan `docs/plans/routines-typing.md`). Staging is deployed
  (2026-10-11), 0.13.1 is on the phone. App 0.17.0 (2026-10-13, plan
  `docs/plans/routine-auto-unlock.md`): an opted-in routine unlocks a
  PIN-locked phone with a PIN stored on the phone only, then locks it
  again; 0.17.3 is installed and passed the full run on the phone (2026-10-13). Next, a separate
  plan: the bot builds a routine on request and explains it (the user's
  wish, 2026-10-11 — it changes "never written by a model", PLAN §6.27): the
  dry run passed on the real attendance app (exit, 2026-10-11). Server
  and app: staging is current (migration 0029); app 0.13.5 (field anchor, Batch 09) is built and waits for its phone check (M4); the phone has 0.13.4. Owed in PLAN §13: a first real
  scheduled run.
- **Smart conversations** (PLAN §6.19, plan
  `~/.claude/plans/abundant-wobbling-sparkle.md`): built, slices 1–6, server
  and app 0.12.0. Model `gemini-3.5-flash-lite` since 2026-10-08, the
  user's choice: 3.5 Flash's free tier stopped after ~25 requests a day,
  2.5 Flash is closed to new users, 3.7/3.8 often 503 — revisit. Its
  `minuteRequests` 15 / `dayRequests` 500 are unmeasured guesses. Needs, in
  order: the human confirms the Gemini model id in AI Studio,
  `pnpm eval:agent --model gemini-3.5-flash-lite` and a human read of it,
  a staging deploy (done 2026-10-11), the human sets `GEMINI_API_KEY`
  (`wrangler secret put GEMINI_API_KEY --env staging`), and only then the
  0.12.0 APK — **server first**: an older server refuses the `mode` field.
  2026-10-11: private tools offered, own-input writes never ask, smart note
  s2 — its `--filter` evals are owed. Open items in PLAN §13 (limits probe,
  Gemini calibration, s2 evals).
- **Screen agent** (PLAN §6.28, plan `docs/plans/screen-agent.md`, ROADMAP
  block I): phases 1–2 built (server migration 0030, app 0.14.1 on the phone; 2026-10-13: migration 0031 and app 0.14.2 — models by conversation, 10 a day — staging deployed 5d807cd8, APK in Downloads; then migration 0032 and app 0.14.3 — Compose container labels, messages in the task's conversation — staging deployed e12ae6d6); staging
  deployed 2026-10-12 (9643484a). Owed, in order (PLAN §13): `pnpm eval:screen`
  and `eval:agent --filter scr-` on qwen with a human read, then the 0.14.0
  APK and the phone checks. Phase 3 needs its own plan.
- **Block J** (2026-10-13, plan `docs/plans/block-j.md`, ROADMAP block J):
  seven free ideas from OpenClaw, J1–J7, one commit each, in order. J1 done
  (a repeated refused call makes the next call text-only, Gemini only). J2
  done (migration 0033 `last_selection`, `agent/briefs.ts`): the Groq
  fingerprint moved, so a full `eval:agent` on qwen and gpt-oss-120b (with
  `--resume`, and `--select-tools` on qwen) is owed before anything gates.
  J3 done (`web.read`, PLAN §6.29): evals `--filter wr-` and `inj-web-001`
  and a CPU check in `wrangler dev` owed. J4 (PLAN §6.30): server built
  (migration 0034) and app 0.15.0 (`Watches.kt`, `WatchMatcher.kt`):
  **server first**, then the APK; `eval:agent --filter wh-` and the phone
  check owed. J5 done (digest conflicts and bills, `/digest conflicts|bills
  on|off`, off by default). J6 done (app 0.16.0, spoken replies to voice
  notes, off by default). J7 done (a fact said twice is kept once). **Block
  J is built.** Owed: the full `eval:agent` on both models (J2; qwen stopped
  at 29/324 on 2026-10-13, `--resume`), `--filter wr-`, `wh-`, `inj-web-001`,
  Staging deployed 2026-10-13 (8e7e006c, migrations 0033–0034; the two
  watch routes answer 401 unsigned); APK 0.16.0 in Downloads, not yet
  installed, then the phone checks.
  The plan's "Additions" and "Follow-up" sections win over the part sections.
- **Block K** (2026-10-14, plan `docs/plans/block-k.md`, PLAN §6.31): the bot
  learns the user. **Built, K1–K4.** K1 (migration 0035, `/learn`): the
  journal, off by default, collected only after its notice is delivered. K2
  (migration 0036): the weekly review Sunday from 10:00, `lp:` proposals,
  `/leave`. K3: `GET /app/learn/export`, app 0.18.0 (APK in Downloads; **server
  first**). K4: `scripts/learn-to-evals.ts`, the `learn-review` skill,
  `docs/learn-log.md`. Owed: the phone checks (PLAN §13) and the export's CPU
  in `wrangler dev`.
- **Images** (2026-10-14, PLAN §6.32, plan `docs/plans/image-input.md`):
  built, server and app 0.19.0 (📎 and a share target for images; staging
  deployed, so the APK in Downloads can be installed). Owed (PLAN §13): the
  phone check (with `GEMINI_API_KEY` set on staging), the CPU of a full image
  in `wrangler dev`. "Make it a routine" waits for the plan where
  the bot builds a routine.
- **Block L** (2026-10-15, plan `docs/plans/block-l.md`, reviewed in many
  rounds; WhatsApp reading was removed from it by the user): five ideas from
  the Instinct comparison, L2–L6 in order, one commit each. **L2 done**: mail
  follow-ups (`mail.follow_up`, PLAN §6.33, migration 0037, `/followups`,
  `fu:` buttons). **L3 done**: calendar suggestions (PLAN §6.34, migration
  0038, `/suggest on|off`, `sg:` buttons, `reminders.event_id`). **L4 done**:
  the monthly file (PLAN §6.35, migration 0039, `expenses.monthly_pack`,
  `/monthly on|off`). Next: L5 (archive + `/unarchive`, new scope `gmail.modify`:
  the user reconnects Gmail), L6 (`docs.create`, new scope `drive.file`).
  The plan's two shared rules (scheduled notices: read, then row + outbox in
  one transaction; taps: row + card in one transaction) bind L2–L4. App
  0.20.0 (command list, later the Markdown file card) is built once at the
  end of the block. Owed: `eval:agent --filter fu-` and `--filter mp-`; the staging deploys (L2–L4).
- **Next work:** [ROADMAP.md](ROADMAP.md) (Hebrew) — block H (2026-10-07):
  a smarter bot. Parts 15 (notes), 16 ("לא הבנת" capture), 17 (tool
  unions, calibrated token estimate, history fitter, named lists) and 18
  (facts the model sees, PLAN §6.26) and 19 (the stock portfolio, PLAN
  §6.24: Finnhub for US with `QUOTES_API_KEY`, set on staging; Yahoo for
  TASE) are done. Block H is built and on staging (2026-10-11). Open: the
  full catalog goes brief (block J2b), pinned at ≤ 5,750 tokens in
  `test/unit/agent/fit.test.ts` (5,710 measured 2026-10-13) — measure before
  adding tools (PLAN §13), and evals on prompt a10 are owed (PLAN §13). The full reviewed plan: `docs/plans/block-h.md` (read
  the part you build). Block G waits behind it.
- Block F is done (share to the bot, default assistant,
  widget, "time to leave"); it needs a deploy and the 0.11.0 APK — **server
  first**: an older server refuses the `shared` field. Block E still needs
  `/connect contacts` and the call-log permission on the phone.
- **Owed / open decisions:** PLAN §13 (unchecked items) — e.g. `lv-` and a
  full `eval:agent` run on a9 for qwen, qwen `--select-tools` fingerprint,
  token calibration.
- **Latest decisions:** last rows of PLAN §14.

## 7. Docs map — what to read when

| Doc | Read when |
|---|---|
| `CLAUDE.md` | Always (auto-loaded). Rules and invariants. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Before changing code across modules; to find where something lives. |
| `PLAN.md` | Only the section you need. §6.x = component spec, §7 = security, §11 = tests/evals, §13 = open, §14 = decisions log. ~2,900 lines: never read whole. |
| [ROADMAP.md](ROADMAP.md) | Starting the next feature block. |
| `docs/plans/routines.md` | Routines (PLAN §6.27): the reviewed plan, stages and decisions D1–D4. |
| `docs/plans/block-h.md` | Building a block H part: the reviewed plan, by part. |
| `docs/plans/block-k.md` | The learning journal (PLAN §6.31): the reviewed plan, K1–K4, and the K1 and K2–K4 build notes. |
| `.claude/skills/learn-review/SKILL.md` | The user hands over a learning export (`bot-learn-*.json`). |
| `docs/plans/image-input.md` | Images (PLAN §6.32): the reviewed plan, decisions D1–D3. |
| `docs/plans/screen-agent.md` | The screen agent (PLAN §6.28): the build spec (wire protocol, elements, binding, risk policy, journal) and the reviewed plan. |
| `ops/runbook.md` | Routes, crons, chat commands, deploy, diagnosing. Other `ops/*.md`: secret rotation, token revoke, restore. |
| `apps/call-companion/README.md` | Anything in the Android app or the app ↔ server protocol. |
| `.claude/skills/add-tool/SKILL.md` | Adding or changing a tool. |
| [README.md](README.md) | Human-facing overview (GitHub page). |
| [SETUP.md](SETUP.md) | Setting up a new copy from zero: accounts, Groq key, models, secrets, deploy, app, AI agent. |

## 8. Session log (docs)

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

**Update rule:** when a session changes architecture, a version, the next
block, or a doc's role, update §1/§6/§7 here (and ARCHITECTURE.md if modules,
tools, tables or coupling changed) in the same commit. Enforced by the Stop
hook: code/schema/config/ROADMAP changed this session but neither doc did →
it asks once. Update, or state in one line why nothing is affected.
