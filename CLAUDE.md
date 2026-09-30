# CLAUDE.md — WhatsApp Personal Assistant

A single-user assistant for reminders and Google Calendar, reached through its own Android app (PLAN §6.18) — WhatsApp is frozen behind `CHANNEL`, not deleted. It runs on Cloudflare Workers with one SQLite-backed Durable Object and uses Groq for intent parsing.

**Before starting any task:**

- Read `PLAN.md` for the full spec, especially §3 Architecture, §6 Component specs, §7 Security, and §10 Phases.
- If a request conflicts with this file or `PLAN.md`, **stop and ask**. Don't improvise.

## Commands

(Phase 1 creates these scripts. Keep the names stable.)

- `pnpm install` — install dependencies. **Ask before adding any new dependency.**
- `pnpm typecheck` · `pnpm lint` · `pnpm test` — run all three before calling a task done.
- `pnpm eval` — NLU evals against the real provider (needs `GROQ_API_KEY` in `.dev.vars`). Required after any change to `src/nlu/`.
- `pnpm dev` — `wrangler dev` with staging config.
- `pnpm deploy:staging` — only with explicit approval in the session.
- **Never** run production deploys, `wrangler secret put`, `wrangler rollback`, or anything with `--env production`. The human does those.

## Architecture invariants (non-negotiable)

1. **The LLM is a parser, not an agent.** It receives only the user's message text, the current local date/time/weekday, and the enabled tool catalog. It returns one `IntentDraft`.
2. **Never send data to the LLM.** No calendar contents, event IDs or titles, reminder lists, tokens, tool results, error details, or phone numbers go into a prompt. If a feature seems to need this, stop and ask.
3. **LLM output is untrusted input.** It must pass the strict Zod `IntentDraft` schema (closed enums, `.strict()`, length caps) before any use.
4. **Code computes all dates and times.** Use `src/time/resolve.ts` with zone `Asia/Jerusalem` and rules R1–R12 (PLAN §6.3). Never ask the LLM for ISO timestamps. Never default a missing time — return CLARIFY.
5. **Code finds targets.** Event and reminder lookup uses `query_variants` from the draft, matched in code. The LLM never supplies IDs.
6. **Every tool has a tier (0–3) in the registry.** Tier 2 and 3 must go through `confirm/`. There is no Tier 4 code path — never implement permission changes, secret access, data forwarding, or code execution.
7. **Confirmations and button replies never go through the LLM.** They are handled deterministically in the Durable Object with atomic checks: status, expiry, sender, nonce, input hash. Execute the *stored* validated input, never a re-parsed one.
8. **Policy is code and static config only.** Nothing received over chat may change permissions, allowlists, tiers, or limits.
9. **Ingress security order is fixed.**
   - WhatsApp: raw body → HMAC `X-Hub-Signature-256` (constant-time) → parse → allowlist → dedupe. Senders not on the allowlist are dropped silently, with no reply and no LLM call.
   - The app (PLAN §6.18): route, channel and a byte-counted size cap in the Worker, which forwards the body **byte for byte** → the device's public key → ECDSA signature over the canonical string (awaited, no state touched) → one synchronous transaction: device still active, nonce spent → strict Zod → dedupe (`recordInbound`, before the pipeline's first await). An unknown or revoked device gets 401 and never reaches the LLM. A pairing code never crosses the network: the phone proves it with a MAC over its own key.
10. **One user command → at most one action and one reply message.** No autonomous loops or chained tool calls.
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

1. Define a `ToolDefinition` in `src/tools/` with name, LLM description, Zod draft schema, `resolve`, tier, Google scopes, `preview`, `execute`, optional `undo`, and rate limits.
2. Register it in `src/tools/registry.ts`. The LLM catalog is generated from the registry. Don't hand-edit prompt tool lists.
3. Add unit tests (resolve + policy + preview) and **eval cases** in `test/evals/`.
4. If it needs a new Google scope: stop and ask. New scopes are a security decision recorded in PLAN §14.
5. Update PLAN §6.4 and the §14 Decisions Log.

## Time handling rules

- Use `Asia/Jerusalem` everywhere user-facing. Store both the UTC instant and the local wall time.
- Nonexistent or ambiguous local times (DST gap or fold) → CLARIFY.
- Israel's next fall-back is 2026-10-25 02:00 → 01:00. Keep tests for it.
- Replies always show weekday + date + time: `יום ו׳ 25.9 · 14:00` / `Fri 25 Sep · 14:00`.
- Wrap Latin text, times, and ranges inside Hebrew messages in FSI/PDI isolates (`src/render/bidi.ts`).
- Hebrew plurals use `Intl.PluralRules('he')` with one/two/other (שעתיים, יומיים).

## Testing rules

- **Test first** for anything in `src/time/`, `src/policy/`, `src/confirm/`, `src/security/`, `src/channels/whatsapp/verify.ts`, and `src/channels/whatsapp/media.ts`. Write failing tests, then implement.
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
- [ ] `pnpm eval` run and thresholds met, if `src/nlu/` changed.
- [ ] No new secrets, PII, or message content in code, fixtures, or logs.
- [ ] New or changed tools have a tier, tests, and eval cases.
- [ ] `PLAN.md` updated if behavior or architecture changed.
