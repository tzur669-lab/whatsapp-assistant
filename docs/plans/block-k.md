# Block K — the bot learns the user ("אימון")

## Context

The user wants the bot to get more accurate for them from period to period: keep
small things and insights in a file, add to it over time, and every period either
the bot acts on it or the user hands the file to Claude Code to improve the bot.

User's decisions (2026-10-14, this session):
- **Sources:** mistakes and corrections, habits from usage, and a short weekly question.
- **Who acts:** both — the bot proposes weekly changes for one-tap approval; once a
  month the user exports a file and Claude Code turns it into code/prompt/eval fixes.
- **Where:** on the server (encrypted), exported to the phone as a file on request.

Reused, not duplicated:
- Misses (§6.23): `src/core/exchanges.ts` — `last_exchange` (1 h, `seq` column, write
  only when seq not older, `:62`), `misses`; `keepExchange` in `pipeline.ts:714-722`;
  `scripts/misses-to-evals.ts`.
- Encryption: `security/crypto.ts` (AES-GCM, bound to principal + row), as in `fact-store.ts`.
- Settings: `getSetting`/`setSetting` (`repo.ts:123-131`); digest once-a-day pattern
  (`digest_sent_on`, mark before send, `assistant-do.ts:1130-1133`).
- Buttons: closed kinds/verbs in `src/confirm/pending.ts:296-315`, dispatch in
  `orchestrator.ts:586-603`.
- Signed app routes like `GET /app/watches` (block J4) and the app's Downloads save
  (`DeviceActions.kt:355-384`, MediaStore).

## Principle

The learning journal is **code-built and never reaches a model**. Nothing learned
changes policy, tiers or limits (invariant 8). Learning ends only in:
1. a **preference** — a setting that also has its own chat command (the command
   ships first; a proposal calls the same setter);
2. the **monthly export** — for Claude Code to fix in code, behind tests and evals.

Invariant 4 is untouched: no learned value ever fills a missing time. (A "suggested
time" button on CLARIFY was considered and is **deferred** to PLAN §13 — it needs a
new deterministic open-question path and a §14 decision.)

## K1 — the journal (server, migration 0035)

- Commands (router, deterministic): `/learn` (status: on/off, counts per kind, oldest
  entry), `/learn on|off`, `/learn forget`. Off by default; `on` sends a code-written
  explanation of what is kept. Each `kind` carries the notice version that
  introduced it (`KIND_SINCE`); `learn_notice_seen` stores the version the user was
  shown. A kind is **collected only when `KIND_SINCE[kind] <= learn_notice_seen`**, so
  a new category waits for its disclosure. The hourly tick queues a stale notice once
  (setting `learn_notice_sent = {version, seq}` + outbox in one `transactionSync`, so
  it cannot repeat). State transitions, each inside the existing transaction of its
  path (`appAck` runs `this.sql.transaction`, `assistant-do.ts:1704`):
  - **Ack:** if `learn_notice_sent.seq` is among the acked seqs →
    `learn_notice_seen = max(learn_notice_seen, sent.version)` and clear
    `learn_notice_sent`. Otherwise nothing. The app acks only rows already committed
    to its chat store (`Api.kt:250-254`). Duplicate or stale acks find no match.
  - **Expiry:** `expireDue` clears `learn_notice_sent` only if its seq is one of the
    rows expiring now; the next tick queues the notice again with a new seq.
  - **Replace:** a new notice (repeat `/learn on`, a version bump) overwrites
    `learn_notice_sent`; an ack of the old seq then matches nothing.
  - `learn_notice_seen` never decreases (`max`), so an old version-2 ack after a
    version-3 disclosure cannot regress it.
  Meaning, documented: "seen" = stored in the app's chat, not read by eyes. It never
  blocks other messages. No approval step: `/learn off` remains the opt-out.
- `learn_since` (setting): set to now when the **initial disclosure is
  acknowledged** (`learn_notice_seen` moves from none to a version — the ack, or the
  WhatsApp send), not at the command; reset to now by `/learn forget` while
  collecting; cleared by `/learn off`. So activity between `/learn on` and the ack
  never enters the baseline.
