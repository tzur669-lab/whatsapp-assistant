# HANDOFF — read this first

The single entry point for a new session. Dense on purpose: it says what the
system is, where things live, and what breaks easily, then links out. It does
**not** repeat the rules in `CLAUDE.md` (always loaded) or the spec in
`PLAN.md` (read by section, never whole).

_Last updated: 2026-10-08 · server at migration 0027 · agent prompt a10 + smart note s1 · parser prompt v6 · app 0.12.0 · smart model gemini-3.5-flash-lite_

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
  user's data reaches it only for a source allowed on a consent card. Local
  conversations are unchanged and never reach Gemini.

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
| smart conversations / the consent gate | The history gate is `settleAgentResult` only (the one `history.append`): never write history elsewhere. Never offer an unconsented source on a turn that cannot suspend — voice, shared text, the read-only try. `SMART_MODELS` never joins `MODELS`. Consent taps are code only (`beginConsent`, one transaction, before any await). |
| `src/agent/budget.ts` `CHARS_PER_TOKEN` | Measured, not guessed: refresh `test/fixtures/token-calibration.json` from a real run (`scripts/calibration-sample.ts` overwrites it: merge, don't replace) and keep the 99% test green. Too low and messages that name no tool group fail the turn cap. |
| `src/agent/` prompt, catalog, models | `pnpm eval:agent` (use `--filter`; a full run can burn a model's daily 200K tokens). `canWrite` in `models.ts` changes only after a human reads an eval report. |
| `src/nlu/` | `pnpm eval`; "no invented slots" and "missing-slot detection" must stay 100%. The parser catalog is pinned to `PARSER_TOOL_NAMES` — new tools are agent-only. |
| anything a model can read | Pass it through `scrubForModel`; decide **taint** (text someone else wrote → every resulting write CONFIRMs). A `terminal` read or a card still taints through `TAINTING_TOOLS` / `Reply.tainting` (fixed 2026-10-06). A tool whose `resolveAsync` finds someone else's words (a calendar title in `reminders.leave`) sets `ResolveOutcome.tainting`, carried onto the reply (2026-10-06). Private tools (`notes.*`, `lists.*`, `portfolio.*`) never reach the model or history. Facts (`memory.*`) are the opposite on purpose: the model sees them every turn, so `containsPrivateData` must refuse anything it must not see (PLAN §6.26). |
| `pipeline.ts` return paths, `core/exchanges.ts` | Only turns that reached a model write `last_exchange` (via `respondWithModels` and `resumeFromPhone`); commands, confirmations, answers and the busy reply must not. Never hand `ExchangeLog` to the agent (PLAN §6.23). |
| time/date logic | Only `src/time/resolve.ts` (forward) or `src/time/past-day.ts` (expenses, backward). DST: next fall-back 2026-10-25. Never default a missing time. |
| a migration | Add `migrations/00NN_*.sql` **and** register it in `src/platform/migrations.ts`. Backward-compatible for one version. |
| `src/channels/app/parse.ts` or the wire protocol | The app has a matching `Protocol.kt` with test vectors. **Deploy the server before installing a new APK**, or the old server rejects the new app. |
| outbound `fetch` | Call `fetch` through a closure, never `this.fetchImpl(...)` — Workers throws "Illegal invocation" (tests use `test/integration/workers-fetch.ts` to catch it). |
| Cloudflare APIs | Only inside `src/platform/`. The ban-list test enforces it. |
| logging | Only `src/security/redact.ts`. Log canary tests must stay green. |
| Groq budget | 8K tokens/min, 200K/day **per model**; the daily limit is in no header. Measured, not guessed: `scripts/bench-tokens.ts`. |

## 5. Commands

`pnpm typecheck && pnpm lint && pnpm test` before calling anything done.
`pnpm eval` / `pnpm eval:agent [--filter p-] [--resume] [--select-tools] [--model <id>]` (a `SMART_MODELS` id runs as a smart turn and needs `GEMINI_API_KEY` in `.dev.vars`).
`pnpm deploy:staging` only with approval. Production, secrets, rollback: human only.
App: `cd apps/call-companion && ./gradlew testDebugUnitTest`.
Network on the hotspot: `NODE_OPTIONS=--dns-result-order=ipv4first` for wrangler.

## 6. Where the current work is

- **Smart conversations** (PLAN §6.19, plan
  `~/.claude/plans/abundant-wobbling-sparkle.md`): built, slices 1–6, server
  and app 0.12.0. Model `gemini-3.5-flash-lite` since 2026-10-08, the
  user's choice: 3.5 Flash's free tier stopped after ~25 requests a day,
  2.5 Flash is closed to new users, 3.7/3.8 often 503 — revisit. Its
  `minuteRequests` 15 / `dayRequests` 500 are unmeasured guesses. Needs, in
  order: the human confirms the Gemini model id in AI Studio,
  `pnpm eval:agent --model gemini-3.5-flash-lite` and a human read of it,
  a staging deploy (approval), the human sets `GEMINI_API_KEY`
  (`wrangler secret put GEMINI_API_KEY --env staging`), and only then the
  0.12.0 APK — **server first**: an older server refuses the `mode` field.
  Open items in PLAN §13 (limits probe, Gemini calibration, consent on writes).
- **Next work:** [ROADMAP.md](ROADMAP.md) (Hebrew) — block H (2026-10-07):
  a smarter bot. Parts 15 (notes), 16 ("לא הבנת" capture), 17 (tool
  unions, calibrated token estimate, history fitter, named lists) and 18
  (facts the model sees, PLAN §6.26) and 19 (the stock portfolio, PLAN
  §6.24: Finnhub for US with `QUOTES_API_KEY`, set on staging; Yahoo for
  TASE) are done. Block H is built; it needs a staging deploy. Open: the
  full catalog has ~100 tokens of headroom left (PLAN §13 — decide before
  adding tools), and evals on prompt a10 are owed (PLAN §13). The full reviewed plan: `docs/plans/block-h.md` (read
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
| `docs/plans/block-h.md` | Building a block H part: the reviewed plan, by part. |
| `ops/runbook.md` | Routes, crons, chat commands, deploy, diagnosing. Other `ops/*.md`: secret rotation, token revoke, restore. |
| `apps/call-companion/README.md` | Anything in the Android app or the app ↔ server protocol. |
| `.claude/skills/add-tool/SKILL.md` | Adding or changing a tool. |
| [README.md](README.md) | Human-facing overview (GitHub page). |
| [SETUP.md](SETUP.md) | Setting up a new copy from zero: accounts, Groq key, models, secrets, deploy, app, AI agent. |

## 8. Session log (docs)

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
