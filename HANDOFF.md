# HANDOFF — read this first

The single entry point for a new session. Dense on purpose: it says what the
system is, where things live, and what breaks easily, then links out. It does
**not** repeat the rules in `CLAUDE.md` (always loaded) or the spec in
`PLAN.md` (read by section, never whole).

_Last updated: 2026-10-15 · server at migration 0041 · agent prompt a10 + smart note s2 + screen step s2 + routine draft rd1 · parser prompt v6 · app 0.20.1 on the phone (image attach fix), 0.21.0 built (save a screen task as a routine) · smart model gemini-3.5-flash-lite · vision v1_

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
| routines (`tools/routine*.ts`, `routine_runs`) | A routine is saved only by the user on the phone after a dry run; a recorded or model-drafted one is synced `tested: false` and `routine.run` refuses it until one attended full run (PLAN §6.27, 2026-10-15). `routine.draft` (`routine-draft*.ts`, `agent/routine-draft.ts`): every text in a draft is a scanned element or a confirmed word (`checkDraft`); the steps cross in one response, never stored or logged; each draft status move is one conditional `UPDATE`; offered only with `namesRoutineBuild` and the `routine_draft` cap, never in the full catalog; a prompt change bumps `ROUTINE_DRAFT_PROMPT_VERSION` and is `pnpm eval:screen --draft`. A run moves one way, one conditional `UPDATE` at a time; the claim is the only thing that lets the phone run it, once, on time, with the confirmed step hash. Never retry a claimed run. `routine.run` is offered only when `namesRoutine` says so — never add it to the full catalog. Reason codes are closed on both sides (`RUN_REASONS` ↔ the app's `RoutineRunner`). PLAN §6.27. |
| the learning journal (`core/learn-store.ts`, `/learn`, block K) | Never give `LearnStore` to the agent or a model. A proposal applies only through a command's own setter, in `answerProposal`'s one transaction; a new `PROPOSAL_KINDS` entry needs its command first (and the migration's CHECK). A new command kind goes into `router.ts` `COMMAND_KINDS` (it fails to compile otherwise), or it would count as a habit. The export only through `scrubForModel` and `fitRecords`' byte cap. A new kind needs a `KIND_SINCE` entry, a `LEARN_NOTICE_VERSION` bump and its notice line (`render/learn.ts`, tested): nothing is collected before its notice is delivered. Every computation reads from `startOf(feature)`, never earlier. Plan `docs/plans/block-k.md` (K1 build notes win). |
| a migration | Add `migrations/00NN_*.sql` **and** register it in `src/platform/migrations.ts`. Backward-compatible for one version. |
| the stored-PIN unlock (the app's `UnlockLogic.kt`, `UnlockStore.kt`) | Routines only, never a screen task. The PIN never leaves the phone; the claim comes before the unlock; one attempt until the PIN is saved again. `dispatchGesture` and `GLOBAL_ACTION_LOCK_SCREEN` live only in `press`/`relock` (`UnlockScanTest`). PLAN §6.27. |
| the screen agent (`tools/screen*.ts`, `agent/screen-*.ts`, the app's `Screen*.kt`) | Read `docs/plans/screen-agent.md` first. The word lists live in code on both sides and must equal `test/fixtures/screen-policy.json` (a test on each side). Every status move is one conditional UPDATE; never retry an action — a `started` journal entry is `uncertain`. Screen text is never stored, logged or put in history, and goes only to the task's family: `SCREEN_MODELS` (Groq) for `mode: 'local'`, `SCREEN_SMART_MODELS` (Gemini) for `'smart'` — the mode rides in the confirmed input and the task row, never re-read from the turn. A Groq model's screen share is `SCREEN_GROQ_DAY_TOKENS` (a routine draft's tokens count against it too). An open routine draft blocks a new task, and a due routine preempts a draft (`DraftStore.preempt`) beside the tasks. `screen.task` is offered only when named: never add it to the full catalog. A step prompt change is `pnpm eval:screen`. Phase 3 (a task saved as a routine, app only): the draft stays in memory (`RoutineDrafts`), never in storage, and Save stays gated by a dry run of the same `stepHash`; a new spoil code goes into `RoutineRecording.SPOIL_REASONS` and `spoiledText` (tested). |
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
  again; 0.17.3 is installed and passed the full run on the phone (2026-10-13). The bot
  building a routine is now its own split plan, `docs/plans/routine-builder.md`
  (the rule "never written by a model" was amended 2026-10-15, PLAN §6.27; see
  below): the
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
  APK and the phone checks. Phase 3 (save a screen task as a routine, plan
  `docs/plans/routine-from-screen-task.md`): **built** (2026-10-15, app
  0.21.0, no server change; APK in Downloads): the recorder, the draft in
  memory (30 min), the notifications, the review screen with the dry-run
  `stepHash` gate, and "מה היא עושה?" for every routine. Owed (PLAN §13):
  the phone check, after M4.
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
- **The bot builds routines** (2026-10-15, plan `docs/plans/routine-builder.md`,
  split: one part per session; PLAN §6.27 amended): watch me (the phone records
  the user's taps) and tell the bot (a model drafts from the words and the
  app's first screen). **Part 1 (server) done**: `routine.draft` (offered only
  with the build words and the app's `routine_draft` cap), `routine_drafts`
  (migration 0041), `/app/routine/draft/claim|screen|result`, prompt `rd1` on
  `DRAFT_MODELS` / `DRAFT_SMART_MODELS`, and `tested` on the routine sync
  (`routine.run` refuses an untested routine); staging d6619ae6. Next: part 2 (watch me, app
  0.22.0), then part 3 (tell the bot, app 0.23.0). Owed (PLAN §13):
  `eval:screen --draft` on qwen and Flash-Lite, the CPU of a screen post.
- **Block L** (2026-10-15, plan `docs/plans/block-l.md`, reviewed in many
  rounds; WhatsApp reading was removed from it by the user): five ideas from
  the Instinct comparison, L2–L6 in order, one commit each. **L2 done**: mail
  follow-ups (`mail.follow_up`, PLAN §6.33, migration 0037, `/followups`,
  `fu:` buttons). **L3 done**: calendar suggestions (PLAN §6.34, migration
  0038, `/suggest on|off`, `sg:` buttons, `reminders.event_id`). **L4 done**:
  the monthly file (PLAN §6.35, migration 0039, `expenses.monthly_pack`,
  `/monthly on|off`). **L5 done**: mail cleanup (PLAN §6.36, migration 0040,
  `mail.archive`, `/unarchive`, scope `gmail.modify`: after the deploy the
  user runs `/connect gmail` once). **L6 done**: documents (`docs.create`,
  PLAN §6.37, scope `drive.file`, a Markdown file card; after the deploy the
  user runs `/connect drive` once). **Block L is built.**
  The plan's two shared rules (scheduled notices: read, then row + outbox in
  one transaction; taps: row + card in one transaction) bind L2–L4. App
  0.20.0 (the four commands and the Markdown file card) — **server first**.
  Staging deployed (06b52872, L2–L6). Owed: the APK 0.20.0 install (server first, done); `eval:agent --filter fu-`,
  `mp-`, `ma-` and `doc-`; `/connect gmail` and `/connect drive` for the new
  scopes; the staging check that a created Doc holds its body.
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
| [docs/session-log.md](docs/session-log.md) | History of a change (dated entries, newest first). |
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

## 8. Session log

Moved to [docs/session-log.md](docs/session-log.md) (newest first) so this file
stays cheap to load. **Add the new dated entry at the top of that file**, and keep
only the status line, §1, §4 and §6 here. Read the log only when you need the
history of a change.

**Update rule:** when a session changes architecture, a version, the next
block, or a doc's role, update §1/§6/§7 here (and ARCHITECTURE.md if modules,
tools, tables or coupling changed) in the same commit. Enforced by the Stop
hook: code/schema/config/ROADMAP changed this session but neither doc did →
it asks once. Update, or state in one line why nothing is affected.