- Per-version start: `learn_version_since` (one small JSON setting `{version: ms}`)
  records when each version became seen. A feature reads data at or after
  `max(learn_since, learn_version_since[KIND_SINCE[feature]])`. Derived features
  (the first-message time for `digest_hour`, the `learn_weeks` counters) are listed
  in `KIND_SINCE` like stored kinds. A later version therefore starts only its own
  new features at its ack and never resets the baseline of older ones.
- `learn_weeks` is bumped only while its feature is collectable (on, and its version
  seen), never merely while "on".
- Repeat `/learn on` while on, one behavior: if `learn_notice_seen` is current and
  nothing is outstanding → "הלמידה כבר פועלת", nothing changes. Otherwise (stale
  version or an outstanding notice) → re-send the current explanation, which
  replaces `learn_notice_sent` (app: the new reply's seq; WhatsApp: advances on a
  successful send), and say so. Never touches `learn_since`.
- The explanation is **cumulative**: rendered from every kind with `KIND_SINCE <=
  LEARN_NOTICE_VERSION`, the ones newer than the user's `learn_notice_seen` marked
  "חדש". So acking version 3 when version 2 was never acked has still disclosed
  everything version 3 enables.
- One disclosure rule for every notice, initial or later: a kind is collected only
  when `KIND_SINCE[kind] <= learn_notice_seen`, and `learn_notice_seen` advances only
  on the strongest delivery signal the channel has:
  - **App:** the `/learn on` reply's outcome carries `learnNotice: version`;
    `answerApp` → `acceptReply` (no await between, `assistant-do.ts:1558-1620`) writes
    `learn_notice_sent = {version, seq: row.seq}` in the same synchronous section as
    the outbox row. Then the ack gate below. If the reply never reaches the outbox
    (the turn throws → `E_TURN_FAILED`, `:1542-1549`), nothing is marked and nothing
    is collected; `/learn on` again re-sends it.
  - **WhatsApp (frozen):** `learn_notice_seen` advances after `send` returns success
    for that reply; a failed send marks nothing.
  - So between `/learn on` and the ack (seconds) the journal is "on" but collects
    nothing — fail safe. (Repeat `/learn on`: see the one rule above.)
