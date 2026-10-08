# CLAUDE.md — WhatsApp Personal Assistant

A single-user assistant for reminders and Google Calendar, reached through its own Android app (PLAN §6.18) — WhatsApp is frozen behind `CHANNEL`, not deleted. It runs on Cloudflare Workers with one SQLite-backed Durable Object and uses Groq for a bounded tool-calling agent (PLAN §6.19, behind `AGENT`), with the single-shot parser as its fallback; a conversation the user opens as smart tries Gemini first (2026-10-08).

**Before starting any task:**

- `HANDOFF.md` is imported below and is the entry point: status, request path, "if you touch X, watch Y", and which doc to read when. Read further only as it directs — `ARCHITECTURE.md` for the code map, and `PLAN.md` **by section** (§6.x for the component you touch, §7 Security, §13 Open, §14 Decisions). Never read PLAN.md whole.
- If a request conflicts with this file or `PLAN.md`, **stop and ask**. Don't improvise.
- When a session changes architecture, versions, the next ROADMAP block, or a doc's role, update `HANDOFF.md` (and `ARCHITECTURE.md` when modules, tools, tables or coupling change) in the same commit. A Stop hook (`.claude/hooks/docs-guard.mjs`) enforces this: if code, schema, config or ROADMAP changed this session and neither doc did, it stops the session once and asks. Update them, or say in one line why nothing there is affected.

@HANDOFF.md

## Commands

Keep the script names stable.

- `pnpm install` — install dependencies. **Ask before adding any new dependency.**
- `pnpm typecheck` · `pnpm lint` · `pnpm test` — run all three before calling a task done.
- `pnpm eval` — NLU evals against the real provider (needs `GROQ_API_KEY` in `.dev.vars`). Required after any change to `src/nlu/`.
- `pnpm eval:agent` — agent evals (first tool choice on the same corpus, plus injection-through-data). Required after any change to `src/agent/` prompt, catalog or provider. Resumable with `--resume`; one full run can exceed a model's daily budget.
- `pnpm dev` — `wrangler dev` with staging config.
- `pnpm deploy:staging` — only with explicit approval in the session.
- **Never** run production deploys, `wrangler secret put`, `wrangler rollback`, or anything with `--env production`. The human does those.

## Architecture invariants (non-negotiable)

1. **The LLM is a bounded agent; code decides** (PLAN §6.19, since 2026-10-01). It may call registry tools in a loop that code caps (model calls, tokens, one model per **agent turn**). A message can run up to four steps — model selection, the agent turn (always on that one model), the parser fallback, the read-only try — so a non-rate failure may reach a second model; a model that refused a message for rate or budget is never asked again for it (2026-10-06). A backup model's writes always confirm. In a smart conversation (PLAN §6.19, 2026-10-08) the model selection tries Gemini (`SMART_MODELS`, role `smart`, whose writes always confirm too) before the local models; nothing else changes. Every tool call goes through strict Zod → weekday check → `resolve` → policy → confirm, exactly like a parsed draft. Only a Tier 0 read returns to the model; every other outcome ends the turn with a code-rendered reply. The single-shot parser (one `IntentDraft`) is the fallback, and runs only when no tool ran. When the parser then finds no tool, a second model may answer **read-only** (Tier 0 reads, no writes, cards or phone reads; PLAN §6.19, 2026-10-05).
2. **Data minimization.** The model may receive the user's text, the encrypted short history, and **code-built read results passed through `scrubForModel`** (no numbers, addresses, codes or links). Never: tokens, secrets, raw ids, phone numbers, email addresses, error details. Text someone else wrote **taints** the turn (`PolicyContext.tainted`): every write it leads to is CONFIRM, and the taint carries through open questions and history. Text shared into the app from another one reaches the model unscrubbed but tainted, like a forwarded message (the user's decision, 2026-10-06). The facts the user asked to be remembered about them (`memory.*`, PLAN §6.26) reach the model on every agent turn — the user's decision, 2026-10-07: their own words, never from a tainted turn, and refused at save time if they hold an email, link, phone number, code or long number. **Smart conversations** (the user's decision, 2026-10-08, PLAN §6.19): there the model may be Gemini's free tier, which may train on what it is sent. In them, the user's data reaches any model only for a source the user allowed on a consent card; every other reply is stored in the history as a placeholder, shared text never reaches Gemini, and facts are not sent. A new data source needs a scrubbed, capped result shape, a taint decision and a `dataSource` — if unsure, stop and ask.
3. **LLM output is untrusted input.** Tool arguments and drafts must pass the strict Zod schemas (closed enums, `.strict()`, length caps) before any use. Model free text is display-only, capped, never parsed into an action, and every outbound message is link-defanged where it leaves (`defangLinks`), except the one-time connect link.
4. **Code computes all dates and times.** Use `src/time/resolve.ts` with zone `Asia/Jerusalem` and rules R1–R12 (PLAN §6.3). Never ask the LLM for ISO timestamps. Never default a missing time — return CLARIFY.
5. **Code finds targets.** Event and reminder lookup uses `query_variants`, matched in code. The LLM never supplies IDs.
6. **Every tool has a tier (0–3) in the registry.** Tier 2 and 3 must go through `confirm/`. There is no Tier 4 code path — never implement permission changes, secret access, data forwarding, or code execution.
7. **Confirmations and button replies never go through the LLM.** They are handled deterministically in the Durable Object with atomic checks: status, expiry, sender, nonce, input hash. Execute the *stored* validated input, never a re-parsed one.
8. **Policy is code and static config only.** Nothing received over chat may change permissions, allowlists, tiers, or limits.
9. **Ingress security order is fixed.**
   - WhatsApp: raw body → HMAC `X-Hub-Signature-256` (constant-time) → parse → allowlist → dedupe. Senders not on the allowlist are dropped silently, with no reply and no LLM call.
   - The app (PLAN §6.18): route, channel and a byte-counted size cap in the Worker, which forwards the body **byte for byte** → the device's public key → ECDSA signature over the canonical string (awaited, no state touched) → one synchronous transaction: device still active, nonce spent → strict Zod → dedupe (`recordInbound`, before the pipeline's first await). An unknown or revoked device gets 401 and never reaches the LLM. A pairing code never crosses the network: the phone proves it with a MAC over its own key.
