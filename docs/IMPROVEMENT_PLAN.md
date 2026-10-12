# Improvement Plan — evidence-based review (2026-10-12)

Scope: `bot/` at HEAD `4bb7fd8` (routines numbers + scheduled card, migration 0029, app 0.13.2).
The working tree also has two uncommitted app files (version 0.13.3, `RoutinesActivity.kt`). Line
numbers will drift; the symbol names are the stable reference. Nothing in this plan has been
implemented.

## 1. Executive summary

**State.** The codebase is in good shape for a single-user system. `pnpm typecheck`, `pnpm lint` and
`pnpm test` were green on the tree investigated (131 test files, 2,317 tests; see §9 for which
revision). The security
model in `CLAUDE.md` (bounded agent, code decides, strict Zod, confirm through code, signed app
ingress, redacting logger) is implemented, not just documented. Execution paths were traced for
ingress, confirmation, consent, routines and budget, and they match the docs closely.

**Most important confirmed issues** (none is P0):

1. **Consent revocation does not reach the smart-conversation history** (F1). After `/consents`
   revoke, earlier replies from that source stay in the encrypted history and are sent to Gemini again
   on later turns. That lasts up to 1 h for tainting reads and up to 12 h for Drive. Separately, the
   meaning of "this time" is ambiguous. `src/agent/consents.ts:11` says "nothing is kept", which
   plausibly means only "no consent row". Meanwhile `settleAgentResult` (`src/core/pipeline.ts:933-941`)
   deliberately keeps that turn's reply in history, so it is replayed later. That is decision D1.
2. **The live agent eval cannot fail a release** (F6). `run-agent-evals.ts` prints FAIL but exits 0.
   The primary model (`qwen`, `canWrite: true`) has no recorded `evaluated` fingerprint. Staging runs
   `AGENT=on` while PLAN §13's gate, "full qwen agent run before `AGENT=on`", is unchecked.
3. **The agent lock can expire mid-turn** (F2). `LOCK_TTL_MS = 60_000` (`src/agent/lock.ts:14`) with
   no renewal. A smart turn may make 6 model calls × 12 s = 72 s, and a single calendar read can chain
   up to about 11 requests of 10 s each (`google/calendar.ts:135-165`). Turns have no overall
   deadline. After 60 s, a second message can run a concurrent turn on the same history.
4. **A routine's typing step trusts whichever field has focus** (F3). `RoutineLogic.pickField`
   prefers the focused field, but nothing ties it to the field the routine just tapped. If the UI
   changes, a fixed text plus `SUBMIT` can land in the wrong field of the right app.

**Most valuable improvements.**
- Provenance-aware history replay (F1).
- Eval exit codes plus a quota-free fingerprint check before staging deploys (F6).
- An enforced turn deadline that makes the lock TTL a real bound (F2).
- Binding a typing step to its tapped field (F3).
- Removing free-form text from `errorCode` at its three sources, with a ban-list guard (F5).
- A one-time manual check of provider billing and retention settings (F7).

Each is small.

**Keep as is; already well designed.**
- App ingress: route allowlist, byte-counted `readCapped`, identity encoding only, bytes forwarded
  untouched, ECDSA verified before the nonce is spent in one transaction.
- Pending confirmations: atomic, nonce-hashed, input-hashed, executing the stored input.
- Inbound dedupe.
- The routine run state machine: one conditional `UPDATE` per move; a run cannot be claimed twice,
  after cancel or after expiry; the step hash is re-checked at sync, claim, execute and on the device.
- Budget check-and-reserve with no `await` in between.
- Provider errors never shown to the user.
- Content-free push payloads.
- gitleaks and `pnpm audit` in CI.

**Key uncertainties.**
- Whether production (`CHANNEL=whatsapp`) is deployed at all. Its config has an empty
  `GOOGLE_CLIENT_ID` and `PUBLIC_BASE_URL`; that sets the priority of F4.
- Whether billing is attached to the Groq or Gemini account. Code cannot see it; it decides both
  cost and Gemini's training terms (F7).
- Device behaviour of routines with the screen off and no keyguard. This needs a physical phone.

## 2. Findings and evidence

Status key: **C** confirmed · **P** partially valid · **A** already addressed · **U** unconfirmed · **N** not worth fixing · **Alt** alternative recommended.