- Every learning computation — habits from `inbound_messages`, `audit_log` or
  `learn_events`, and the trend's weeks — reads only data at or after its start
  (`learn_since`, and the per-version start above). So activity while learning was off, or before
  a forget, never shapes a proposal. A week that starts before `learn_since` is "no
  data", never a zero-error week. Operational tables are not touched. The `/learn
  on` text says the bot uses the times of messages sent while learning is on.
- While off, nothing learning-specific runs: no `learn_events` writes, no
  `learn_weeks` bumps (the bump in the fresh-`recordInbound` path checks that the
  feature is collectable), no review, no proposals, no question.
- `/learn off`: stops collecting and reviews, and sets every pending proposal to
  `cancelled` in the same transaction (its buttons then answer "פג תוקף"). Data kept.
- `/learn forget` reply lists exactly what was deleted (`learn_events`, `learn_weeks`,
  `learn_proposals`), says the "לא הבנת" list (`misses`, §6.23) stays under its own
  rules (`/misses`), and that files already exported to the phone are not touched.
- `learn_events(id, principal, kind, confidence, ciphertext NULL, meta TEXT,
  created_at)`; `confidence` is `CHECK (confidence IN ('reported','heuristic') OR
  confidence IS NULL)` — set only on `miss` (reported) and `rephrase` (heuristic), and
  validated again by a Zod enum on read and in the export schema. `meta` is closed
  codes and integers only. A **pair is one row**: the ciphertext is one encrypted
  JSON `{ failed, fixed }`, so retention, deletion, truncation and eval conversion can
  never split it. `kind` closed enum:
  - `miss` — on "לא הבנת"/`/missed`, a **copy** (own ciphertext) of what goes to `misses`.
  - `rephrase` — in `keepExchange`, **before** `record`: read the stored row with its
    `seq`; if `prev.seq < cur.seq`, prev ended with no tool run (fallback / CLARIFY),
    prev is < 3 min old, and the current turn was **understood** (a tool executed, or
    a confirm/choice card was shown — known at that point), store one `rephrase` row
    holding both texts. Then
    `record` as today. Conservative: both turns untainted, neither a voice note,
    shared/forwarded text, a command, a button or a screen task, and the current turn
    not a private tool (the same predicates `last_exchange` already uses for its
    placeholders: reuse them, don't re-derive). Stored with `confidence: heuristic`;
    a `miss` is `confidence: reported`.
  - `undo` / `confirm_no` — tool name and seconds; no text.
  - `leave` — `reminders.leave` minutes and `stated: 0|1`. `stated` is added to the
    strict leave input (`reminders.ts:683-690`) by resolve; the **pipeline** writes the
    event only after `execute` succeeds, from the stored input (declined or abandoned
    requests never count; no store on `ToolContext`).
- Write order for `rephrase`: decrypt prev, encrypt the pair row and the new
  exchange, then one
  synchronous block that re-checks `seq` and writes both (`record` awaits its encrypt,
  `exchanges.ts:55-57`).
- `learn_weeks(principal, week_start, messages, misses, rephrases)` — counters only;
  `messages` bumped only when `recordInbound` reports a fresh message (never on a
  dedupe replay); kept 26 weeks (the baseline outlives the 30-day inbound purge).
- Exclusions = `last_exchange`'s: tainted/shared/forwarded text, voice transcripts
  (`[הודעה קולית]`), private-tool replies, screen text → placeholder or skipped.
- Retention: events 60 days, newest 200 (trim like `exchanges.ts:103-109`), each text
  capped at 1,200 chars; purged in `runMaintenance`.
- Lifecycle: `/learn forget` deletes `learn_events`, `learn_weeks`, `learn_proposals`
  (not `misses`, which keep §6.23's rules). `/learn off` stops collecting, keeps data.
  `/forget`, `/forget memory` and `/pair off` do not touch learning (it is about the
  user, like facts) — a §14 decision, and the `/learn on` explanation says so.
- `src/core/learn-store.ts` is a pipeline dependency only (like `ExchangeLog`), never
  on `AgentServices`. Register the migration in `src/platform/migrations.ts`.

## K2 — weekly review and proposals (server, migration 0036)

- New preference command first: `/leave <minutes>` → setting `leave_default_min`
  (10–120); `reminders.leave` uses it instead of `DEFAULT_TRAVEL_MINUTES` only when set.
- Hourly tick: Sunday 10:00 Asia/Jerusalem (fixed, independent of the digest), if
  `/learn on`; key `learn_review_sent_on`. The review is built from local SQL only
  (decrypts happen first, no network), then **one `transactionSync`** marks the week
  and puts every message in the outbox (`AppOutbox.accept` is synchronous,
  `outbox.ts:85`); pushes are retried by the existing `duePushes`. So on the app
  channel it is exactly once into the outbox: nothing lost, nothing doubled. On the
  frozen WhatsApp channel it follows the digest's at-most-once rule
  (`assistant-do.ts:1130`) — documented, not fixed. One code-rendered
  message (`src/render/learn.ts`):
  - **Trend:** two rates per 100 messages — reported misses and auto-detected
    rephrases — each this week vs the mean of the prior 4 weeks (plus the combined
    rate). A week with 0 messages shows "אין מספיק נתונים"; fewer than 2 prior weeks
    → no comparison.
  - **Proposals, max 2**, `PROPOSAL_KINDS` closed:
    - `digest_hour` — setter shared with the existing `/digest N` (`router.ts:77`).
      Source: the existing `inbound_messages` (`received_at` ms epoch, `kind`; one row
      per message, the PK dedupes; kept 30 days, `0001_init.sql:9-18`). SQL only
      selects `received_at` for `kind != 'button'`, `decision` not `BUTTON`, `intent`
      not one of the router's command kinds (commands are marked `intent =
      command.kind`, `pipeline.ts:514`; the list is exported from `router.ts`, so
      `/learn`, `/leave`, `/digest` never count), and `received_at >= max(now − 14 d,
      learn_since)` — plain integers, no SQLite time zone math. Grouping is in
      TypeScript (`habits.ts`, pure): each timestamp → Jerusalem wall clock with the
      existing `localPartsOf(ms, ZONE)` (`time/`), then shifted 4 h back so a "day"
      runs 04:00–04:00 local; the day key is that shifted local date, the value its
      **wall-clock** minutes since 04:00 (0–1439). Per day keep only the minimum, so
      one row = one observation. DST changes the UTC offset, not wall clock, so the
      bucket is right on 2026-10-25. A midnight cluster (23:30, 00:15) stays
      contiguous. Needs ≥ 7 days, ≥ 70% within ±60 min of the median. The median is
      converted back (`+04:00`, mod 24 h) to a wall-clock time and must fall in
      05:00–11:59 — **abstain otherwise, never clamp**. Candidate = that hour, ≥ 1 h
      from the current one. Skip if the digest is off.
    - `leave_min` — ≥ 3 stated `leave` values in 30 days, median ≠ current default.
    A pending proposal of the same kind blocks a new one.
  - **Weekly question** from a static bank in code (~8), **max 3 answers**, each
    answer mapped to one of the preferences above.
  - First review of each month adds: "הגיע הזמן לייצא: ☰ ← ייצוא למידה".
- `learn_proposals(id, principal, group_id, kind, value, status, nonce, created_at,
  expires_at)` — **one row per answer**; a proposal is a group of one, a question's
  answers a group of up to three. Status: `pending → accepted | declined |
  superseded | expired | cancelled`.
- Claim-and-apply is **one `transactionSync`** (`sql-repo.ts:17`), no awaits inside:
  conditional UPDATE `status='accepted' WHERE id=? AND nonce=? AND status='pending'
  AND expires_at>? AND NOT EXISTS (accepted sibling in group_id)`; if 1 row changed →
  siblings `superseded`, then `setSetting` with the stored `value`. Any throw rolls
  all of it back. The DO serializes taps, so a second near-simultaneous tap on a
  sibling finds the group taken and answers "כבר נענה".
- Button semantics: a **proposal** (group of one) has two buttons, `ok` → accept
  and apply, `no` → `declined`, nothing applied. A **question** has one `ok` button
  per answer (up to 3) and no `no`; ignoring it lets it expire. A `no` on a question
  row, or any tap on a row that is not `pending` (expired, cancelled, declined,
  superseded, accepted) changes nothing. The reply is rendered from the row's
  status **after** the transaction (accepted / declined / already answered /
  expired), never from the tap. Button `lp:<id>:<nonce>:ok|no`: add `lp`
  to the closed kinds in `pending.ts` (`ok`/`no` already exist; ids hex), and an `lp`
  case in `runButton`. Each proposal and the question go as **separate messages**
  (≤ 3 buttons each: notification and WhatsApp limits). Atomic one conditional UPDATE (`status='pending' AND nonce=? AND
  expires_at>now`), sender checked, stored `value` applied — never one from the button.
  Expiry 6 days.
- Retention: `runMaintenance` deletes terminal rows (`accepted`, `declined`,
  `superseded`, `expired`, `cancelled`) older than 90 days, and marks `pending` rows
  past `expires_at` as `expired` first. Pending rows are never deleted early. The
  export reports outcome counts from the rows that remain.

## K3 — monthly export (server + app 0.18.0)

- Not a card (cards store plaintext `pending_actions.input_json`, `0012_cards.sql`).
  New signed route `GET /app/learn/export`, through the same handler path as
  `GET /app/watches` (signature, device active, nonce, principal from the device —
  invariant 9), rows read only for that principal. Response `Cache-Control: no-store`.
  The DO builds the JSON in memory and returns it; nothing is stored decrypted.
  `/learn export` in chat answers with where to tap in the app.
- App: ☰ ← "ייצוא למידה" → fetch → save `bot-learn-YYYY-MM-DD.json` to Downloads
  (MediaStore, as the CSV). `Protocol.kt` test vector for the route.
- Content (`schema: 1`): rephrase pairs and misses (newest first), undo/confirm_no
  counts per tool, leave stats, weekly counters, proposal outcomes; each pair carries
  its `confidence`. Every text field through `scrubForModel` first — it masks phones,
  emails, links, codes and long numbers (`scrub.ts:19-35`), **not** names, addresses or
  places, so the export is "reduced", not anonymized; the file says so in a header
  field, and the app shows a one-line warning before saving ("הקובץ עלול להכיל טקסט
  אישי; מחיקה בבוט לא מוחקת אותו"). Address detection → §13 follow-up, not this block.
  Cap 256 KB on the **final serialized JSON** in UTF-8 bytes (`TextEncoder`).
  Records (pairs and standalone misses alike, each an indivisible unit) are added
  newest first while the running serialized size plus a reserved footer stays under
  the cap; then `truncated: { pairs: n, misses: m }` is written. Bounds make the
  edge case impossible: one unit ≤ 2 × 1,200 chars ≈ 9 KB worst case in UTF-8, and
  the metadata is closed counters (≤ 26 weeks, closed tool list) ≈ a few KB; a test
  asserts metadata + one max unit < cap. Measure CPU in `wrangler dev` (≤ 200 decrypts).
- **Server first, then the APK.**

## K4 — Claude Code side

- `scripts/learn-to-evals.ts` (generalizes `misses-to-evals.ts`): export → draft cases in
  `evals-private/` (gitignored). `reported` misses → `drafts/`; `heuristic` pairs →
  `candidates/` ("failed text → tool the rephrase used"), never a case until a human
  confirms the pair really is the same request.
- Skill `.claude/skills/learn-review/SKILL.md`: read the file from
  `C:\Users\tzur6\Downloads`, cluster failures, propose fixes (lexicon
  `src/time/hebrew-lexicon.ts`, tool descriptions, `render/fallback.ts`, new tools →
  ROADMAP), rewrite cases with fake values before commit, run the evals owed — a
  description change moves the eval fingerprint (`test/evals/fingerprint.ts`) so a
  full `eval:agent` is owed — then delete the export. Log fixes (no private text) in
  `docs/learn-log.md`.

## Docs and strings

PLAN §6.31 + §14 (decisions above) + §13 (deferred CLARIFY hint); ROADMAP block K;
HANDOFF §1/§4/§6/§8; ARCHITECTURE (modules, 3 tables, `lp:` buttons, route);
`ops/runbook.md` commands. All Hebrew strings via `hebrew-content-writer` /
`hebrew-i18n`, times in FSI isolates (`render/bidi.ts`).

## Verification

- Test-first: learn-store caps/retention/encryption/forget; rephrase detection (fake
  timers, seq order incl. a newer exchange landing during the encrypt, 3-min edge,
  tainted/voice/shared/screen/private excluded, confirm-card counts as understood);
  `lp` buttons (expired, replayed nonce, wrong sender, double tap, two siblings tapped
  back to back → one accepted, a throw in `setSetting` rolls back the claim, cancelled
  after `/learn off`); proposal never touches tiers/allowlists; `digest_hour` candidate
  (ordinary mornings → proposal; midnight crossing → median 00:15 → none; 03:59 vs
  04:00 day boundary; median 12:30 or 01:00 → none, never clamped; scattered → none;
  < 7 days → none; messages across 2026-10-25 fall-back bucketed by wall clock; a
  duplicate wamid counted once; data before `learn_since` ignored; a `/digest 7` as
  the day's first message is skipped); `/learn on` twice keeps `learn_since`
  (current → "כבר פועלת", nothing sent; stale/outstanding → re-sent, new seq governs);
  messages between `/learn on` and its ack are not in `learn_weeks` nor in the
  `digest_hour` window; a version-3 feature starts at its own ack while version-1
  history stays; version 2 unacked + version 3 acked → every kind ≤ 3 appears in the
  rendered notice (test renders it and checks each `KIND_SINCE` entry);
  `/learn on` collects nothing until its reply is acked (app) or sent (WhatsApp); a
  thrown turn marks nothing; notice gating (queued but unacked → not collected; ack
  of that seq → collected; repeated ack → no change; ack of an older seq after a newer
  `/learn on` → no change, `learn_notice_seen` not lowered; ack then a later version
  bump → queued normally; expiry of a replaced seq leaves the new marker); terminal
  proposals older than 90 days purged, pending never; `/learn off` → no `learn_weeks` bump, no review; re-enable →
  off weeks are "no data"; `/leave`
  bounds; weekly send once across DST 2026-10-25 and once when two ticks race; 0-message
  week; separate rates; export scrub (Israeli phones: a mobile with dashes, with +972,
  a landline, a mobile in parentheses — fake values in the test; emails incl. Hebrew local part; URLs; codes; Hebrew text
  kept) and byte cut; route rejects unsigned (401), sets no-store, never returns
  another principal's rows.
- `pnpm typecheck && pnpm lint && pnpm test`. No `src/nlu`/agent prompt change → no evals.
- App: `./gradlew testDebugUnitTest`.
- `pnpm deploy:staging` after each server slice; version in HANDOFF §8.
- Phone: `/learn on`, a deliberate miss + rephrase, `/learn`, force the review on
  staging, tap a proposal, export → file in Downloads → `learn-review` skill on it.

## User review notes (2026-10-14) — what changed

1. `digest_hour` candidate defined (04:00 day boundary, consistency gate; the
   clamp written here is **superseded** — see round 4 item 5);
   reuses the existing `/digest N` setter.
2. `/learn off` cancels pending proposals; `/learn forget` reply spells out what is
   deleted, that misses stay, and that phone files stay; versioned notice.
3. Rephrases are `heuristic`, misses `reported`; heuristic pairs are candidates only;
   exclusions reuse `last_exchange`'s predicates.
4. `group_id` column; claim + supersede + apply in one `transactionSync`.
5. Mark-before-send replaced on the app channel by mark + outbox in one transaction
   (exactly once into the outbox); WhatsApp keeps the digest's at-most-once.
6. Export: same handler path as `/app/watches`, `no-store`, "reduced not anonymized"
   label and app warning, byte cap, wider phone/email tests; addresses → follow-up.
7. Separate rates for misses and rephrases, plus combined.

## User follow-up notes (2026-10-14) — what changed

1. `digest_hour` source: existing `inbound_messages.received_at` (30 days, deduped
   by PK) — no new table.
2. A rephrase pair is one row with one encrypted `{ failed, fixed }`; `confidence`
   has a CHECK and a Zod enum.
3. Export cap on the final serialized bytes; pairs and misses both indivisible units,
   newest first; typed truncation counts; bounds test.
4. A new category is collected only after its notice version was shown.
5. `digest_hour` abstains when the median is outside 05:00–11:59 — no clamping.
6. Proposal = ok/no; question = one ok per answer; reply from persisted status.

Test additions: pair integrity under trim/forget/truncate; Hebrew + 4-byte emoji at
max length against the byte cap; a kind newer than the seen notice is not collected,
the notice is sent once; median 01:00 → no proposal; `no` on a question row and taps
on every non-pending status change nothing.

## User notes, round 6 (2026-10-14) — what changed

1. `learn_since` starts at the initial ack, not the command; per-version starts
   (`learn_version_since`) for later features; `learn_weeks` bumps only when
   collectable.
2. One rule for a repeat `/learn on`: current → "already on", else re-send.
   **Supersedes** the earlier "changes nothing" and "re-sends" wordings.
3. The notice is cumulative over every kind ≤ the current version, newer ones marked.

## User notes, round 5 (2026-10-14) — what changed

1. Notice state: `max` for `learn_notice_seen`; ack and expiry act only on the exact
   outstanding seq; replace makes old acks inert.
2. Terminal proposals purged after 90 days; pending untouched.
3. Initial disclosure now uses the same gate: app = ack of the reply's own outbox
   row, WhatsApp = successful send. **Supersedes round 4 item 2** ("initial
   disclosure sets the version at once").

## User notes, round 4 (2026-10-14) — what changed

1. `learn_since` resets only off → on; a repeat `/learn on` keeps it.
2. Initial disclosure = the `/learn on` reply (any channel, sets the version);
   only later bumps wait for the app ack.
3. Ack advances the version only for the exact queued seq; the app acks committed rows.
4. Commands (router kinds) and buttons excluded from first-message times.
5. Superseded: every earlier mention of clamping. The authoritative rule is in K2:
   abstain outside 05:00–11:59, never clamp.

## User notes, round 3 (2026-10-14) — what changed

1. Clamp test removed; tests prove out-of-range → no proposal; median converted
   back to wall clock before the 05:00–11:59 check.
2. `learn_since` cutoff: no retrospective use of data from before `/learn on` or a
   forget; disclosed in the `/learn on` text; operational tables untouched.
3. `learn_notice_seen` advances on the phone's outbox ack, not on enqueue.
4. Day grouping done in TypeScript with `localPartsOf`, not SQLite time functions.
5. `/learn off` stops every learning write and send; off periods are "no data".

## Rejected objections

None — all review items were accepted (round 1: 3 blockers, 9 gaps, 6 nits;
round 2: 1 gap, 6 nits). The "☰ ←" arrow direction is checked with the RTL skill
when the strings are written.

## K1 build notes (2026-10-14) — where the code differs from the text above

1. **"Understood"** is set by the orchestrator's `audit` for the verdicts ALLOW
   (not `error`), CONFIRM, CONFIRM_ON_DEVICE, DEVICE_QUERY and CARD, through a
   per-turn `LearnSink` on `TurnContext` (never stored, never seen by a model). A
   numbered choice list (`ambiguous`) is a clarify, not audited, so it does **not**
   count as understood: fewer rephrases, never a false one.
2. The flag is kept on the exchange itself (`Exchange.understood`). A row written
   before K1 has none and is never taken for a failed request.
3. `/learn off` also clears `learn_notice_seen` and `learn_version_since`, so turning
   it on again re-sends the notice and collects only from its new delivery. (The text
   above clears only `learn_since`; with `seen` kept, a later `/learn on` would have
   answered "already on" with no start.)
4. `learn_weeks.messages` counts every text or voice message that is **not a
   command**, bumped in `respondToText` right after the command check. Duplicates
   never reach it, so it is still "fresh only".
5. `undo`, `confirm_no` and `leave` come from the same sink as signals, written by
   the pipeline after the turn (`writeLearnSignals`), in `handleInbound` and
   `resumeFromPhone`. `stated` is optional in the leave schema, so a card stored
   before K1 still parses; such a row teaches nothing.
6. The hourly tick also re-sends the **first** notice when it expired unacked or
   its WhatsApp send failed (on, `seen` null, nothing outstanding).
7. K2 adds what belongs to `learn_proposals`: `/learn off` cancelling pending
   proposals, and `/learn forget` deleting them.

## K2–K4 build notes (2026-10-14) — where the code differs from the text above

1. **When.** The review goes on the first hourly tick on Sunday at or after
   10:00 local (`reviewDue`), not only in the 10:00 hour, so a missed tick does
   not lose the week; `learn_review_sent_on` (the local day) stops a second
   one, checked again inside the transaction.
2. **Outbox.** Review messages are outbox kind `notice`: like every non-reminder
   row they expire after 24 h if the phone never fetches them.
3. **Nonce.** `learn_proposals.nonce_hash` stores SHA-256 of the nonce (as
   `pending_actions` does), not the nonce. The `lp:` tap is answered in the
   pipeline before `runButton`, since the store is never on `TurnContext`;
   `runButton` answers an `lp` it should never see with "not found".
4. **Question.** The bank has 8 entries (4 digest hours, 4 travel times),
   rotated by `floor(now / week) % 8`. Today's value is removed from the
   answers; fewer than 2 left → no question. A digest question is skipped
   while the digest is off. A kind pending, or proposed this week, blocks its
   question.
5. **Export reminder.** "The first review of each month" = a review in the
   first 7 days of the local month.
6. **Proposal text.** The `digest_hour` proposal names the observed time (the
   median, as wall clock) and the current and proposed hours. `leave_min`
   abstains outside `/leave`'s bounds (10–120), like the digest hour.
7. **Export.** Answers even while learning is off (the data is kept until
   `/learn forget`). Compact JSON (the app pretty-prints it before saving). A
   row that does not decrypt or parse is counted in `unreadable`, never shown.
   The app asks with the warning **before** fetching.
8. **K4.** `learn-to-evals.ts` writes `evals-private/drafts/` and
   `evals-private/candidates/` and prints the taps, leave stats, weeks and
   proposal outcomes; the skill lives in the bot repo
   (`.claude/skills/learn-review/SKILL.md`).
