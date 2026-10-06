# HANDOFF — read this first

The single entry point for a new session. Dense on purpose: it says what the
system is, where things live, and what breaks easily, then links out. It does
**not** repeat the rules in `CLAUDE.md` (always loaded) or the spec in
`PLAN.md` (read by section, never whole).

_Last updated: 2026-10-06 · server at migration 0019 · agent prompt a8 · parser prompt v6 · app 0.9.0_

## 1. What this is

A single-user personal assistant (reminders, Google Calendar/Tasks/Gmail/Drive,
phone actions, public lookups, notes, expenses). Hebrew first, English works.

- **Server:** TypeScript on Cloudflare Workers Free + **one** SQLite-backed
  Durable Object (`AssistantDO`). $0 recurring cost is priority #1 (PLAN §1).
- **Client:** the Android app in `apps/call-companion/` (Kotlin, same repo,
  own Gradle build). WhatsApp still exists in code but is frozen behind
  `CHANNEL` (staging `app`, production `whatsapp`).
- **LLM:** Groq free tier. A bounded tool-calling **agent** (`AGENT=on`) with
  the single-shot **parser** as fallback. Models: `qwen3.8-27b` (primary, may
  write) and `gpt-oss-120b` (backup, read-only) — `src/agent/models.ts`.

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
                └ fallback: parser src/nlu/ → orchestrator src/core/orchestrator.ts
           reply → outbox src/channels/app/outbox.ts (+ HTTP response)
alarm()/cron → reminders, digest, scheduled reads → outbox → FCM push
```

Full map with every module: [ARCHITECTURE.md](ARCHITECTURE.md).

## 4. If you touch X, be careful with Y

| You touch | Watch out for |
|---|---|
| a tool (`src/tools/`) | Use the `add-tool` skill. Registry → one group in `agent/tool-groups.ts` → eval cases. Changing groups changes the eval fingerprint (`test/evals/fingerprint.ts`). New Google scope = stop and ask. |
| `src/agent/` prompt, catalog, models | `pnpm eval:agent` (use `--filter`; a full run can burn a model's daily 200K tokens). `canWrite` in `models.ts` changes only after a human reads an eval report. |
| `src/nlu/` | `pnpm eval`; "no invented slots" and "missing-slot detection" must stay 100%. The parser catalog is pinned to `PARSER_TOOL_NAMES` — new tools are agent-only. |
| anything a model can read | Pass it through `scrubForModel`; decide **taint** (text someone else wrote → every resulting write CONFIRMs). Private tools (`notes.*`) never reach the model or history. |
| time/date logic | Only `src/time/resolve.ts` (forward) or `src/time/past-day.ts` (expenses, backward). DST: next fall-back 2026-10-25. Never default a missing time. |
| a migration | Add `migrations/00NN_*.sql` **and** register it in `src/platform/migrations.ts`. Backward-compatible for one version. |
| `src/channels/app/parse.ts` or the wire protocol | The app has a matching `Protocol.kt` with test vectors. **Deploy the server before installing a new APK**, or the old server rejects the new app. |
| outbound `fetch` | Call `fetch` through a closure, never `this.fetchImpl(...)` — Workers throws "Illegal invocation" (tests use `test/integration/workers-fetch.ts` to catch it). |
| Cloudflare APIs | Only inside `src/platform/`. The ban-list test enforces it. |
| logging | Only `src/security/redact.ts`. Log canary tests must stay green. |
| Groq budget | 8K tokens/min, 200K/day **per model**; the daily limit is in no header. Measured, not guessed: `scripts/bench-tokens.ts`. |

## 5. Commands

`pnpm typecheck && pnpm lint && pnpm test` before calling anything done.
`pnpm eval` / `pnpm eval:agent [--filter p-] [--resume] [--select-tools]`.
`pnpm deploy:staging` only with approval. Production, secrets, rollback: human only.
App: `cd apps/call-companion && ./gradlew testDebugUnitTest`.
Network on the hotspot: `NODE_OPTIONS=--dns-result-order=ipv4first` for wrangler.

## 6. Where the current work is

- **Next work:** [ROADMAP.md](ROADMAP.md) (Hebrew) — first unchecked block
  (block E as of 2026-10-06; needs approval for a Google Contacts scope).
- **Owed / open decisions:** PLAN §13 (unchecked items) — e.g. a full qwen
  `eval:agent` run on a8, qwen `--select-tools` fingerprint, token calibration.
- **Latest decisions:** last rows of PLAN §14.

## 7. Docs map — what to read when

| Doc | Read when |
|---|---|
| `CLAUDE.md` | Always (auto-loaded). Rules and invariants. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Before changing code across modules; to find where something lives. |
| `PLAN.md` | Only the section you need. §6.x = component spec, §7 = security, §11 = tests/evals, §13 = open, §14 = decisions log. ~2,900 lines: never read whole. |
| [ROADMAP.md](ROADMAP.md) | Starting the next feature block. |
| `ops/runbook.md` | Routes, crons, chat commands, deploy, diagnosing. Other `ops/*.md`: secret rotation, token revoke, restore. |
| `apps/call-companion/README.md` | Anything in the Android app or the app ↔ server protocol. |
| `.claude/skills/add-tool/SKILL.md` | Adding or changing a tool. |
| [README.md](README.md) | Human-facing overview (GitHub page). |

## 8. Session log (docs)

- 2026-10-06: Added HANDOFF.md (imported by CLAUDE.md), ARCHITECTURE.md,
  README.md. PLAN §8 now points to ARCHITECTURE.md. No code changed.

**Update rule:** when a session changes architecture, a version, the next
block, or a doc's role, update §1/§6/§7 here in the same commit.