| ID | Area | Finding | Evidence | Status | Severity | Recommendation |
|---|---|---|---|---|---|---|
| F1 | Privacy | A revoked source's replies keep being replayed to Gemini from history, and a suspended turn's stored messages carry them through a resume. A "this time" reply is kept by design, but the comment reads otherwise (D1). | `pipeline.ts:938-966` (`allowed = granted ∪ result.once`, then `history.append` of `outcome.text`); `consents.ts:11` vs `:101-109` (`revoke` deletes only the consent row); `loop.ts:370-373` replays every entry; TTL `history.ts:18-20` | C | Medium | T1: tag each history entry with its provenance (this turn's tool sources plus the tags of the history it saw); in a smart conversation, replay a placeholder for any entry whose provenance is not currently allowed, and for legacy untagged entries; check the same on resume. |
| F2 | Reliability | Agent lock TTL is shorter than the worst-case turn; there is no renewal. | `lock.ts:14`; `models.ts:128-129` (smart `maxModelCalls: 6`); `provider.ts:24` (`TIMEOUT_MS = 12_000`, Gemini included, `:200-208`); tool timeouts `google/api.ts:14`, `ical/fetch.ts:26` (10 s); one calendar read chains up to ~11 requests (`google/calendar.ts:32, 135-165`); no turn deadline | C | Medium-low (needs slow providers plus a second message; writes are still policy-gated) | T3: an enforced turn deadline (abort signal for reads), and a TTL derived from it. |
| F3 | Android | A typing step uses the focused field, not the one the routine tapped. | `RoutineLogic.kt` `pickField` (focused field first); `RoutineAccessibilityService.kt` `type`/`fieldUsable` check visible, enabled, editable, not a password, right package, but not identity | P | Medium-low (user-authored text, user-chosen app, confirmed run) | T4: when a `TYPE_TEXT`/`SUBMIT` follows a tap on a field, require that field to be the focused one; otherwise stop with a reason code. |
| F4 | Ingress | `/wa/webhook` reads the whole body (`c.req.text()`) before the cap and measures UTF-16 length, not bytes. | `src/index.ts:55-59`; `verify.ts:29`; cap `whatsapp/limits.ts:2` (256 KiB). Platform: 100 MB body on the Free plan, 128 MB isolate memory. HMAC runs before `JSON.parse` (correct). | C | Low (unauthenticated memory pressure, one isolate, no data impact; production channel probably dormant) | T7: reuse `readCapped` from `channels/app/ingress.ts`; verify the HMAC over the raw bytes. |
| F5 | Logging | The redactor is a key denylist; values under unknown keys pass truncated to 128 chars. Three sites log raw `error.message` as `errorCode`. The header claims phone hashing that does not exist. `seen` marks shared, non-cyclic objects as `[circular]`. | `redact.ts:4-6, 12-98, 142-166`; `orchestrator.ts:240, 592, 636`; ESLint `no-console` plus `test/security/banlist.test.ts` stop sink bypass; canaries `test/security/*log-canary*.test.ts` | P | Low (no demonstrated leak; thrown messages are mostly fixed `E_*` codes, but native `SyntaxError`/SQLite messages can quote input) | T5: fix the three sources; a ban-list regex guard; a logger check as backup only; fix the header and `seen`. **Reject** an enum or per-event allowlist (§4). |
| F6 | Evals | `pnpm eval:agent` exits 0 on a threshold miss. The primary's write gate is never recorded. Staging `AGENT=on` predates the PLAN §13 gate. Many §13 eval items are owed. | `run-agent-evals.ts:75-84` (thresholds), only setup `fail()`s at `:173,:176`; `run-evals.ts:1243` does exit 1; `models.ts:64-76` (no `evaluated`); `fingerprint.test.ts:15-21` only warns for the primary; `wrangler.jsonc` staging `AGENT: "on"`; `PLAN.md:2862` | C | Medium (a prompt or catalog regression in tool choice ships silently; writes still go through policy and confirm) | T2: exit codes; the fingerprint only after a pass; a fingerprint check in `deploy:staging`; a config test for production `AGENT=on`. **Not** live evals in CI (§4). |
| F7 | Cost | No local daily token or request cap for Groq; daily exhaustion is detected only by a 429. "Zero cost" depends on account settings code cannot see. | `quota.ts:22` (`DAY_TOKEN_LIMIT` used only in the report, `:215`); `budget.ts:49, 447-448`; Gemini day counter in SQL (`quota.ts` `SqlDayRequestCounter`) | P | Low in code; unknown at account level | T6: manual account verification (billing off, Groq ZDR on, Cloudflare on Free). No new code cap (§4). |
| F8 | Reliability | A phone-result turn whose DO dies mid-turn stays `running`; the app is told `pending` until the 1 h purge. | `turns.ts:293` (`running`, no claimed-at time), `expireDue` handles only `waiting` (`:332-341`), `purgeOld` `:365`; `assistant-do.ts:1309` | C | Low (needs eviction mid-turn; no wrong action, only a lost reply) | T8: in `duplicateStatus`, treat `running` as `unknown` when no live agent lock is held for that turn's id. |
| F9 | Tests | No deterministic test of the Groq agent provider's 500/503 → `provider_error`, or its own `invalid_json` path. | `provider.ts:173-185`; `test/unit/agent/provider.test.ts` has only request-shape tests | C | Low | T9: two unit tests with fake fetch. |
| F10 | Privacy | `scrubForModel` misses phone numbers separated by `.` or `/`, and emails with non-ASCII local parts. | `src/security/scrub.ts:37-46` | P (inferred from the regex; confirm with a test first) | Low | T10: test first, then widen the separators. |
| F11 | Maintainability | Full-catalog headroom is ~100 tokens. When exceeded, the agent fails the turn cap and the parser fallback may answer with the wrong tool (this happened: the routine "no pending reminders" reply). | `docs/plans/routines-schedule-ux.md` root cause; `PLAN.md:2875`; guard exists: `test/unit/agent/fit.test.ts:76` | A (tracked in PLAN §13, guarded by a test) | Medium as a growth limit | No new task. Decide the §13 item before adding any tool (§7). |
| F12 | Retention | Plaintext rows with no time-based purge: `reminders` (delivered or cancelled), `audit_log`. `app_outbox.text` is plaintext for up to 24 h / 7 d. | `migrations/0003:17`, `repo.ts:527-560`; `outbox.ts:29-30`; no `DELETE` on either table anywhere in `src/` (checked); `audit_log` holds no content | C | Low (single user, own DO, 1 GB cap) | T11 (optional): purge terminal reminders and old audit rows after N days (D3), checked against repeat reminders. |
| F13 | Android | No app allowlist or denylist, and no special handling of sensitive apps for routines. | `RoutinesActivity.kt`, the app picker, lists every launcher app except this one | N | — | Not recommended (§4). |
| F14 | Android | Two runs due together are both claimed, then queued on one executor; the second can be labelled `unknown` by the 10-minute stale-claim timer. | `RoutineAccessibilityService.kt:374`; `RoutineRunner.kt:61-80`; `routine-store.ts` `takeStaleClaims` | C | Very low (cosmetic: a late result still settles) | T12 (optional): refuse a second claim while a run is active on the device. |
| F15 | Android | `stepHash` joins values with raw `\t`/`\n`, which could in theory collide. | `RoutineLogic.kt:144-155`; the editor is single-line | N | — | Not recommended (§4). |
| F16 | Architecture | Large files: `assistant-do.ts` 2,111 lines, `pipeline.ts` 1,719, `registry.ts` 1,047. | `wc -l` | N | — | No split (§4). |
| F17 | Observability | Transient FCM failures are logged only, never surfaced on the status screen. | `assistant-do.ts` `pushOutbox` (only `unregistered` sets `lastErrorCode`) | C | Low | Optional, inside T8's PR: set `lastErrorCode` after N consecutive push failures. |
| F18 | Reliability | Cron is never retried. | `src/index.ts:261-270` | A | — | Purges also run from `alarm()`; nothing to do. |

## 3. Recommended changes

### T1 — History replay respects current consent (F1) · P1

- **Problem.** In a smart conversation, `settleAgentResult` stores the real reply when a tool's
  source is in `granted ∪ once`. `build()` replays all entries (up to 6 exchanges / 2,400 chars) with
  no consent check. `consents.revoke` deletes only the consent row. So after "stop letting Gemini see
  my calendar", the calendar replies already in history keep reaching Gemini until the TTL ends.
  Gemini's free tier may use prompts to improve Google's products, and human reviewers may read them
  (ai.google.dev/gemini-api/terms, updated 2026-04-28), so the exposure is real but bounded (TTL).
- **Proposed behaviour.**
  1. `history.append` takes the consent sources whose data the reply may carry: its **provenance**.
     It is the union of two sets:
     - (a) sources of tools that ran this turn, by the same predicate as `withheld`
       (`pipeline.ts:945-950`): excluding `public` and `echoesOwnInput` tools, so own-input write
       replies stay visible after a revoke as intended.
     - (b) the `src` of every history entry that was **replayed in full** to the model this turn.

     Part (b) is what catches a later reply that paraphrases or summarises earlier calendar data
     without calling the calendar tool again. Information can only reach a reply through the model's
     input, and the input's tagged parts are exactly the replayed entries plus this turn's tool
     results. The rule copies an existing pattern: `tainted` already propagates the same way, from
     any replayed entry to the turn (`loop.ts:358`). No information-flow analysis is needed.
     - The tracking is per turn and conservative. After a revoke, every later entry that saw the
       source becomes a placeholder too, even if its reply did not use it. With at most 6 exchanges
       and 12 h, that loss is small.
     - Store the provenance inside the encrypted entry as an optional field, e.g.
       `src: ConsentSource[]`.
       `HistoryEntry` (`history.ts:27`) and the serialised `{u, r}` (`history.ts:47-48`) gain the
       field.
     - `recent()` checks only `typeof u/r` (`history.ts:99-100`), so old entries still decode.
     - There is one writer (`pipeline.ts:955`) and one reader (`pipeline.ts:780`). No other table
       reaches the agent.
  2. In a smart conversation, an entry whose `src` contains a source not in `consents.list(...)` *now*
     is replayed as `he.withheldPlaceholder`. This is the same placeholder used today, so the model
     sees nothing new.
     - Do the filtering in `pipeline.ts` right after the history read (`:780`), where the grants are
       already computed (`:790`). `loop.ts` stays unchanged, including its `tainted` calculation.
     - **Legacy entries** (no `src` field, written before the deploy): in a smart conversation,
       replay the user side as is (the user's own words, invariant 2) and the reply as the
       placeholder. This costs at most 12 h of smart-conversation context, once, at deploy, and makes
       the guarantee hold for every entry rather than only new ones. Local conversations replay
       legacy entries unchanged (they never reach Gemini).
     - The entries kept in full are the ones whose `src` part (b) collects.
  3. **Suspended turns: every data-bearing message, not only the replayed history.**
     - What a suspended state holds (verified): `paused()` stores `loop.messages` minus the system
       prompt (`loop.ts:717-726`). That is the replayed history **and every tool call and tool result
       produced earlier in the same turn**, for example a calendar read made before a later call
       suspended for mail consent. Both resume paths send all of it again (`...state.messages`,
       `loop.ts:535` phone, `:608` consent). `resumeOn` re-checks only the *offered tools* against
       current grants (`loop.ts:649-652`), never the messages.
     - **The gap is confirmed:** with a persistent calendar grant, a calendar read, then a suspension
       for mail, then a calendar revoke, then a resume, the calendar title reaches the model.
     - **The sources a resume would resend** are the union of two sets:
       - (a) **History provenance:** a new optional `historySources` in the state, the union of `src`
         over the entries replayed in full when the turn began (from step 1).
       - (b) **This turn's tool results:** derived from the stored messages, with no new field. The
         state already yields the tools that ran: `ranIn(state.messages.slice(0, -1))`
         (`loop.ts:584`). Map them with `consentSourceOf`, excluding `public` and `echoesOwnInput`
         tools, by the same predicate as step 1. Over-inclusion, such as a call that was refused, is
         harmless: it can only reject a resume, never leak.
     - **Rule, in one helper used by both resume paths:** the turn may resume only if every source in
       (a) ∪ (b) is allowed *now*. "Allowed now" is the conversation's current grants, plus the
       turn's `once` sources (stored in the state), plus the source just approved on this card.
       - **A persistent grant revoked while the turn was suspended:** the source is no longer
         allowed. The turn ends through the existing `failed('model_unavailable')` branch
         (`loop.ts:518-527`, `:588-598`), with no model call, and the reply is the existing failure
         text.
         - Any `readText` goes to the user only, never to a model.
         - No history entry is written, because the failed path returns before `history.append`
           (`pipeline.ts:908-921`).
       - **Data under a one-time approval:** the documented scope of "this time" is the whole turn
         (step 5), across calls and across this turn's resumes, and `once` is stored in the state. It
         stays allowed: resume proceeds. This is consistent with D1 either way, because D1 concerns
         *later* turns only, so no new user decision arises.
       - **A source still authorized at resume:** resume proceeds unchanged.
     - **Reject, not redact.** Redacting would mean rewriting tool results inside a stored
       tool-call/result sequence, and splitting flattened history messages back into entries. That
       risks a malformed or misleading conversation for the model. Ending the turn is the existing
       fail-safe (invariant 12), costs one re-ask, and happens only on a revoke within the 3-minute
       suspension window.
     - **Legacy states**, stored before the deploy without `historySources`: part (b) works on them
       unchanged.
       - Part (a) is unknown, so a legacy **smart** suspended state is treated as not resumable. It
         ends with `model_unavailable`. That affects at most `SUSPEND_TTL_MS` = 3 min of in-flight
         turns, once, at deploy.
       - Legacy local states resume as today: local turns have no consent gate and never reach
         Gemini.
       - So the guarantee holds with no residual window.
     - `stateSchema` is `.strict()` but has already gained optional fields this way
       (`turns.ts:128-140`), so an optional `historySources` decodes old rows.
  4. "This time" semantics (**user decision D1**, §7).
     - **(a) Do not retain** (recommended). The provenance marks `once` sources. Such an entry is
       never replayed in full, so it adds nothing to later provenance. Consequences:
       - It matches the card's words and `consents.ts:11`.
       - Mail, SMS, contacts and notification text, which is other people's words, reaches a model
         only within the turn it was allowed for. That is **not** "one request". Inside the turn, the
         tool result stays in the message list and goes with every later call of that turn: up to 5
         more for Gemini (`maxModelCalls` 6) and 2 for qwen (`loop.ts:754, 795`).
       - It goes only to the turn's one model: no model switch happens mid-turn (`loop.ts:430-433`),
         and the read-only retry runs only when no tool ran.
       - A follow-up such as "who sent the second one?" makes the model call the tool again, so a new
         card appears. That is one more tap.
     - **(b) Retain** (today). Follow-ups work without a card. But the same mail or SMS text is
       re-sent with up to 6 later requests within its 1 h TTL. Under the unpaid Gemini terms, each
       copy may be used to improve Google's products and read by reviewers. The comment must then
       change to say so.

     The mechanism in (1)–(3) supports either option.
  5. **The boundary, stated precisely.**
     - "Allow this time" authorizes **one tool read, whose result the turn's single model may see for
       the rest of that one turn**, however many calls the turn makes.
     - Provenance (steps 1–3) works **across** turns only. Within a turn the model needs the result to
       answer, so trimming it from later calls would break the feature.
     - PLAN §6.19 and the `consents.ts` comment state this boundary. The card's "Allow this time"
       already matches it, read as "this question".
     - **User-facing copy: unchanged for this point, deliberately.** What matters for the user's
       decision is already disclosed: who receives it (Google, per `mode_smart_note`, and after
       T6b, Groq on fallback), what they may do with it (training and human review), and the scope
       (this question; nothing kept, if D1 = a). How many requests go to the *same* provider while
       answering one question adds no new recipient and no new use.
     - Saying "it may be sent several times" would read as a larger exposure than it is. Saying
       "sent once" would be false. So the copy says neither.
- **Why this over alternatives.** Clearing the whole conversation history on revoke is simpler, but
  it destroys unrelated context and does not fix "this time". Purging matching rows on revoke needs
  the tag anyway, and decrypting and rewriting rows. Filtering at replay is one check, at the single
  replay point.
- **Limits, stated rather than hidden.**
  - The guarantee covers data that entered through a **tool reply**. The user's own typed words are
    always sent (invariant 2), even if they repeat a calendar detail.
  - Provenance is per turn, not per sentence: it can over-redact, never under-redact.
  - Record both limits in PLAN §7.1 / §14.
- **Risks.**
  - The one-time loss of smart context at deploy (legacy entries).
  - A placeholder chain after a revoke: later answers may say they cannot see the earlier data, and
    the model would then ask for the tool again.
- **Files.**
  - `src/core/pipeline.ts`: `settleAgentResult` writes the tag; the history read filters.
  - `src/agent/history.ts`: the entry field.
  - `src/agent/turns.ts` and `src/agent/loop.ts`: the suspended state's source set, and the resume
    check.
  - `src/agent/consents.ts`: the comment.
  - PLAN §6.19 / §7.1 / §14.
  - HANDOFF §4's "the history gate is `settleAgentResult` only" becomes "written only by
    `settleAgentResult`, filtered by current consent at the read".
- **Tests (test first: `src/agent/` is a test-first area).** Allow `calendar` for the conversation →
  read → revoke → next turn: the fake agent's `seenByModel` holds the placeholder, not the title.
  **Suspended-turn tests (inspect `seenByModel`):**
  - **(s1)** Persistent calendar grant; the fake calendar read returns a canary title; a following
    call suspends for mail consent; calendar is revoked; resume with "this time" for mail. The fake
    model receives **no** message with the canary, and **no model call** happens on resume. The turn
    ends `model_unavailable`. This test fails if revoked data reaches the model.
  - **(s2)** The same with calendar still granted: resume proceeds, and the model receives the
    calendar result (the intended behaviour).
  - **(s3)** The calendar read was under a "this time" approval earlier in the same turn: resume
    proceeds, and the model receives it, because the scope is the turn.
  - **(s4)** A phone-read suspension with calendar revoked meanwhile: the resume ends, with no model
    call.
  - **(s5)** A legacy smart state without `historySources` ends; a legacy local state resumes.
  - **(s6)** A revoke of a source only in replayed history (part (a)) also ends the resume.
  An own-input write reply (`reminders.create`) is still replayed after a calendar revoke.
  **Propagation:**
  1. Calendar read.
  2. A follow-up answered with no tool, whose fake reply repeats the title.
  3. Revoke.
  4. Next turn: both entries are placeholders.

  **Legacy:** a pre-deploy entry without `src` in a smart conversation is replayed as the
  placeholder; in a local conversation it is replayed unchanged.

  For D1 (a): a `once` mail read, then the next turn sees the placeholder, and a follow-up after it
  carries no `mail` provenance. The agent log canaries stay green.
  `pnpm eval:agent --model gemini-3.5-flash-lite --filter <smart cases>` only if the prompt changes;
  it does not.

### T2 — The agent eval can fail, and a release gate is written down (F6) · P1

- **Problem.** The agent eval measures the right things: tool choice 0.97, exact slots 0.95, no
  invented slots and missing-slot recall at 100%, off-topic, 13 injection-through-data cases with
  `injectionWrites = 0`, and p95 latency. But a miss still exits 0, so neither a script nor a person
  skimming output gets a hard signal. `qwen` writes with no recorded `evaluated` fingerprint.
- **Proposed.**
  1. `run-agent-evals.ts` exit codes:
     - **1:** a hard gate (`noInventedSlots`, `missingSlotRecall`, `injectionWrites`) fails on the
       cases that ran, in any mode. Also 1 when a soft metric (`toolChoice`, `exactSlotMatch`,
       `offTopic`) misses on a complete, unfiltered, unsampled run.
     - **2:** the run is incomplete. That covers a ledger or `daily_budget` stop
       (`run-agent-evals.ts:222-225`, `:239-241`), `--sample` and `--report`, unless a hard gate
       already failed. "Resume tomorrow" then never reads as a pass.
     - **0:** otherwise.
     - `p95LatencyMs` (`:82`) depends on the network (the hotspot), so it stays a printed warning, not
       an exit condition.
     - Only `package.json:21` calls the script, so no other caller changes.
  2. Today the script prints "fingerprint for X … record it only if every gate passed" even when a
     gate failed (`run-agent-evals.ts:257`). Print the fingerprint **only** after a complete run
     with every gate passed; otherwise print "not eligible". That way a failed run never hands out
     a value to paste.
  3. **No vacuous passes.** Today an empty gate passes: `ratio` returns 1 when the total is 0
     (`:407`), and `--filter he-rem` keeps no injection case (`:192`), so the run reports
     "injection → write 0 PASS".
     - Every gate prints its case count.
     - A gate with **zero** cases prints `n/a (0 cases)`, and counts as neither pass nor fail.
     - Exit 0 *and* fingerprint eligibility both require a complete, unfiltered, unsampled run, with
       every gate non-empty. A filtered run can still fail with 1 on a hard gate that had cases. It
       can never yield a release signal.
     - A `--resume` run counts as complete only when every case of the full corpus is recorded.
     - None of this needs extra live calls.
  4a. **Model identity in the fingerprint.**
     - Today `fingerprintFor` and `smartFingerprintFor` hash the prompt, wire tools,
       `{maxCompletionTokens, params}`, `ADAPTER_VERSION` (plus `GEMINI_WIRE_VERSION`) and selection
       (`test/evals/fingerprint.ts`). They do **not** hash `entry.id` or `entry.provider`
       (`models.ts` `ModelEntry`). Swapping the model id under an entry that keeps its `evaluated`
       record would inherit the old pass.
     - Add `entry.id` and `entry.provider` to both hashes. No entry records `evaluated` today, so
       nothing already recorded is invalidated.
     - Already covered: generation params, request format (adapter versions) and selection
       behaviour.
     - `canWrite` is gated by the test itself, which requires `evaluated` for a writing entry.
     - Deliberately not hashed: `turnCap`, `maxModelCalls`, `charsPerToken`, rate limits. The eval
       judges the first call's tool choice and slots with no history, which these do not change.
       Hashing them would force live re-runs for budget tuning.
     - **Limit, stated: a local hash cannot see provider-side changes.**
       - Ids are fully versioned, with no `-latest` aliases, enforced by a unit test (`models.ts`
         `id` comment).
       - Google says stable Gemini names "usually don't change", previews may be retired on 2
         weeks' notice, and only `-latest` aliases are hot-swapped (ai.google.dev/gemini-api/docs/models).
       - Groq's models page states no revision or fingerprint guarantee, and separates "production"
         from "preview, may be discontinued at short notice".
     - So, at no recurring cost:
       - (1) Record in each eval recording whatever the response exposes: the `model` field, and a
         `system_fingerprint` if present. The repo does not show whether either provider returns
         one, so check one real response before relying on it.
       - (2) Add to T6's checklist whether each configured id is listed as production/stable or as
         preview.
       - (3) Re-run a quota-bounded `--filter` eval when a provider announces a change, or when the
         recorded metadata differs from a fresh response.
       - No periodic live evals.
  4. **The suite: a selective, zero-quota rule.** The fingerprint already changes when case
     *inputs* are added or removed, because they feed the selection hash, and that rightly needs a
     live run. It does not change when the **judging** changes: expected values (`expect` in the
     cases files), scoring code or `THRESHOLDS`. So today, a tighter threshold or a changed
     expectation leaves an old pass recorded as valid.
     - Re-judging needs no model: `--report --resume` re-scores the saved recording with the current
       expectations, scoring and thresholds, and makes no calls (`run-agent-evals.ts:203-207`; the
       ledger is `null` in report mode, `:217`).
     - Add `judging` to `evaluated`: a hash of the `expect` fields of every case, the
       `run-agent-evals.ts` scoring source and `THRESHOLDS`.
     - `fingerprint.test.ts` fails when an entry's `judging` no longer matches. The remedy is free:
       re-score the saved recording with `--report --resume`. If it still passes, update `judging`.
       If it fails, the gate is correctly closed until a new live pass.
     - Store the fingerprint inside the recording when it is made, so a re-score refuses a recording
       from a different environment.
     - Recordings are git-ignored and local. If the recording is lost, a live run is needed; that
       is the only quota cost, and it is rare.
     - Cost: hashing the whole scoring file means a comment-only edit also asks for a re-score. That
       is free and takes seconds, so the coarse hash is kept rather than parsing out "relevant"
       code.
  5. **The enforceable part: deterministic, no quota.** The fingerprint already pins system prompt,
     wire tools, params, adapter version and selection behaviour (`test/evals/fingerprint.ts`
     `fingerprintFor`). `fingerprint.test.ts` already fails CI on a mismatch, for any entry with
     `evaluated`. So once the owed qwen `--select-tools` run records `evaluated`, any later prompt,
     catalog or selection change fails `pnpm test` until it is re-evaluated. Add:
     - `deploy:staging` = run the fingerprint test file, then `wrangler deploy --env staging`. A
       deploy from a tree whose write gate is stale is refused locally.
     - After the qwen run is recorded, flip the primary branch of `fingerprint.test.ts` from a
       warning to a failure when `canWrite && !evaluated`. **Not before**, or every staging deploy is
       blocked until the owed run happens.
     - A small config test reads `wrangler.jsonc` and fails if `env.production.vars.AGENT === 'on'`
       while the primary has no matching `evaluated`.
  6. Add a "Release gate" section to `ops/runbook.md` stating the above, and the `--filter` evals
     owed per change (CLAUDE.md).
- **What stays manual, said plainly.** Production deploys are human-only (CLAUDE.md), so nothing
  can force the human to run `pnpm test` first. The config test catches `AGENT=on` in the committed
  config, not a `wrangler deploy` run from a dirty tree. That is acceptable for a single-user
  project.
- **Not proposed:** running live evals in CI (§4).
- **Files.**
  - `test/evals/run-agent-evals.ts`
  - `package.json` (the `deploy:staging` script; the name stays stable)
  - `test/unit/agent/fingerprint.test.ts`
  - a new `test/unit/config/release-gate.test.ts`
  - `ops/runbook.md`
  - later `models.ts`
- **Acceptance.**
  - A recorded run with a forced hard-gate miss exits 1 and prints no fingerprint.
  - A filtered run with zero injection cases prints `n/a (0 cases)`, never exits 0 as a release
    signal, and prints no fingerprint.
  - A budget-stopped run exits 2.
  - A clean complete run exits 0 and prints the fingerprint and the `judging` hash.
  - Raising a threshold in `THRESHOLDS` fails `fingerprint.test.ts` until `--report --resume` is
    re-run and `judging` updated. That re-run passes or fails according to the saved recording, and
    makes no provider call.
  - `--resume` that completes counts as complete.
  - `pnpm deploy:staging` refuses when the fingerprint test fails.
  - The config test fails on a production `AGENT=on` without a matching `evaluated`.

### T3 — The agent lock outlives the turn (F2) · P2

- **Current.** The TTL is 60 s with no renewal.
  - A lock covers one agent turn. It is released in the `finally` at `pipeline.ts:877`. The read-only
    try and each resume take a fresh lock (`:754`, `:1000`, `:1089`), and the parser runs outside it.
  - **Execution shape** (verified):
    - One model response runs at most one tool (`response.toolCalls[0]`, `loop.ts:~872`), plus one
      pre-approved call on a resume (`:800`).
    - Steps are sequential.
    - There are no sleeps and no provider retries inside a turn. A 429 or 5xx ends the call, and
      failover to another model happens between agent turns, not inside one lock.
    - Post-processing under the lock (`settleAgentResult`, history encryption) is local and takes
      milliseconds.
  - **A static per-step bound does not hold.** One calendar read can chain an OAuth refresh, the
    primary list, the calendar list and up to `MAX_OTHER_CALENDARS = 8` more lists
    (`google/calendar.ts:32, 135-165`), each with its own 10 s timeout (`api.ts:14`,
    `oauth.ts:28`). That is about 110 s for a single tool. Other multi-request tools are not
    enumerated. So "calls × timeouts" understates the worst case, and any fixed TTL is a guess.
- **Proposed: one turn deadline, enforced, no renewal.**
  1. A turn deadline, `TURN_DEADLINE_MS`, from turn start. No model call or tool starts after it.
     - **Value:** default **60 s**. There are no latency measurements in the repo beyond the eval's p95
       target of 8 s (`run-agent-evals.ts:82`). A normal turn takes a few seconds, and a calendar
       read is ~11 sequential requests of typically 1–2 s each.
     - The deadline only cuts pathological turns. Their answer is already late, and the outbox
       delivers late answers anyway.
     - **What exists to validate it, honestly:**
       - The content-free `turn` log record (`pipeline.ts:255-261`) carries the `agent` stage's
         waiting time. That is the whole agent stage of a new message, all model calls and tools,
         **summed with the read-only retry** if one ran.
       - Resumes (phone result, consent tap) call `timed` without a stopwatch, so they are not
         logged.
       - Workers Logs keeps 3 days on Free, and one user's traffic gives few slow samples.
       - The 8 s p95 is an eval *target*, not an observation.
       - So 60 s is a **provisional** value, chosen as far above normal turns. It equals today's
         60 s lock TTL; the point is that the new TTL is derived from the deadline, so the two can no
         longer be equal. It is not yet measured.
     - **Validation, content-free and free:** at the end of each agent loop, emit one
       `agent_turn` record (ms, model calls, tools run, `deadline_hit` true/false; numbers and
       codes only). It covers resumes too.
       - After a week of staging use, read it. If any legitimate turn passed about half the deadline,
         raise the deadline (the TTL follows by the asserted relation).
       - A `deadline_hit` that turns out legitimate is the signal to raise it, not to lower the
         timeouts.
     - Check at the top of the `while` loop (`loop.ts:809`) and before `act()`. Release
       `loop.reserved` first, as the `turn_token_cap` exit does (`:819-820`).
     - It returns a **new failure code, `deadline`**, not `max_calls`. Reusing `max_calls` is
       unsafe: when no tool ran, the pipeline hands the message to the **parser**
       (`respondWithModels`, `pipeline.ts:~585-597`), which is another model call that can then
       execute a parsed write. `TURN_SHAPE_FAILURES` (`:724`) blocks only the read-only try
       (`:613`).
     - So `deadline` joins `TURN_SHAPE_FAILURES`, and `respondWithModels` returns at once on it,
       with no parser call and no read-only try. The inbound outcome is marked `E_AGENT_DEADLINE`.
     - The reply is `he.agentFailed('deadline')`. That is the existing default branch, "the model
       did not answer this time, try again in a moment" (`render/he.ts:112-122`), so no new Hebrew
       string is needed.
     - Inject `now()` through `AgentDeps`; the loop has no clock today.
  2. One `AbortSignal` for the turn, firing at the deadline, combined with each request's own timeout
     via `AbortSignal.any`. There are no SDKs: every outbound path is plain `fetch`, so the signal
     is honoured wherever it is passed. The read paths to cover (grep of `fetch` call sites):
     - the agent provider (`provider.ts:146`);
     - `GoogleApi.call` (`google/api.ts:58-100`) **and the token refresh it chains**
       (`google/oauth.ts:140`, through `token()`), including its single 401 retry;
     - `ical/fetch.ts` `fetchFeed` (redirect hops share one deadline already);
     - `lookup/http.ts`;
     - **`lookup/quotes.ts:58`, which has its own fetch.**

     An implementation test asserts that no other `fetch` is reachable from a read tool. It can be a
     grep-based test in the style of `banlist.test.ts`.
     - The body read (`response.json()`) is cut by the same signal; the existing timeouts already rely
       on this.
     - An aborted fetch rejects. Each helper already maps that to an error result (`network_error`),
       so the tool returns a failure and the loop stops at the deadline check.
     - There is no late result: every step is awaited, so nothing completes after the turn returns,
       and nothing touches history afterwards.
  3. **Writes do not take the turn signal.** Aborting a write mid-request leaves an unknown outcome,
     while finishing it is safe. A write is always the turn's last step (invariant 10), so it is
     bounded by its own timeouts. One `GoogleApi.call` can chain a refresh, the call, then a 401
     retry of both: 4 × 10 s = 40 s.
     - The implementer enumerates the Tier 0–1 executes that write over the network. Tier 2–3 writes
       run later through confirm, outside the agent lock. They export the largest number of
       sequential calls as `MAX_WRITE_MS`.
     - **The deadline never turns a successful write into a reported failure** (verified):
       - A write needs no further model call. `act()` returns every non-read outcome (write,
         question, confirm card) at once as a code-rendered reply with `byModel: false`
         (`loop.ts:774-790`). The loop then returns; the deadline check at the top of the loop is
         never reached after a write.
       - After the loop, only `settleAgentResult` runs: a synchronous DB update and one local history
         encryption, both milliseconds and inside the lock.
       - So the deadline is checked before a model call or a tool call starts, and, for write tools,
         again after resolve returns and immediately before `execute` (step 3b). Once `execute` has
         started, its outcome is the turn's reply.
       - The signal applies only to the *resolve* phase of a write tool, for example finding a task
         list in `resolveAsync`. An abort there means nothing was written, and the reply says it
         failed.
       - `execute` never sees the signal.
     - **Pre-existing limit, not caused by T3, documented:** a write whose *own* 10 s fetch timeout
       fires after Google received the request is reported as failed (`network_error`), even though
       Google may have applied it. A retry could then duplicate, for example, a calendar event.
       - T3 does not make this worse: writes are never aborted by the deadline.
       - A future option, not scheduled, is idempotent inserts: Google Calendar accepts a
         client-chosen event `id`. That is recorded as an open item, outside this plan's tasks.
  3b. **Deadline outcomes, exhaustively** (source-checked):
     - **Write tools.** `runToolCall` → orchestrator runs `resolve`/`resolveAsync` → policy →
       confirm card *or* `execute` in one flow (`orchestrator.ts:225-245, 455-470`). So an async
       resolve that completes near the deadline **can** let `execute` begin after it, unless
       checked. A deadline check therefore runs **after resolve returns and immediately before
       `tool.execute`**, using the turn signal's state.
       - **W1, resolve still in flight at the deadline:** the read is aborted. Whatever resolve
         returns (an error, or even a question built from the failure), the post-resolve check sees
         the deadline: nothing executes.
       - **W2, resolve done, execute not started, deadline passed:** nothing executes.
       - For W1 and W2 the reply is `he.agentFailed('deadline')`. It says the model did not answer
         and to try again; nothing was done, and nothing claims otherwise. The audit outcome is
         `deadline`, not `ok`, so it does not count toward rate limits (`repo.ts:527-544` counts
         `ok`). The turn ends: `toolRan` is true, so no parser fallback.
       - **W3, execute started before the deadline:** never aborted; `execute` gets no signal. Its
         bounded result is awaited and its real reply is the turn's reply, success or failure.
       - A confirm card (Tier 2–3) created before the deadline is unaffected. Its later tap executes
         the stored input outside the turn (invariant 7).
       - **W4, pre-existing and not solved by the deadline:** a write whose *own* fetch timeout
         fires may still have been applied by Google, and is reported failed.
     - **Model calls.** Today an aborted provider fetch is classified as `timeout` or
       `network_error` (`provider.ts:148-155`); neither is a turn-shape failure, so the read-only
       try and the parser would run.
       - After `provider.complete` returns any error, the loop checks the turn signal (or
         `now() ≥ deadlineAt`) **first**. If the deadline has passed, it returns `failed('deadline')`,
         whatever the provider's code.
       - With `deadline` handled as above, no failover, parser call or read-only try happens.
       - Budget accounting stays as for a timeout (charged as sent). The model is not marked
         refused.
     - **Reads.** The turn signal's state **at the moment the read tool returns** decides:
       - **R1, aborted when it returns** (the pending request was cut; this also covers a
         completion racing the abort): its result is discarded, never shown as data. The turn ends
         `failed('deadline')` with `toolRan: true` and no `readText`, so `settleAgentResult` replies
         with the existing `he.agentIncomplete`.
       - **R2, returned before the deadline**, but the deadline passes before the next model call:
         the next loop check returns `failed('deadline')` with `readText` = that read's
         code-rendered text, and the user gets the real result (the existing `toolRan` path,
         `pipeline.ts:914-920`).
       - **R3, a completion racing the abort:** classified by the same rule. If the signal had fired
         when the tool returned, it is R1. Conservative: a result that arrived a moment before the
         abort may be dropped, but an aborted request is never presented as valid data.
       - This rule applies to reads only. A write's reply is always its own (W3).
     - In every case no model call starts after the deadline.
  4. `LOCK_TTL_MS` ≥ `TURN_DEADLINE_MS` + `MAX_WRITE_MS` + margin; for example, 60 + 80 + 40 =
     **180 s**. A unit test asserts the relation from the exported constants.
     - A write that starts just before the deadline ends by `deadline + MAX_WRITE_MS`, plus
       milliseconds of settle, which is still inside the lock. The margin covers settle and clock
       granularity.
     - Raising the deadline after validation raises the TTL by the same relation.
     - The TTL deliberately errs high. It matters only after an eviction mid-turn, when it shows the
       busy reply. The user-facing limit is the deadline.
     - With this relation, no operation of a turn can still be running after its lock expires.
- **Why not renewal.** Renewing at step boundaries still cannot bound a single 110 s read; it would
  need the signal anyway. Once the signal exists, the deadline makes a static TTL valid, and renewal
  adds nothing.
- **What longer TTLs change.**
  - After an eviction mid-turn, the sender sees the busy reply for up to about 180 s instead of
    60 s.
  - No duplicate execution is introduced: inbound dedupe (`repo.ts:144-160`) and pending-action
    atomicity are independent of the lock. A longer TTL only reduces overlap.
- **Files.**
  - `src/agent/loop.ts`, `src/agent/lock.ts`, `src/agent/provider.ts`
  - `src/core/pipeline.ts` (`deadline` in `TURN_SHAPE_FAILURES`, no parser fallback),
    `src/core/orchestrator.ts` (post-resolve and pre-execute checks)
  - `src/tools/types.ts` (an optional `signal` on the tool context)
  - `src/google/api.ts`, `src/google/oauth.ts`, `src/ical/fetch.ts`, `src/lookup/http.ts`,
    `src/lookup/quotes.ts`
- **Tests (test first).**
  - `LOCK_TTL_MS ≥ TURN_DEADLINE_MS + MAX_WRITE_MS` (fails when a constant changes).
  - A fake-timer turn past the deadline ends with `deadline` and makes no further model call: no
    agent call, no parser, no read-only try.
  - A fake slow read is aborted at the deadline: a calendar read where the 3rd of its sequential
    requests hangs, and a token refresh that hangs.
  - **Deadline boundary cases (fake clock, fake tools, fake NLU, fake read-only provider):**
    - (a) **W3:** a write whose `execute` starts 1 s before the deadline, takes 5 s and succeeds.
      The reply is the write's own success text, not `deadline`. No further model call, no parser
      call; history appended; the lock is still held at the end.
    - (b) The model's write call arrives after the deadline: `execute` is never called. The turn
      ends `deadline`, and the fake NLU and the read-only provider are **never called**.
    - (c) **W1:** a write tool's `resolveAsync` read is in flight at the deadline. It is aborted,
      `execute` is never called, the reply is `he.agentFailed('deadline')`, and the audit outcome is
      `deadline`.
    - (c2) **W2:** `resolveAsync` completes 1 ms after the deadline. `execute` is never called, and
      the reply is the same as (c).
    - (d) **R2:** a read returns before the deadline, and the deadline passes before the next model
      call. No next model call; the reply is that read's code-rendered text.
    - (d2) **R1/R3:** a read whose fetch is pending at the deadline, and a read whose data arrives
      in the same tick as the abort. Both reply `he.agentIncomplete`; no data from the aborted
      request is shown; no next model call.
    - (f) A provider request in flight at the deadline: the result is `deadline`, not
      `timeout`/`network_error`. No parser call, no read-only call, no further model call.
    - (e) **W4:** a write whose own fetch timeout fires reports failure, as today. This pins the
      documented pre-existing limit, and the test name says so.
  - A grep test: every `fetch` reachable from read tools is in the covered list.
  - Existing failover and timeout tests stay green.

### T4 — A typing step types only into the field the routine tapped (F3) · P2

- **Current.** `pickField` picks the single focused editable non-password field, else the only field
  on screen. `type()` re-checks package, visibility, enabled, editable and password.
- **Steps between the tap and the typing are allowed.** `problem()` (`RoutineLogic.kt:106-117`)
  constrains only where checks go, so `TAP field → WAIT → TYPE_TEXT` and
  `TAP field → WAIT_FOR_TEXT → TYPE_TEXT` are valid routines. A direct-adjacency rule would be
  bypassed by an ordinary pause.
- **Proposed (device only).** A field **anchor**.
  - When a `TAP_TEXT`/`TAP_ID` step hits an editable field, that *step* becomes the anchor.
  - The anchor survives `WAIT`, `WAIT_FOR_TEXT`, `TYPE_TEXT` and `SUBMIT`.
  - Any other tap clears it.
  - At a `TYPE_TEXT`/`SUBMIT` with an anchor, the runner **re-resolves the anchor step's own
    selector** on the current snapshot (`pickTarget` with that step's value):
    - **One match, focused:** type.
    - **One match, not focused, while another field has focus:** stop with a new reason code, e.g.
      `field_changed`. This is the demonstrated gap: the target is still on screen but focus moved
      elsewhere.
    - **Several matches:** stop (today's ambiguity rule).
    - **No match:** stop with `field_changed`. The anchored field is gone, so falling back to
      whatever is focused would defeat the anchor.
  - **Correction from an earlier round:** the FID routine does not need a fallback. It is
    `TYPE_TEXT "סטימצקי"` → `TAP_ID button_search` (`docs/plans/routines-typing.md:4-7`): it types
    into the first screen's only field with **no** preceding tap, so it never creates an anchor and
    keeps today's rule.
  - **Search launchers:**
    - Most "fake" search boxes are non-editable views. A tap on one creates no anchor, because the
      anchor needs an editable hit (`pickTarget` already distinguishes `editable`,
      `RoutineLogic.kt:218`), so the routine keeps today's rule.
    - Only a launcher that is itself an editable field and navigates away when tapped would now
      stop with `field_changed`. That fails safe and visibly, and the user can rebuild the routine
      without that tap.
  - It keeps no `AccessibilityNodeInfo` from earlier. A held node can go stale or be reused after a
    refresh, scroll or transition. Re-resolving by the routine's own words or id is what the tap
    itself trusted.
  - Without an anchor, a routine that types into an autofocused field, today's rule stays.
- **Screen and window changes**, checked against existing guards:
  - **Overlay or another app** (a dialog from the system or a different package): `snapshot()`
    requires the root window to be the routine's package, and `click`/`fieldUsable` re-check it
    (`RoutineAccessibilityService.kt` `snapshot`, `fieldUsable`). The run stops with `app_left`.
  - **In-app dialog over the screen:** the field underneath usually stays in the tree. A dialog
    field matching the same selector would make two matches and stop the run. If the underlying
    field is gone, the anchor finds no match and the run stops.
  - **The app navigates to another screen with an identically named field** (same hint or id),
    which is focused: the anchor accepts it, because the selector is the user's own definition of
    the target. A hint or id is the same contract the tap itself trusted.
  - **App loses and regains focus:** while it is away, every snapshot is null (package check). When
    it is back, the same rules apply.
  - **Rejected: a window-id check.** Selector, focus and package checks are enough with the strict
    no-match rule, and a window id can change on legitimate in-app transitions. A screen fingerprint
    was rejected as fragile.
  - **Residual risk, documented:** a routine with no field tap (FID-style) still types into the one
    focused field, as today. The tap is the only signal of which field was meant.
  - The code goes into the closed `RUN_REASONS` in `src/render/routines.ts:23`, which also holds the
    Hebrew wording. That wording is written with the hebrew-content-writer skill.
  - `src/channels/app/parse.ts:249` (`z.enum(RUN_REASONS)`) enforces it on the wire.
  - On the app side, the reason goes in `RoutineAccessibilityService`/`RoutineRunner`. If the
    reasons appear in `Protocol.kt`'s test vectors, they need the matching vector too (HANDOFF §4).
- **Why not more.** The text is the user's own fixed string, in an app the user picked, on a
  confirmed run. An app denylist is not enforceable in a meaningful way (§4). This closes the one
  realistic wrong-context path: autofocus moving to a different field.
  - The app keeps its own closed `REASONS` set (`RoutineRunner.kt:33`) and maps any reason not in it
    to `"error"` before sending (`:90`). `field_changed` must be added there too, or it silently
    arrives as `error`.
- **Mixed versions** (traced, not inferred from names):
  - Reasons flow **only app → server**, in `/app/routine/result`. The server never sends a run
    reason to the app. The claim refusal reason is read leniently with `optString`
    (`Api.kt:302`) and is not part of this change.
  - **Old APK + new server:** the old app never sends `field_changed`. Safe.
  - **New APK + old server:** `z.enum` rejects the result with a 400. The app retries 3 times, then
    stores the report and re-sends it at the next process start (`RoutineRunner.kt` `report`,
    `keep`, `flush`). Nothing re-runs: a claim is single-use. Meanwhile the run turns `unknown`
    through the stale-claim timer, and the stored report settles it once the server is upgraded,
    since `settle` accepts from `unknown`.
  - So server-first is the safe order. The reverse order only delays a result; it never repeats an
    action.
- **Sequencing.** After the uncommitted 0.13.3 app change is committed; take the next version
  number. Deploy the server first.
- **Tests.**
  - `RoutineLogicTest.kt`:
    - anchored field still focused → One;
    - another field focused → `field_changed`;
    - **TAP field → WAIT → TYPE** with focus moved during the wait → `field_changed`;
    - TAP field → WAIT_FOR_TEXT → TYPE → SUBMIT with focus kept → runs;
    - **screen transition, anchored:** tap an editable field → the app navigates → the selector is
      gone and a different field is focused → `field_changed`, nothing typed;
    - **screen transition, launcher:** tap a non-editable search launcher → new screen with one
      focused field → types (no anchor; today's rule);
    - FID-style `TYPE_TEXT` with no tap → today's rule, unchanged;
    - a target still present but unfocused while another field is focused → `field_changed`;
    - a non-field tap clears the anchor;
    - the anchor selector matching two fields → stop.
  - Server: a `parse.ts` test accepts `field_changed`, and `render/routines.ts` renders it.
  - Mixed-version acceptance, as a server unit test: an old-server schema, i.e. `RUN_REASONS`
    without the new code, rejects it with a 400; the run settles from `unknown` when the report is
    re-sent to the new schema.
  - The app's `REASONS` contains every server `RUN_REASONS` value. The lists live in two languages,
    so this is a `Protocol`-style test vector or a checklist item.
  - On a physical device: §6.
- **Pre-existing NIT, not in scope:** a permanently rejected report is retried at every process
  start forever. That is harmless, but worth a cap if this code is touched.

### T5 — Logger hygiene, not a redesign (F5) · P2

- **Where the guarantee has to come from.** A logger-side pattern such as `^[A-Za-z0-9_.:-]{1,64}$`
  does **not** keep free text out. It admits a digit-only string, such as a phone number, and any
  single alphanumeric token. A stricter pattern (start with a letter, no long digit runs) would
  break real codes: `E_WA_${code}` carries Meta's 6-digit error codes, and `E_ICAL_HTTP_${status}`
  an HTTP status. An explicit enum allowlist would have to enumerate those templates and the typed
  unions (`AsrErrorCode`, `NluErrorCode`, `error.code` from Google, agent and provider results).
  That is real maintenance for no gain over fixing the sources. The grep of all `errorCode:` values
  shows literals, typed codes and those templates, and exactly **three** free-text sources:
  `orchestrator.ts:240, 592, 636`.
- **Proposed.**
  1. **At the source (the guarantee):** the three sites log `error.name`, or the code of a known
     code-carrying class (`ToolInputError`, as `:465` already does). Never `error.message`.
  2. **Regression guard.** The behavioural guarantee is the canary test, not a regex.
     - Every tool's `resolve`, `execute`, confirmed execute and `undo` errors pass through the same
       three generic catch sites in `orchestrator.ts`. So a test that makes a fake tool throw an
       `Error` whose message is the canary, through each site, checks the sink for **all** tools,
       whatever shape a future refactor gives the code. A local variable holding `error.message`
       would still fail that test.
     - Also extend `test/security/banlist.test.ts`, which already scans the source with regexes, to
       refuse `errorCode:` followed by `.message`. This is a cheap tripwire for the obvious form,
       explicitly bypassable, and not relied on.
     - A catch site added elsewhere later is not covered automatically. The agent log canary
       (`test/security/agent-log-canary.test.ts`) and the review checklist in `add-tool` are the
       backstop; no static analysis is added.
  3. **Defence in depth (not a guarantee):** in `createLogger`, an `errorCode` that is not a string,
     is longer than 64 characters, or contains whitespace or non-ASCII becomes `E_UNCLASSIFIED`.
     This catches the obvious accident, and the plan does not claim more.
  4. Fix the header comment: there is no phone hashing in `redact()`, and it is a denylist.
  5. `seen`: track the **ancestors on the current path**. Add before recursing into an object,
     remove after. A real cycle (an object that is its own ancestor) is still `[circular]`; a shared
     sibling is logged in full. That is the correct distinction. The current WeakSet loses data but
     leaks nothing, so this is a one-line-scale fix bundled here, not its own task.
- **Why not an allowlist per event.** About 150 call sites across 23 files would each need a schema.
  The denylist plus no-console lint plus canaries already cover the realistic paths, and the one
  concrete gap is free-form error text, closed at the source.
- **Tests.** Extend `test/unit/security/redact.test.ts`, the canaries and the ban list:
  - A `SyntaxError` carrying the canary, thrown in `resolve`, `execute` and `undo`, never appears in
    the sink.
  - The ban-list test fails on a fixture line `errorCode: e.message`.
  - An `errorCode` with spaces or Hebrew becomes `E_UNCLASSIFIED`.
  - A shared object is logged twice in full; a real cycle is still `[circular]`.
- Note: with `observability.enabled`, Cloudflare stores these logs for 3 days on Free, so this is
  data leaving the DO.

### T6 — Verify the zero-cost and retention assumptions at the account level (F7) · P2 (manual, no code)

What the public docs say (checked 2026-10-12), and what only the account can show:

| Provider | Public documentation | Check in the account |
|---|---|---|
| Groq | No inference inputs or outputs kept by default. Logs for abuse or reliability up to 30 days. ZDR "all customers may enable" in Data Controls. The page names no tier restriction, but doesn't say "free" explicitly. | The free tier has no payment method. The ZDR toggle is **available and on**: the staging `AGENT=on` comment in `wrangler.jsonc` depends on it. If the toggle is absent on this tier, record that and say so in PLAN §7 rather than claiming ZDR. |
| Gemini | Unpaid: may be used to improve products, human review, "do not submit sensitive… personal information". Paid only after **linking a billing account and prepaying (minimum $5)**, and paid terms do not use prompts for training. A billed project cannot also be free. | The API key's project has no billing linked. An accidental charge is unlikely (prepay needed). Linking billing would *improve* privacy terms, but end the zero-cost goal, and make the consent card's "may train" wording over-cautious. |
| Cloudflare | Workers Free: exceeding a free limit makes further operations fail, with no charge. DO 100k requests/day, 13,000 GB-s/day, reset 00:00 UTC. 1 GB per SQLite object. | The account is on Workers Free, not Paid ($5/month). |
| Finnhub | — | The key is a free plan. |

- **Fallback across providers** (from code): a smart conversation's turn runs on Gemini or, when
  Gemini cannot take it, on Groq qwen or gpt-oss (`pipeline.ts` `[...smartModels, ...providers]`).
  The turn's model then sees the same history and consented data. Consent belongs to the
  conversation, not to one provider. If Gemini fails before any tool ran, the parser and the
  read-only try on Groq also see the user's text and history.
  - So in one smart conversation, content can reach **two companies with different terms**.
  - Groq, per its docs: no inference inputs or outputs retained by default, but up to 30 days of
    logs for troubleshooting or abuse, unless ZDR is on. The page says nothing about human access or
    training.
  - Gemini unpaid: may be used to improve products, human review.
  - Neither is "nothing retained in every case".
- **Disclosure gap (small, recommended).** Three pieces of shipped copy are inaccurate or incomplete:
  - The smart-mode note (`strings.xml` `mode_smart_note`) names only Gemini.
  - The consent card says "the smart model asks for access" (`render/consent.ts` `card`), even when
    the turn runs on qwen.
  - **The regular mode is labelled "local"** (`mode_local` "שיחה מקומית", badge "מקומית"), with the
    note "the regular assistant, as until now" (`mode_local_note`). But those conversations are
    processed by Groq's hosted models, not on the phone. "Local" means "not Gemini" in the code
    (`mode: 'local'`). To a user it suggests the content stays on the device.
- **T6b, P2, app strings only, no routing change.** Hebrew copy is written at implementation with the
  hebrew-* skills; none is drafted here.
  - `mode_local_note`: say that the regular assistant is processed by Groq's hosted models. Keep
    only what Groq's docs support: content not retained by default, logs up to 30 days for
    troubleshooting or abuse, and no claim about training.
  - `mode_smart_note`: add that when Gemini is not available, the same conversation is answered by
    the regular assistant's model on Groq. Add that approvals given on a card apply to the
    conversation, whichever of the two answers. Never call that model "local".
  - The consent card is unchanged. With the note corrected, "the smart model" is acceptable shorthand
    for "this conversation's model".
- **Two permissions, kept distinct.**
  1. Processing by an external AI provider is agreed **when the mode is chosen**. The mode notes
     carry it, and after T6b they name Google for smart and Groq for regular and fallback.
  2. Access to a data source is agreed **on the consent card**, per source.

  Source approvals stay valid when a smart turn falls back to Groq. This is the intended policy
  ("consent belongs to the conversation", `agent/tools.ts`), and it is safe for a specific reason:
  Groq is the regular mode's provider. It already receives the same categories of data in every
  regular conversation, under data minimisation but without cards. So a fallback never sends data to
  a company the user's setup does not already send it to.
  - A per-provider approval would add a card at every fallback, for no new recipient. Rejected.
- **Deferred (P3, optional): a per-reply "answered by" indicator.** The outbox's `smart` flag means
  "smart mode available" (`assistant-do.ts:1004`), not which model answered. A per-reply provider
  marker would need a wire field and app UI. It adds transparency but no protection. Revisit only if
  the user wants it.
  - **D4 (user decision):** keep the label "מקומית", whose meaning the corrected note then explains,
    or rename the regular mode. Renaming touches `mode_local`, `mode_badge_local` and any guide
    text. Recommended: rename, since the label itself carries the wrong implication. The internal
    `mode: 'local'` wire value stays either way.
  - It rides with the next APK.
- Local conversations never reach Gemini (`SMART_MODELS` is separate, and the loop filters smart
  providers, `loop.ts:357`).
- Outcome: "designed for zero cost" becomes "verified zero cost on <date>". It is not a code
  guarantee. No paid service is recommended.

### T7 — WhatsApp webhook reads through the byte cap (F4) · P3 (P2 if production WhatsApp is live)

- Replace `c.req.text()` with `readCapped(c.req.raw, MAX_WEBHOOK_BODY_BYTES)`; it is already
  portable. Pass the HMAC function the bytes: an `hmacSha256Hex` overload taking `Uint8Array`. Decode
  to a string only for `JSON.parse`, **after** the signature passes. The early `Content-Length`
  refusal comes free.
- This preserves invariant 9's order. It is strictly more faithful to "the exact bytes", since today
  an invalid UTF-8 body is decoded with replacement and fails HMAC; that is fail-safe, but not exact.
- **Tests.** Update `test/unit/.../verify.test.ts`. A body of `cap + 1` bytes made of multi-byte
  characters is refused, where its string length is under the cap. A streamed oversize body is
  refused without being fully buffered. Meta's signature test vector still passes.

### T8 — Stuck `running` turn answers `unknown` (F8) · P3

`agent_turns.created_at` is the suspend time, not the claim time (`turns.ts:193-200`), and a turn may
wait 3 min before it is claimed. So age cannot decide this; a time check would wrongly answer
`unknown` for a live turn. Use the lock instead: a resumed turn holds the agent lock under its wamid
(`pipeline.ts:1000`, `:1089`), and the lock expires on its own after eviction.
- Add `AgentLock.heldBy(principal, turnId)`, a synchronous lookup. It must check
  `expires_at > now`, because expired rows are deleted only inside `acquire` (`lock.ts:22`).
- In `duplicateStatus` (`assistant-do.ts`), a `running` row whose wamid holds no live lock → `unknown`.
  The same applies to the `begun.kind === 'settled' && status === 'running'` branch of
  `appDeviceResult` (`assistant-do.ts:~1410`).
- No migration.
- **Timing, verified:** there is no window in which a live turn is `running` without its lock.
  - Phone resume: `begin()` (sync) and `resumeFromPhone`'s `lock.acquire` (`pipeline.ts:1000`)
    have no `await` between them, and the Worker isolate is single-threaded.
  - Consent resume: `beginConsent` and the acquire share one transaction (`pipeline.ts:1085-1089`).
  - A lost acquire marks the row `superseded`, not `running`.
  - The row becomes `done` before the lock is released (`:1040-1041`).
- **Depends on T3.** Today a slow turn can outlive its 60 s lock, and T8 would then call a live turn
  `unknown`. T3's deadline-bound TTL removes that case.

Tests:
- A live running turn holding its lock → `pending`.
- Simulated eviction (no finish), clock advanced past the lock TTL → `unknown`.

Optionally include F17 here.

### T9 — Provider failure tests (F9) · P3

Groq agent provider: a 500 and a 503 → `provider_error`, and the model is not marked exhausted. A 200
with a non-JSON body → `invalid_json`. A tool call with malformed `arguments` is already covered
(`agent-turn.test.ts:165`).

### T10 — Scrub separators (F10) · P3

Write failing cases first (`050.123.4567`, `050/123-4567`, a Hebrew-local-part email) in
`test/unit/security/scrub.test.ts`. Then widen the phone separators and the email local-part class.
Keep times (`14:00`) and dates (`25.9`) unscrubbed; add those as negative cases.

### T11 — Retention of settled rows (F12) · P3, after verification

**Verified:** no `DELETE` on `reminders` or `audit_log` anywhere in `src/`.
- `audit_log` holds tool name, tier, decision, an input digest, outcome and an external ref, with no
  content. Rate limits read only its last 24 h (`repo.ts:527-544`). Its privacy weight is low, and
  its growth is the only reason to purge (for example after 90 days).
- `reminders.text` is plaintext, kept forever for terminal statuses (`sent`, `done`, `failed`,
  `cancelled`; `migrations/0003:17`).

A purge must:
- touch only terminal statuses older than N days;
- leave `scheduled` and `sending` rows alone;
- be checked against repeat reminders (`reminders.repeat`), so that no row a recurrence still
  depends on is removed. Read `reminder-store.ts` before writing it.

**N is a product decision (D3):** does a delivered reminder have value later, for example "what did
you remind me last week?". Notes, expenses and facts are user content with explicit delete; they
stay. Optional maintenance, not part of the core roadmap.

### T12 — One routine run at a time on the device (F14) · P3, optional

`RoutineRunner.claimAndRun` refuses to claim while the service reports a run in progress, and reports
a reason code (e.g. `busy`). Both sides' closed reason sets need it. Do it only alongside T4.

## 4. Changes not recommended

| Suggestion | Why not |
|---|---|
| Per-event allowlist logging schema | About 150 call sites to annotate. The denylist plus `no-console` lint plus the ban-list test plus canaries cover the realistic paths. The one real gap (free-form `errorCode`) is closed by T5 at its three sources. |
| An explicit enum allowlist for `errorCode` | Dynamic codes (`E_WA_<Meta code>`, `E_ICAL_HTTP_<status>`, typed `error.code` unions) would all need enumerating and maintaining, for no gain over fixing the only three free-text sources and guarding them with the ban-list test. |
| Lock renewal or a heartbeat | Renewal at step boundaries still cannot bound one long read (a calendar read chains about 11 requests). The turn signal is needed anyway, and once it exists, a static TTL from the deadline is valid. |
| Information-flow tracking finer than one turn (per sentence or token) | Turn-level provenance, mirroring the existing `tainted` propagation, over-redacts but never under-redacts. Anything finer would mean analysing model output. |
| Running live-model evals in CI | Each run burns the same daily free quota the bot uses (200K tokens/day per Groq model, plus a few hundred Gemini requests) and is non-deterministic. CI already runs the deterministic agent tests (fake providers, policy, confirm, injection paths in `test/unit/agent/*`). Gate releases instead (T2). |
| A local daily token cap for Groq | The provider enforces it, with a 429 and no charge on the free tier. The code already backs off (`budget.ts`) and tells the user. A local copy would drift from Groq's unpublished daily accounting. The real control is account settings (T6). |
| App allowlist/denylist or "sensitive app" detection for routines | Routines are authored only by the user, on the phone. The server never sees steps. A scheduled run is Tier 2 with confirm and refuses tainted turns. The accessibility service is limited to the routines' packages at runtime. Any list would be incomplete (thousands of banking or messaging apps), and the user could add the app anyway. T4 closes the concrete wrong-context path. Revisit if PLAN's next step lets the bot *build* routines (HANDOFF §6): that changes the trust model and needs its own review. |
| Separate risk tiers for "send/delete/purchase" routine steps | The device cannot know what a tap means in a third-party app. Labels are text matches, not semantics. Any classification would be guesswork presented as a safety guarantee. |
| Escaping separators in `stepHash` | A collision needs a pasted tab or newline in a single-line field, and it would only make two of the user's own step lists hash alike. Changing the format invalidates every confirmed scheduled run and every synced hash. |
| Splitting `assistant-do.ts` / `pipeline.ts` / `registry.ts` | Size alone is not the risk. Policy lives in one place (`orchestrator` → `policy/engine.ts` → `confirm/`), history has one writer (`settleAgentResult`) and one reader (both in `pipeline.ts`), and the registry is a deliberate single source checked at compile time. Splitting would spread the ingress-order and transaction invariants across more files. The real growth limit is the catalog token budget (F11), not file size. |
| Content-Length-only check on the webhook | Not trustworthy alone. T7 uses `readCapped`, which counts the bytes actually read. |
| Retrying the cron | Purges and expiries also run from `alarm()`; the digest is awaited. Workers Free does not retry crons, and a retry would risk a double digest. |
| Encrypting `app_outbox.text` at rest | Rows live 24 h (7 d for reminders) inside the user's own DO, which is already encrypted at rest by the platform. Field encryption would add key handling to the hot delivery path for little gain. Revisit with T11 if retention grows. |

## 5. Prioritized roadmap

**Phase 0 — none.** No confirmed critical or immediately exploitable issue.

**Phase 1 — privacy promise and release signal**

| Task | P | Depends on | Rollback |
|---|---|---|---|
| T1 history replay respects consent | P1 | user decision D1 | Reverting leaves history readable. A suspended state with the new field fails an old build's strict schema and ends as `E_AGENT_STATE`, which affects at most 3 min of in-flight turns. |
| T2 eval exit code + release gate | P1 | — | Script only |

**Phase 2 — robustness at the boundaries**

| Task | P | Depends on | Notes |
|---|---|---|---|
| T3 turn deadline + abort signal for reads + TTL from it | P2 | — | Test first. Revert is code-only (no stored state). |
| T4 typing bound to tapped field | P2 | the uncommitted 0.13.3 change committed; next app version | **Deploy the server first** (new reason code), then the APK. A reverted server with a new APK delays results; it never re-runs. |
| T5 `errorCode` fixed at its sources + ban-list guard | P2 | — | — |
| T6 account verification | P2 | human | Record in PLAN §13/§14 |
| T6b mode notes: regular mode is Groq-hosted; smart falls back to Groq | P2 | next APK (with T4); D4 (label) | Hebrew strings through the skill |

**Phase 3 — small correctness and hygiene**

| Task | P | Depends on |
|---|---|---|
| T7 webhook `readCapped` | P3 (P2 if production WhatsApp is live) | — |
| T8 stuck `running` → `unknown` (+ F17) | P3 | **T3** (otherwise a slow live turn reads as `unknown`) |
| T9 provider failure tests | P3, optional | — |
| T10 scrub separators | P3, optional | — |
| T11 terminal-row retention | P3, optional | D3 (N), repeat-reminder check |
| T12 one routine run at a time | P3, optional | T4 |

Phase 3 items are maintenance, done when the file is touched anyway. They are not release
blockers.

Each task is one small PR. After any change to `src/agent/`, run `pnpm eval:agent --filter` for the
affected cases (CLAUDE.md). Changes that touch architecture or behaviour (T1, T3, T4) update PLAN §14,
plus HANDOFF/ARCHITECTURE where modules, tables or coupling change (the docs-guard hook enforces this).

## 6. Testing strategy

**Keep (deterministic, every commit, already in CI).**
- typecheck, lint, vitest: 2,317 tests including security canaries, the ban-list scan and the CPU
  budget.
- gitleaks and `pnpm audit --audit-level high`.
- Agent turn tests with fake providers, covering:
  - policy and confirm,
  - invalid args,
  - 429 and timeout failover,
  - taint,
  - consent suspension.
- The routine lifecycle (`test/unit/tools/routines.test.ts`) and `RoutineLogicTest.kt`.
- `fit.test.ts`, the catalog-headroom guard.

**Add (deterministic).**

| Test | Task |
|---|---|
| Revoke → placeholder; **propagation** (a tool-less follow-up repeating the data is also redacted after revoke); legacy untagged smart entry → placeholder; **suspended turns s1–s6** (a revoked source from this turn's tool results or from history never reaches the model on resume; still-granted and "this time" data proceed; legacy smart state ends); own-input reply still replayed; `once` → placeholder (if D1 = a) | T1 |
| Exit 1/2/0 by mode; zero-case gate prints `n/a` and blocks exit 0; no fingerprint printed after a failed gate; a `judging` mismatch fails `fingerprint.test.ts`; changing a model's id or provider changes its fingerprint; a re-score refuses a recording with a different fingerprint; `deploy:staging` refuses on a stale fingerprint; config test for production `AGENT=on` | T2 |
| `LOCK_TTL_MS ≥ TURN_DEADLINE_MS + MAX_WRITE_MS`; boundary cases (a)–(f): W1/W2 never execute, W3 answers as itself, W4 pinned, R1/R3 show no data, R2 shows the read, a provider abort is `deadline` with no parser or read-only call; hung calendar request and token refresh aborted; grep test that every read-path `fetch` takes the signal | T3 |
| Anchor logic including TAP → WAIT → TYPE with focus moved; `field_changed` accepted by the new schema and rejected by the old (mixed version); settles from `unknown` on re-send; app `REASONS` ⊇ server `RUN_REASONS` | T4 |
| Error-message canary through `resolve`/`execute`/`undo`; ban-list regex on `errorCode: …message`; backup normalization; shared object vs real cycle | T5 |
| Multi-byte oversize body refused; streamed oversize not buffered | T7 |
| Stale `running` → `unknown` | T8 |
| Groq 500/503 and `invalid_json` | T9 |
| Scrub positive and negative cases | T10 |

**Live providers (manual, quota-bounded, before release).** `pnpm eval` after `src/nlu/` changes, and
`pnpm eval:agent --filter …` after `src/agent/` changes, with T2's exit code. Owed per PLAN §13,
unchanged by this plan: a full qwen `--select-tools` run before production `AGENT=on`; Gemini
`--model gemini-3.5-flash-lite` with a human read; the s2 and `pf-`/`mem-`/`li-` filters.

**Physical Android device (cannot be unit-tested).**
- T4: an app that autofocuses a different field, and a run must stop with `field_changed`.
- Screen off without a keyguard: do taps and typing work, and is the result reported?
- Locked phone: the run waits for unlock, then `blocked` after 2 min.
- Two runs due within a minute (F14).
- Doze or battery saver: FCM data push arrival for a scheduled run. Unverified; also check the push
  priority in `device/fcm.ts`.
- "Allow opening another app?" dialog.

**Staging.** After T1, a smart conversation on the phone: allow the calendar, ask, revoke with
`/consents`, ask a follow-up, and check that no calendar title is in the next request. Verify through
a temporary log of the replayed entry *kinds* (counts only, never text), or through the unit test
alone.

**Release gates.**
- Enforced in code:
  - CI green;
  - `deploy:staging` runs the fingerprint test;
  - the config test refuses production `AGENT=on` without a matching `evaluated`.
- Manual, and documented as such: the `--filter` live evals per change; server before APK for any
  wire change; production deploys (human-only).

## 7. Dependencies, risks and open questions

- **D1 (user decision, blocks T1 step 4):** should a "this time" approval's reply be kept for
  follow-ups in the smart history (today), or replaced by a placeholder? Consequences are in T1
  step 4. Recommended: placeholder. Mail, SMS, contacts and notification text then reaches a model
  only within its one allowed turn, possibly in several calls to that turn's one model. The cost is a
  new card on a follow-up.
- **D2 (user decision, at T1 deploy):** accept the one-time loss of up to 12 h of smart-conversation
  context, since legacy entries are replayed as placeholders. Recommended: yes.
- **D3 (user decision, only if T11 is done):** how long to keep delivered or cancelled reminders.
- **D4 (user decision, with T6b):** keep the regular mode's label "מקומית", explained by its note,
  or rename it. Recommended: rename.
- **Is production deployed with `CHANNEL=whatsapp`?** Its vars are mostly empty. If it is not live,
  T7 stays P3.
- **Provider settings (T6)** are unverifiable from code.
  - The Groq docs say all customers may enable ZDR, but don't say explicitly that the free tier can.
    If the toggle is missing in this account, PLAN must stop implying ZDR.
  - The Gemini terms say not to submit sensitive or personal information to unpaid services. The
    consent design already reflects that, but the user should know it is Google's own advice.
- **Ordering.** T4 and T12 wait for the uncommitted 0.13.3 app change. T4 needs server-then-APK. T1
  is independent of the routines work.
- **Backward compatibility.**
  - T1 adds an optional field inside the encrypted history JSON and inside the suspended-turn state;
    no migration.
    - Legacy history is redacted in smart conversations (D2).
    - A **smart** turn suspended before the deploy, without `historySources`, ends instead of
      resuming. That affects at most 3 min of in-flight turns, at deploy only, and leaves no residual
      window. Legacy local suspended turns resume as today.
  - T4 adds a closed reason code on both sides; an old server's `z.enum` rejects an unknown code from
    a new app, hence server first.
  - T8 uses the lock table, not a new column.
  - T11 is the only one that might add a migration (an index), if needed.
- **Growth limit (F11, deferred decision).** The full catalog has ~100 tokens of headroom. Before
  adding any agent tool, settle PLAN §13's options (shorter descriptions, or a higher qwen `turnCap`
  within its 8K bucket). Otherwise new tools silently push turns into the parser fallback.
- **Safe to defer:** T11, T12, and the F17 status signal.

## 8. Definition of done

- CI green: typecheck, lint, tests, audit, gitleaks.
- The new deterministic tests in §6 exist and pass.
- After T1, in a smart conversation, data that entered through a tool reply from a source no longer
  allowed is not replayed to a model in a later turn:
  - not directly;
  - not through a later reply that saw it;
  - not through a legacy entry;
  - not through a resumed suspended turn, whether the data came from replayed history or from a
    tool result earlier in the same turn (tests s1–s6). The exception is a "this time" approval,
    whose documented scope is the whole turn.

  Unit tests prove it by inspecting what the fake model received. The user's own typed words are out
  of scope (invariant 2), and PLAN §7.1 says so. The comment, PLAN §6.19/§7.1 and the code agree on
  what "this time" keeps (D1).
- A "this time" grant is documented as one turn's data for that turn's one model, not one request.
- `pnpm eval:agent` returns 1 on a hard-gate miss (any run, with cases) or a soft-metric miss
  (complete run), and 2 on an incomplete run. A gate with zero cases is `n/a`, never a pass. It
  prints a fingerprint only after a complete pass with every gate non-empty.
  - `pnpm deploy:staging` refuses a stale fingerprint.
  - The config test refuses production `AGENT=on` without the primary's matching `evaluated`.
  - Production deploys stay manual, and the runbook says so.
- Every model call and every read-path `fetch`, the token refresh included, stops at the turn
  deadline. A grep test covers all of them, and `LOCK_TTL_MS ≥ TURN_DEADLINE_MS + MAX_WRITE_MS` is
  asserted by a test. A write started before the deadline is allowed to finish, within the lock,
  and its own reply is the turn's reply: the deadline never reports a successful write as failed.
  No write starts after the deadline. A deadline ends as `deadline`, never as a provider failure,
  and leads to no parser call, read-only try or further model call. An aborted read is never shown
  as data (boundary tests (a)–(f)).
- On a physical phone, a routine whose focused field changed, including across a wait step, stops
  with `field_changed` and types nothing. Mixed-version tests pass.
- No shipped copy says or implies that the regular mode runs on the phone. The smart-mode note
  discloses the Groq fallback, and that approvals cover the conversation (T6b).
- `evaluated.judging` matches the current expectations, scoring and thresholds, enforced in CI; the
  remedy is a zero-quota re-score.
- The eval fingerprints include the model id and provider: changing either invalidates
  `evaluated`.
- A routine anchored to a field that has lost focus or disappeared stops with `field_changed`.
  Routines with no field tap, the FID routine among them, and those tapping a non-editable launcher
  behave as today, verified on the phone. Unit tests alone do not establish this across real apps.
- None of the three known sites puts `error.message` in `errorCode`. The ban-list test refuses the
  pattern, and a canary test shows an exception message never reaches the sink.
- Account settings for Groq, Gemini and Cloudflare verified and dated in PLAN.
- `pnpm eval`/`eval:agent` filters run for any NLU or agent change, with thresholds met.

## 9. Reference appendix

**Source read.** `src/index.ts`; `src/channels/app/ingress.ts`; `src/channels/whatsapp/{verify,limits}.ts`;
`src/security/{redact,hmac,scrub}.ts`; `src/core/{pipeline,orchestrator,quota}.ts`;
`src/agent/{lock,turns,consents,history,loop,models,provider,budget}.ts`; `src/tools/{routines,routine-store,registry}.ts`;
`src/platform/assistant-do.ts`; `apps/call-companion/.../{RoutineLogic,RoutineAccessibilityService,RoutineRunner,RoutineRunActivity,RoutineStore,RoutinesActivity}.kt`;
`wrangler.jsonc`; `.github/workflows/ci.yml`; `package.json`.

**Tests referenced.**
- `test/security/{log-canary,agent-log-canary,app-log-canary,banlist}.test.ts`
- `test/unit/security/redact.test.ts`
- `test/unit/agent/{fit,fingerprint,failover,budget-reservations,agent-turn,smart-turns,gemini-provider,provider}.test.ts`
- `test/unit/tools/routines.test.ts`
- `RoutineLogicTest.kt`
- `test/evals/{run-evals,run-agent-evals,fingerprint,ledger}.ts` and the `cases.*.yaml` files

**Docs.** CLAUDE.md invariants 1–13; HANDOFF §4/§6; PLAN §6.19, §6.27, §7, §13, §14;
`docs/plans/routines-schedule-ux.md`.

**External (checked 2026-10-12).**
- Gemini API terms (unpaid: used to improve products, human review, "do not submit sensitive…
  personal information"; updated 2026-04-28): https://ai.google.dev/gemini-api/terms
- Groq data (no inference retention by default; up to 30 days for abuse or reliability; ZDR
  available to "all customers"): https://console.groq.com/docs/your-data
- Workers limits (100 MB body on the Free plan, 128 MB memory, 10 ms CPU): https://developers.cloudflare.com/workers/platform/limits/
- Workers Logs (3-day retention on Free, 200k events/day, `console.log` captured): https://developers.cloudflare.com/workers/observability/logs/workers-logs/
- Durable Objects limits and pricing (Free: 100k requests/day, 13,000 GB-s/day, errors when
  exceeded, SQLite 1 GB per object on Free): https://developers.cloudflare.com/durable-objects/platform/limits/ ,
  https://developers.cloudflare.com/durable-objects/platform/pricing

**Checks run during this investigation**, on the working tree as it was at the start: `cc0a79b` plus
the routines changes that were then uncommitted and have since been committed as `4bb7fd8`. Re-run
them at HEAD before starting:
- `pnpm typecheck`: exit 0.
- `pnpm lint`: exit 0.
- `pnpm test`: 130 files / 2,309 tests passed, plus `test:timing` 1 file / 8 tests passed.

Live evals were not run (quota and cost).

