# Personal Assistant (server + Android app)

A single-user personal assistant that understands Hebrew and English, by text
or voice. It sets reminders, reads and edits Google Calendar, Tasks, Gmail
drafts and Drive search, acts on the phone (alarms, timers, navigation, calls,
messages), answers public questions (weather, Shabbat times, exchange rates,
news, Wikipedia), and keeps notes and expenses.

It runs at **$0/month**: Cloudflare Workers Free, one Durable Object with
SQLite, and Groq's free LLM tier. The user talks to it through its own
Android app; a WhatsApp channel exists but is frozen.

> **For AI agents:** start with [HANDOFF.md](HANDOFF.md). It is short, says
> what breaks easily, and links to everything else. Rules are in
> [CLAUDE.md](CLAUDE.md).

## How it works

```
Android app ──signed request──► Cloudflare Worker ──► one Durable Object (SQLite)
                                                        │
                       deterministic first: commands, buttons, confirmations
                       then: LLM agent (Groq) proposes tool calls
                       code validates → computes times → finds targets
                       → policy tier → confirm if needed → executes
                       → reply written by code → app (outbox + push)
```

The core design rule: **the model proposes, code decides.**

- Every model output is untrusted. Tool arguments pass strict Zod schemas.
- Code computes every date and time (zone `Asia/Jerusalem`, DST-safe). A
  missing time is a question, never a default.
- Code finds the event or reminder to change. The model never sees or
  supplies an id.
- Each tool has a risk tier: 0 read, 1 act now (Undo where reversible), 2 confirm in chat,
  3 confirm on the phone's screen.
- The model never sees phone numbers, addresses, tokens or notes. Text that
  someone else wrote (mail, calendar titles, news) "taints" the turn, and
  any write it leads to must be confirmed.
- One message → at most one action and one reply.

Details: [ARCHITECTURE.md](ARCHITECTURE.md) (code map) and
[PLAN.md](PLAN.md) (full spec and decision log).

## Stack

| Part | Technology |
|---|---|
| Server | TypeScript, Hono, Cloudflare Workers + SQLite Durable Object |
| LLM | Groq free tier: `qwen3.8-27b` (primary), `gpt-oss-120b` (read-only backup), Whisper for voice |
| Validation | Zod (strict) |
| Integrations | Google Calendar, Tasks, Gmail (read + drafts), Drive (metadata), FCM, public keyless APIs |
| App | Kotlin, Android, Keystore-signed requests (`apps/call-companion/`) |
| Tests | Vitest (unit, integration with fakes, security), LLM eval corpora |

## Repository layout

```
src/               server source — see ARCHITECTURE.md §3 for each folder
migrations/        SQLite schema, 0001…0019
test/              unit · integration · security · evals
apps/call-companion/  Android app (own Gradle build and README)
ops/               runbook, secret rotation, token revoke, restore
scripts/           benchmarks, secret scan, staging secrets helper
.claude/           Claude Code settings and the add-tool skill
```

## Development

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test   # must be green before any commit
pnpm eval          # parser evals (real Groq, needs a key in .dev.vars)
pnpm eval:agent    # agent evals; use --filter, a full run is expensive
pnpm dev           # wrangler dev, staging config
```

Production deploys, secrets and rollbacks are done by the owner only
(`ops/runbook.md`). Secrets never live in the repo; a gitleaks pre-commit hook
and CI scan enforce it.

## Documentation

| Doc | What it is | Read it when |
|---|---|---|
| [HANDOFF.md](HANDOFF.md) | One-page entry point: status, request path, "touch X → watch Y" | First, every session |
| [CLAUDE.md](CLAUDE.md) | Rules and the 13 architecture invariants | Before any change |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Diagram, modules, storage, coupling | Finding where code lives |
| [PLAN.md](PLAN.md) | Full spec by section, open decisions (§13), decision log (§14) | Only the section you need |
| [ROADMAP.md](ROADMAP.md) | Feature blocks and progress (Hebrew) | Picking up the next feature |
| [ops/runbook.md](ops/runbook.md) | Routes, crons, commands, deploy, diagnosis | Operating or debugging |
| [apps/call-companion/README.md](apps/call-companion/README.md) | The Android app and its protocol | Working on the app |
| [.claude/skills/add-tool/SKILL.md](.claude/skills/add-tool/SKILL.md) | Checklist for adding a tool | Adding or changing a tool |

## Status

Private, single-user project. Staging runs the app channel with the agent on;
production is still configured for the frozen WhatsApp channel with the agent
off. Next work is tracked in [ROADMAP.md](ROADMAP.md).