10. **One user command → at most one action and one reply message.** Reads may repeat within the agent's caps; any write, question or confirmation ends the turn. No autonomous loops beyond one message, no chained writes.
11. **Only `src/platform/` may import Cloudflare APIs.** Everything else must run on plain Node for portability.
12. **Fail safe.** On ambiguity, errors, stale messages (>10 min old), or forwarded messages: CLARIFY or CONFIRM. Never guess and execute.
13. **A voice note is message text, one step earlier.** Audio is transcribed and graded (`src/voice/`, PLAN §6.10), then follows exactly the same router / NLU / policy / tool path as typed text — never a parallel one. A transcript the recognizer is unsure of never reaches the parser, and every reply to a voice note echoes what was heard, because the user has not seen it. The transcript is message content: never logged, never stored. In the app the recording arrives with the request (≤ 1 MB) instead of as a media id, and the answer's stored copy in the outbox never carries the echo.

## Secrets and privacy

- **Never read, print, or edit** `.dev.vars*`, `.env*`, or anything under `secrets/`. `.claude/settings.json` denies these, but treat that as a guardrail, not a guarantee.
- Never hardcode secrets, tokens, phone numbers, or email addresses in code, tests, fixtures, or docs. Use obviously fake values (`972500000000`, `test@example.com`).
- Secrets come only from Worker env bindings (PLAN §7.2). OAuth refresh tokens are stored only as AES-GCM ciphertext through `src/security/crypto.ts`.
- **Logging:** use the redacting logger from `src/security/redact.ts` only.
  - Never log message bodies, reminder text, event titles, tokens, or raw phone numbers.
  - Log ids, intent names, tiers, decisions, latency, and error codes.
- Never add `eval`, `new Function`, dynamic `import()` of non-literal paths, or child-process execution.

## Adding or changing a tool

See the `add-tool` skill for the step-by-step checklist.

## Time handling rules

- Use `Asia/Jerusalem` everywhere user-facing. Store both the UTC instant and the local wall time.
- Nonexistent or ambiguous local times (DST gap or fold) → CLARIFY.
- Israel's next fall-back is 2026-10-25 02:00 → 01:00. Keep tests for it.
- Replies always show weekday + date + time: `יום ו׳ 25.9 · 14:00` / `Fri 25 Sep · 14:00`.
- Wrap Latin text, times, and ranges inside Hebrew messages in FSI/PDI isolates (`src/render/bidi.ts`).
- Hebrew plurals use `Intl.PluralRules('he')` with one/two/other (שעתיים, יומיים).

## Testing rules

- **Test first** for anything in `src/time/`, `src/policy/`, `src/confirm/`, `src/security/`, `src/agent/`, `src/channels/whatsapp/verify.ts`, and `src/channels/whatsapp/media.ts`. Write failing tests, then implement.
- Unit tests make **no network calls.** Use the fakes in `test/integration/` (fake Meta, Google, NLU).
- Freeze clocks with Vitest fake timers. Never depend on the real current date.
- Any change to `src/nlu/` (prompt, schema, provider, model) requires `pnpm eval`. Report the metrics against PLAN §11.2 thresholds; "no invented slots" and "missing-slot detection" must stay at 100%.
- Keep the log-canary test and the ban-list scan green.

## Working style

- Keep changes small and single-purpose. Explain what changed and why in the summary.
- Prefer boring, explicit code over clever abstractions. Aim for strict TypeScript without `any`. Avoid heavy dependencies (Workers Free has a 10 ms CPU budget per request; measure it).
- When the spec is silent or unclear, check PLAN §13 Open decisions. If it's not there, ask. Don't choose silently.
- Update `PLAN.md` when you change architecture, schemas, tiers, or rules. Add a dated line to §14.

## Definition of done

- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test` all green.
- [ ] `pnpm eval` run and thresholds met, if `src/nlu/` changed; `pnpm eval:agent`, if `src/agent/` changed.
- [ ] No new secrets, PII, or message content in code, fixtures, or logs.
- [ ] New or changed tools have a tier, tests, and eval cases.
- [ ] `PLAN.md` updated if behavior or architecture changed.
