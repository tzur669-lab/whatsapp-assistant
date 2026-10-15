# Plan: Block L, five ideas from the Instinct comparison (no WhatsApp)

## Context

The user compared the bot with Instinct (`instinct-vs-bot.html`) and picked these ideas to build: mail follow-ups (#1), proactive calendar suggestions (#2), a monthly bookkeeping file (#4), mail cleanup (#7) and documents (#5). On 2026-10-15 the user **removed all WhatsApp work from this block**. Existing WhatsApp code (the frozen channel, the screen agent's WhatsApp block, generic notification reads) stays untouched. #3 (a forwarding address, needs a paid domain) and #6 (booking templates, waits for the "bot builds a routine" plan) remain out.

The section numbers L2–L6 are kept as before so earlier discussion still lines up. The order is L2 → L3 → L4 → L5 → L6.

**Standing decisions:** the user approved the new scopes `gmail.modify` (L5) and `drive.file` (L6). $0 recurring cost.

**Every part:**
- **One commit,** with typecheck, lint and test green.
- **Tools:** new ones go through the `add-tool` skill, agent-only (the parser stays pinned to `PARSER_TOOL_NAMES`), with `eval:agent --filter <prefix>` on qwen and a human read.
- **Close-out:** staging deploy (standing approval); HANDOFF, ARCHITECTURE and PLAN §14 updated.
- **App:** server before APK whenever the app changes.

## Facts from the repository

- **Transactions:** `this.sql.transaction(fn)` → `storage.transactionSync` (`platform/sql-repo.ts:17`), synchronous, so no `await` fits inside. `outbox.accept` is synchronous SQL and is already called inside such a transaction (`assistant-do.ts:1257-1291`, `maybeSendLearnReview`). Delivery retries come from the outbox itself (`next_push_at`, `pushes`).
- **Outbox at rest:** rows hold reply text in plain form for 24 h (7 days for reminders) and are deleted on ack. This is an accepted risk (PLAN §13 line 3035, §6.18 table line 640).
- **Undo:** exists only on Tier 1 tools (`tools/types.ts:268,307`). `ExecuteResult` has no buttons field.
- **Gmail:**
  - Client methods: `search` (metadata From/Subject/Message-ID), `listIds`, `body`, `createDraft` (`google/gmail.ts:150-188`).
  - Scopes: `gmail.readonly` + `gmail.compose` (`google/grants.ts:35`).
  - Error handling: `invalid_grant` → integration `disconnected` + one reconnect message (`google/api.ts:143-146`).
- **Calendar:** the client has list, create, move and delete, but **no get-by-id** (`google/calendar.ts:103-259`). No reminder stores an event id (`migrations/0021_*.sql:8`).
- **Drive:** `drive.metadata.readonly` only (`grants.ts:46`).
- **File card:** CSV only (`tools/expenses.ts:159-160`, `render/phone.ts:45`, `DeviceActions.kt:375,392`).
- **Catalog:** the full catalog sits at 5,710 tokens against a 5,750 pin (`test/unit/agent/fit.test.ts:241`).
- **Subrequests:** each Gmail body read is its own subrequest, counted against the Worker cap (`tools/bills.ts:30`). `MAX_WRITE_CALLS = 3` (`agent/limits.ts:40`).
- **Google, from official docs:**
  - `gmail.readonly`, `gmail.compose` and `gmail.modify` are all **restricted**. `gmail.modify` can also read and send, but cannot delete permanently ([Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)).
  - An unverified app shows the warning screen and is capped at 100 new users ([Unverified apps](https://support.google.com/cloud/answer/7454865)).
  - The project's consent screen must be **In production**, because Testing expires refresh tokens after 7 days (PLAN line 89-90, 543; SETUP.md:78).
  - `drive.file` is **non-sensitive**, limited to files the app creates or opens ([Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)).
  - Markdown is among the formats converted to Docs on upload, but the docs give no MIME string ([Upload guide](https://developers.google.com/workspace/drive/api/guides/manage-uploads)).

---

## Shared rule: scheduled notices (L2, L3, L4)

1. **Read first.** Gmail or Calendar calls happen outside any transaction and change no state.
2. **One transaction.** Re-check that the row or marker is still due, set the new status or marker, and call `outbox.accept(notice)`, all inside one `this.sql.transaction` (the `maybeSendLearnReview` pattern).
3. **Delivery** is the outbox's existing push retry.

What this guarantees:
- **Crash before step 2:** nothing changed, and the next tick reads again.
- **Crash after step 2:** the notice is queued and will be delivered.
- **Overlapping ticks:** both may read, but only the first transaction writes; the second finds the status moved.
- **No stale claims:** no claim is held across an `await`, so none can get stuck.
- **No lost notices:** a status or marker is only ever written together with its outbox row, so it can never suppress a notice that was not queued.

This applies to the app channel. On the frozen WhatsApp channel the existing "mark before send" at-most-once stays as it is (`assistant-do.ts:1246-1247`). This rule is not forced on taps, which have their own rule below.

Why it holds:
- `transactionSync` rolls back when its callback throws. The test driver has the same BEGIN/ROLLBACK + savepoint shape (`test/integration/sqlite-driver.ts:35-47`).
- `outbox.accept` is plain SQL on the same storage.
- No new abstraction.

Tests:
- **Failure injection inside the transaction:** status or marker written, then a throw before `outbox.accept`. Assert neither the status nor an outbox row survives.
- **A throw before the transaction.**
- **A push failure after commit:** the row is still in the outbox with `next_push_at`, and the next push delivers it.
- **Two interleaved ticks:** both reads complete; exactly one status move and one outbox row.

**Google unavailable** (`disconnected`, scope missing, 5xx): a scheduled job skips its read and writes nothing. What happens next depends on the job, and none of them ever reports "no reply" or "no bills":
- **L2:** a due row sends **one** "could not check" notice per day, through its `day_marker` + outbox row in one transaction.
- **L3:** skips silently, because a suggestion is optional and the existing `invalid_grant` path already sends the reconnect message (`google/api.ts:143-146`).
- **L4:** sends the file without bills, with a line saying so (see L4). User-triggered tools answer with the existing reconnect message.

## Shared rule: deterministic taps (L2 `fu:`, L3 `sg:`)

- **Button kinds:** `fu` and `sg` join `ButtonKind`/`BUTTON_KINDS` (`confirm/pending.ts:299,302`). The id format is `kind:id:nonce:verb` (`:306`).
- **A tap** is handled in the Durable Object without the model (invariant 7): nonce, sender and expiry (48 h) are checked, with conditional UPDATEs only.
- **Writes still confirm:** a tap never executes a write. What it produces is a confirmation card (an existing `pending_actions` row, `confirm/pending.ts:103`), executed once by the existing confirm machinery.
- **Recovering when a reply is lost.** A tap's reply can be lost after its state moved, for example on a crash or a dropped response; the phone's retry of the same request answers `unknown`, not a re-run (Batch 11). The fix is small, per button:
  - **L2 `fu:` needs no await:** the draft card is built from stored fields. **One transaction** does `notified → used`, inserts the pending draft action and stores its id on the row.
  - **A later tap on a `used` row** whose pending action is still `pending` and not expired **re-sends the same card**. It does not answer "כבר טופל". The card can still execute only once.
  - **L3 `sg:` needs an await** (`getEvent`), so it holds a **2-minute lease**: `open → checking (claimed_at, claim_token)` by a conditional UPDATE, then the read, then one transaction `checking → used WHERE claim_token = <mine>` that stores the pending action id. **Every** transition out of `checking` (→ `used`, → `open` on a Calendar error, → closed for a deleted event, → closed as too late, and the release in a `finally` on an exception or the turn deadline) is `WHERE id = ? AND status = 'checking' AND claim_token = <mine>`. A request whose claim was taken over changes nothing and sends nothing.
  - **A tap on a `checking` row whose lease expired** claims it again, so a crash mid-read leaves the row usable. A tap on `used` with a live pending action re-sends its card.
  - **The domain backstop against a double reminder,** if a crash ever produced two cards: `reminders.leave` refuses at execute when a leave reminder with the same `event_id` already exists ("כבר קיימת תזכורת יציאה לאירוע הזה"). Each card still executes only once.

---

## L2: "Remind me if they didn't answer" (idea #1, server + app command list)

**Tool.** `mail.follow_up` (Tier 1, `dataSource: 'mail'`, `consent: 'always'`):
- **Finding the sent mail:** by `query_variants` in `in:sent`; several matches → a choice list.
- **Deadline:** through `src/time/resolve.ts`; a missing deadline → CLARIFY.
- **Undo:** cancels the follow-up (Tier 1, the existing path).

**Storage.** Migration 0037, registered in `src/platform/migrations.ts`: `mail_followups(id, thread_id, sent_id, sent_at_ms, due_at, status open|notified|answered|bounced|used|cancelled|unsure, attempts, nonce, day_marker, pending_id, settled_at)`. `runMaintenance` (`assistant-do.ts:1082`) purges settled rows after 90 days.

**Client.** New `GmailClient.thread(id)`: `threads.get?format=metadata` with headers `From`, `Auto-Submitted`, `Precedence`, `Content-Type`, `List-Id`, `X-Failed-Recipients`. It returns per message `id`, `labelIds`, `internalDate` and those headers. One subrequest per row, at most 5 due rows per tick. Header names and values are compared case-insensitively, with surrounding spaces trimmed.

**Meaning, in the tool description and the notice:** "someone replied in the thread", not "the intended recipient answered". Checking the recipient would mean storing email addresses (invariant 2).

**Classification, in code, of every message after `sent_at_ms`:**
- **`SENT`** (covers every alias of the account) or **`DRAFT`:** ignored. A later message from the user doesn't count as a reply, and the follow-up keeps waiting.
- **Bounce,** only on a delivery-failure indicator: `Content-Type: multipart/report` with `report-type=delivery-status`, or an `X-Failed-Recipients` header. The row becomes `bounced`, with the notice "המייל לא נמסר".
- **A mail-server sender without that indicator** (From's local part `mailer-daemon` or `postmaster`): `unsure`, with the notice "התקבלה הודעה אוטומטית משרת דואר, ייתכן שהמייל לא נמסר. אפשר לבדוק ב־Gmail". This could be a delay warning or something unrelated, so it is never stated as a failure.
- **A `multipart/report` without `delivery-status`** (a read receipt or a feedback report) is automatic, not a bounce.
- **Automatic** (ignored, keeps waiting):
  - `Auto-Submitted` present and not `no`.
  - `Precedence` in `auto_reply | bulk | list | junk`.
  - A `List-Id` header present (mailing-list traffic).
- **Anything else:** `answered`, silent. Missing headers are normal for human mail, so their absence counts as human. An automated sender that sets none of these headers would count as a reply. That limit is stated in PLAN §6 and in the tool description ("someone replied").
- **Messages before the sent one:** ignored.

**Unsure, never "no one answered":**
- **When:** `sent_id` is missing from the thread (deleted), a message lacks `labelIds` or `internalDate`, the thread is gone, or 3 Gmail failures in a row.
- **Result:** `unsure`, with the notice "לא הצלחתי לבדוק אם ענו על «\u200F<subject>\u200F». אפשר לבדוק ב־Gmail."
- **Subject:** the user's own subject, `scrubForModel`-style cleaned for display and bidi-isolated.

**Due row with no reply.** `notified`, with the notice "לא ענו על «…» עד <date>" and buttons `fu:<id>:<nonce>:draft|no`. "draft" leads to the Tier 2 confirm card for a draft (existing `createDraft`, wording made in code). "no" closes the row.

**Command.** `/followups` lists and cancels: `COMMAND_KINDS` (`core/router.ts:217`) + `ChatLogic.COMMANDS` (`app-commands.test.ts`). App 0.20.0 (command list only).

**Tests and evals.**
- **Test matrix**, each case a fake thread with expected status:
  - **Human:** a reply after the sent mail → `answered`; a reply with upper-case headers → `answered`.
  - **The owner:** an own later message (`SENT`), an alias (`SENT`) and a self-forward (`SENT`) → stay `open`, then `notified` at the deadline.
  - **Drafts and older mail:** a `DRAFT` in the thread → ignored; messages only before the sent one → `notified`.
  - **Automatic:** a vacation reply (`Auto-Submitted: auto-replied`), `Precedence: bulk`, `Precedence: List` and a `List-Id` → ignored.
  - **Bounces:** a DSN (`multipart/report; report-type=delivery-status`) and `X-Failed-Recipients` → `bounced`. From `MAILER-DAEMON@…` with neither → `unsure` ("ייתכן"). A read receipt (`report-type=disposition-notification`) → ignored.
  - **Unsure:** a message missing `labelIds` or `internalDate`, the sent mail deleted, and the thread 404 → `unsure`.
  - **Failures:** 3 Gmail 5xx in a row → `unsure`; Google disconnected → one "could not check" notice per day.
  - **Concurrency and taps:** two interleaved ticks; a double tap; an expired tap; a tap whose reply was lost, then a re-tap re-sending the same card.
- **Evals:** `fu-`.

## L3: Proactive calendar suggestions (idea #2, server + app command list)

**Command.** `/suggest on|off`, off by default (`COMMAND_KINDS` + `ChatLogic.COMMANDS`).

**Migration 0038.**
- `reminders.event_id` (nullable), written by `reminders.leave` from now on.
- `suggestions(event_id, day, status open|checking|used|dismissed, nonce, claimed_at, claim_token, pending_id, created_at)`, unique (event_id, day).
- Purge after 30 days.

**Legacy leave reminders** (no `event_id`): a reminder counts as covering an event if it is a leave reminder whose stored `place` matches the event's location in code and whose time lies within the 3 hours before the event start. Two or more candidate events for one reminder, or a partial place match → **skip the event** (fail safe: a missed suggestion rather than a duplicate). Tested.

**Daily run, at the digest hour, under the shared rule:**
- **Read:** tomorrow's events (`Asia/Jerusalem` day boundaries from `src/time/`).
- **One transaction:** `INSERT OR IGNORE` the suggestion rows (the unique key makes a rerun a no-op), then queue outbox notices only for rows this transaction inserted. At most 3, with buttons `sg:<id>:<nonce>:ok|no`.
- **Notice:** text built in code. The event title is someone else's words: shown, but tainted, and never sent to a model.

**On "ok"** (shared tap rule):
- **Re-read:** new `CalendarClient.getEvent(id)` (events.get, existing scope).
- **Deleted** (`status: cancelled` or 404): "האירוע בוטל", the row is closed.
- **Too late:** the current start is now or past → "האירוע כבר התחיל, מאוחר לתזכורת יציאה", and the row is closed. The check is made in code against the re-read start, and again inside `reminders.leave` at execute (its own leave time must still be in the future, or it refuses).
- **Moved or changed:** the current start and place are used.
- **No location anymore:** "אין לאירוע מקום".
- **Then:** `reminders.leave` is resolved with the current event as stored input and runs resolve → policy → confirm as usual. The card shows the current time.
- **Calendar unavailable:** "לא הצלחתי לבדוק את האירוע". The row goes back to `open` in its own transaction. If the process dies first, the 2-minute lease lets the next tap claim it again.
- **The card:** the event title is someone else's words, so the turn is tainted and policy returns CONFIRM for the write.

**Tests.** A past event; an event that started between the notice and the tap; a Calendar response slower than the 2-minute lease while a second tap claims → one card only. A stale request returning a Calendar **error**, a **deleted** event or a **too late** event after another request claimed → the newer row is untouched and no reply is sent from the stale one. Events on 2026-10-24/25/26 (the fall-back night); an event at 01:30 on the 25th; a moved event; a cancelled event; a legacy reminder (matched, ambiguous); two ticks.

## L4: Monthly bookkeeping file (idea #4, server + app command list)

**Command.** `/monthly on|off`, off by default (`COMMAND_KINDS` + `ChatLogic.COMMANDS`).

**Migration 0039.** `monthly_exports(month PK, sent_at)`.

**Run on the 1st, from 09:00 `Asia/Jerusalem`, under the shared rule:**
- **Read:** build the CSV first (expenses from the DB, bills through `readBills`, async).
- **One transaction:** `INSERT OR IGNORE` the month row, and only if it was inserted, insert the file card's pending action (the CSV in its `input_json`, as `expenses.export`) and `outbox.accept(notice with the card)`.
- **Failure:** a failed build writes nothing, so the next tick retries.
- **Bills:** if `readBills` fails or Google is disconnected, the file is still sent with expenses only, and the CSV's first line says "חשבונות מהמייל לא נכללו: לא הייתה גישה". A "not checked" result never looks like "no bills".

**On request.** `expenses.monthly_pack` (Tier 1, `dataSource: 'mail'`, `consent: 'always'`, like `expenses.export` at `registry.ts:771`). Mail is chosen deliberately: it is the stricter, once-only source, since the file carries Gmail bills. It is not offered in smart conversations.

**CSV content:**
- **Month boundaries** come from code in `Asia/Jerusalem`.
- **Currency:** a currency column, with a separate total per currency and no conversion.
- **Bills:** counted once per Gmail message id. A bill and an expense the user logged for the same payment are not merged (no reliable key), and the file says so in one line.
- **Footnote:** "החשבונות זוהו אוטומטית מהמייל ועלולים להיות חסרים".

**Bills scan bounds (confirmed in code).**
- `readBills` reads at most `MAX_BILLS = 8` mails (`tools/bills.ts:31`): 1 list call + up to 8 metadata calls (`gmail.ts:157`) + up to 8 body calls, so ≤ 17 subrequests.
- `search` **silently skips** a mail whose metadata read failed (`gmail.ts:160`). So a month's scan can be incomplete without anyone knowing.
- **Smallest fix:** `search` also returns `skipped` (a count). Nothing else in it changes, and the existing callers ignore the field.
- **Monthly pack:** the bills query is limited to the month (`after:`/`before:` built in code). The CSV and the notice say "נמצאו N חשבונות".
- **A cut is never silent:** at N = 8 the file adds "ייתכן שיש עוד: נבדקו עד 8", and with `skipped` > 0 "M מיילים לא נקראו".
- **The 8-mail cap is not raised.** The tick also runs mail watches and follow-ups within the same Worker subrequest budget.

**What is stored, and for how long (corrected).**
- **The CSV itself** lives in `pending_actions.input_json` (`migrations/0002_confirm.sql:11`), the same as `expenses.export` today. It stays until the card's expiry plus 1 hour (`PURGE_AFTER_MS`, `confirm/pending.ts:24,231`).
- **The outbox row** holds only the card's preview (≤ 300 chars, defanged, `channels/app/outbox.ts:117`). It is kept until ack, or 24 h at most (PLAN §6.18, line 640).
- **Both are plain text at rest,** under the existing accepted risk (PLAN §13 line 3035: Durable Object storage is encrypted by Cloudflare). §6 states it this way, never "not stored".
- **Never:** logged (redacting logger, plus a canary test with a fake amount and a fake sender), put in history (a file card is not model text), recorded in the learn journal (its kinds are fixed, `core/learn-store.ts`), or sent to a model.

**Tests.** A month boundary at 23:59/00:00; mixed currencies; a duplicate bill message; bills unavailable; exactly 8 bills (cut line); a skipped metadata read (`skipped` line); a throw inside the transaction (no month row, no pending action, no outbox row); two ticks; a rerun on the 2nd.

## L5: Mail cleanup (idea #7, server + app command list; new scope)

**OAuth: what is verified and what is not.**
- **From code:**
  - The gmail grant is its own consent with its own refresh token (`google/grants.ts:1-8,32-37`), requested with `include_granted_scopes=false` and `access_type=offline` (`oauth.ts:73,78`).
  - The token response's `scope` is parsed (`oauth.ts:183`) **but never compared** with the scopes requested. That is a confirmed gap: Google's consent screen lets a user untick individual scopes. Fixed below.
- **From Google's documentation:**
  - `gmail.modify` is **restricted** (the [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes) page).
  - An app "for your personal use (fewer than 100 users)" may keep running unverified behind the warning screen (the [verification-not-needed](https://support.google.com/cloud/answer/13464323) page). The restricted-scope security assessment belongs to verification, so it does not apply while the app stays personal.
  - The refresh-token expiry rules (Testing 7 days, unused for 6 months, a password change for tokens holding Gmail scopes) come from PLAN §2 lines 89-90 and memory. Google's OAuth page could not be fetched in this review, so they are **to re-check** at implementation.
- **Not provable from the repo:**
  - **Whether the consent screen is In production today.** PLAN line 543 and SETUP.md:78 require it, but the console is not in the repo.
  - **Whether a fresh consent including `gmail.modify` succeeds.** An existing grant only proves the old scopes.

**Precondition, in order:**
1. **Check without asking the user.** On staging, the gmail integration row is `connected`, and the grant is more than 7 days old and still refreshing with no `google_disconnected` log. This is **indirect evidence only**, and it is recorded that way:
   - It shows that this grant has not hit a 7-day Testing expiry.
   - It does not prove the console says "In production" today, since the status could have changed after the grant was issued.
   - The console itself is not visible from the repo. A fresh `gmail.modify` consent (step 3) is the only real proof.
2. **Ship the scope check** (below) and deploy.
3. **The user runs `/connect gmail` once.** The stored granted scopes must then include `gmail.modify`. Only this step verifies the new scope. If Google refuses the consent, L5 stops and PLAN §13 line 3037 is resolved first.

**Granted-scope check (new, all grants).** After the token exchange, the parsed `scope` list is stored with the grant. A tool needing a scope the grant lacks answers "צריך לחבר מחדש את Gmail ולאשר את כל ההרשאות". Today's grants keep working: the check applies only to scopes a tool needs.

**Scope.**
- Add `gmail.modify` to the gmail grant (`grants.ts:35`, `oauth.ts:23`); the user reconnects, and PLAN §14 gets a line.
- Without the scope, the tool answers "צריך לחבר מחדש את Gmail".
- **Guard:** `gmail.modify` can send. A ban-list test asserts the code calls only:
  - `messages/batchModify`, with label changes limited to `INBOX` and labels under the bot's `בוט/` prefix;
  - `labels` create and delete, only for names under that prefix (one helper builds the name), and `labels.list` (read-only, used by maintenance to reconcile).
  
  It never calls `/send`, `/trash`, `/delete`, `/batchDelete`, or any label outside the prefix.

**Client.**
- `GmailClient.batchModify(ids, { addLabelIds?: ['INBOX'], removeLabelIds?: ['INBOX'] })`: one subrequest for up to 50 ids. Adding or removing a label the message already has or lacks is a no-op, so a repeat is safe.
- `GmailClient.listIdsBounded(query, max)` returns `{ ids, more }`. Today `listIds` ignores `nextPageToken` (`gmail.ts:171-179`), so it cannot tell exactly `max` from more. `more` is true when the response has a `nextPageToken`. Gmail's `maxResults` caps a page at 500, so `max ≤ 500`.

**Tool.** `mail.archive` (Tier 2, `dataSource: 'mail'`, `consent: 'always'`):
- **Inputs:** sender / `query_variants` / `older_than_days` (integer; the window is built in code).
- **Query:** code always adds `in:inbox`, so mail already archived is never a target.
- **Matching:** `listIdsBounded(query, 50)`. **`more`** → no card; "יש יותר מ־50 מיילים, אפשר לצמצם (שולח או תקופה)". **0** → "אין מיילים כאלה בתיבה".
- **Card:** exact count, plus the filter in words built in code (sender / words / "older than N days"). **No sender list:** `listIds` returns ids only, and naming senders would cost one metadata call per message, up to 50 subrequests, the Worker's whole budget.
- **Execute,** in this order. Confirm already marked the action executed before it runs (`confirm/pending.ts:138-143`), so it runs at most once. **`INBOX` is removed last**, so no message can be archived without its recovery label:
  1. **Record first.** One synchronous SQL write inserts the `mail_archives` row: the stored ids, `label_name = בוט/ארכוב-<random 8 hex>`, `op = 'pending'`, `label_state = 'unknown'`, and an **active-execution fence** `exec_until = now + 5 min`.
     - **Why a fence is needed:** a confirm button runs `execute` without the agent lock (`core/pipeline.ts:445-468`; the lock is taken only on the agent path, `:1087`, `:1397`), and a Durable Object lets other requests run while it waits on `fetch`. So `/unarchive` or maintenance can interleave with a running archive.
     - **Why 5 minutes:** `exec_until` is far beyond `MAX_WRITE_MS` and `LOCK_TTL_MS` = 220 s (`agent/limits.ts`). After it passes, the execute has either finished or died, and any Gmail request it issued has completed or failed at Google. Requests are not assumed to linger for minutes; that is the one stated assumption.
     - **The execute's own writes:** after each step they are conditional on `op = 'pending'` (nothing else may change `op` while the fence holds). Its final write sets `exec_until = NULL`. The label is marked `unknown` *before* the create is sent, so a crash at any later point leaves a name that maintenance can reconcile. The name is unique per batch.
  2. **`labels.create`** with that name.
     - **The id comes back** → store `label_id`, `label_state = 'present'` (one write).
     - **A definite error** (a 4xx response: Gmail answered, so nothing was created) → `label_state = 'none'`, `op = 'failed'`, reply "הארכוב לא בוצע".
     - **An unknown outcome** (timeout, network, 5xx) → `op = 'failed'`, `label_state` stays `unknown`, reply "הארכוב לא בוצע". The label may exist remotely; maintenance reconciles it (below).
     - **Never** a second create, and an error is never read as "exists". The inbox is untouched in every case.
  3. **`batchModify`** on exactly the stored ids: add the label id. Error or unknown → stop: `op = 'failed'`, reply "הארכוב לא בוצע". At worst some messages carry the label and are still in the inbox; cleanup removes it.
  4. **`batchModify`** on exactly the stored ids: remove `INBOX`. Error or unknown → `op` stays `pending`, reply "לא ברור אם הארכוב הושלם; אפשר \u200E/unarchive". Every stored message already carries the label, so the restore finds all of them.
  5. **`op = 'done'`.**
- **Crash points:**
  - **After step 1 or during step 2:** `op = 'pending'` with no `label_id`. Once the fence (`exec_until`) has expired, maintenance and `/unarchive` treat it as "nothing was archived" (`INBOX` is removed only in step 4, which needs `label_id`), set `op = 'failed'`, and reconcile the label.
  - **After step 3:** `pending` with the label present → `/unarchive` restores (its query finds nothing still archived, which is correct).
  - **During step 4:** `pending` → `/unarchive` restores the labelled ones.
- **Gmail calls:** 3 in the normal path, the existing `MAX_WRITE_CALLS = 3` (`agent/limits.ts:40`), so no raise and no lock-TTL change. Label lookups happen only in maintenance, never in the execute.
- **Why two `batchModify` calls rather than one combined add-and-remove:** Google's reference could not be fetched in this review to confirm that one request changes every message atomically. Separating the steps makes the order safe without relying on that.
- **Not in the inbox anymore:** if a message left the inbox between card and confirm, removing `INBOX` is a no-op.

**Restore (no framework Undo: Tier 2 has none).**
- **Storage:** migration 0040, `mail_archives(id, created_at, ids_json, op pending|done|failed|restored, exec_until, label_name, label_id, label_state unknown|present|none|deleted|kept, claim_at, claim_token, restored_at, cleanup_attempts, next_cleanup_at)`.
  - **Two independent axes:** `op` is what happened to the mail; `label_state` is the Gmail label's lifecycle. Cleanup never changes `op`, and a restore never changes `label_state`.
  - `claim_at` + `claim_token` are an in-progress lease; `op = 'restored'` means done.
  - **Row lifetime (a tombstone):** a row is deleted only when **both** `created_at + 7 days` has passed **and** `label_state` is `none` or `deleted`. `ids_json` is set to NULL at `created_at + 7 days` whatever else is pending, so message ids are never kept past the undo window. Only the label name and id may outlive it, until cleanup finishes.
  - **No time window is stored.** The earlier `after:<ms>` window was wrong: Gmail's `after:`/`before:` take seconds or dates, not milliseconds. The batch label makes the window unnecessary.
- **Reply:** the success reply says "לביטול: \u200E/unarchive (עד 7 ימים)".
- **`/unarchive`** is a deterministic command (`COMMAND_KINDS` + `ChatLogic.COMMANDS`).
  1. **Select** the newest retained row by `created_at`, **whatever its `op`**, and branch on it. It never falls through to an older row:
     - **No row:** "אין ארכוב לשחזר".
     - **`created_at` older than 7 days:** "עברו 7 ימים; המיילים נמצאים ב'כל הדואר' ב־Gmail". Rows are kept until their 7 days have passed, so if the newest row is gone, every remaining row is older still, and the same answer applies.
     - **`op = 'restored'`:** "הארכוב האחרון כבר שוחזר".
     - **`op = 'failed'`:** "הארכוב האחרון לא בוצע, אין מה לשחזר".
     - **`exec_until > now`** (an archive is still running, including while `labels.create` is in flight): "הארכוב עדיין מתבצע, אפשר לנסות שוב בעוד כמה דקות". Nothing is read or written. This check comes before every branch below.
     - **`op = 'pending'` without a `label_id`, fence expired:** nothing was archived (see crash points). Set `op = 'failed'` with a conditional UPDATE (`WHERE op = 'pending' AND (exec_until IS NULL OR exec_until < now)`) and give the same reply.
     - **`op` `done`, or `pending` with a `label_id`:** continue.
     - **Older batches** are never offered (Gmail's own "All Mail" covers them).
  2. **Claim** it with one conditional UPDATE: `claim_at = now, claim_token = <random> WHERE id = ? AND op IN ('done','pending') AND (exec_until IS NULL OR exec_until < now) AND (claim_at IS NULL OR claim_at < now − 5 min)`. The fence is re-checked inside the UPDATE, so a select-then-claim gap cannot slip past it. A second `/unarchive` during the lease gets "כבר בתהליך".
  3. **Eligibility:** `messages.list` with the **`labelIds=<label id>` parameter** (not a name search, so a renamed label or odd characters change nothing) and `q = -in:inbox -in:trash -in:spam`, through `listIdsBounded(…, 50)`. The label marks exactly this batch, at most 50 messages, so there is no window and no 500 limit. A `more` here would mean the label was put on something else; then nothing is restored and the reply says to restore in Gmail.
     - **The label no longer exists** (404 / "label not found": the user deleted it, which also removes it from the messages) → no automatic restore: "התווית נמחקה ב־Gmail, אי אפשר לשחזר אוטומטית; המיילים ב'כל הדואר'". The claim is released; `label_state = 'deleted'`; `op` is unchanged (a repeat gives the same answer).
  4. **Restore** only the **intersection** of those ids with the stored ids, in one `batchModify`: add `INBOX`. The label stays until cleanup, so a rerun can still find the messages. Trashed, spam and already moved-back messages are not touched, and ids outside the batch are never sent.
  5. **Finish,** in one transaction: `restored_at = now, op = 'restored' WHERE claim_token = <mine>`, and set `next_cleanup_at = now` so cleanup removes the label. The row itself stays until its 7 days pass, so a repeat answers "כבר שוחזר".
- **An empty step 3 is a correct result,** because the label query is exact and the fence guarantees no archive request is still outstanding. The only ways to get there:
  - everything is already back, trashed or spammed;
  - the original archive never reached step 4, so the messages are still in the inbox.
  
  Either way nothing archived is left behind.
- **Gmail error** (a definite response): `claim_at = NULL WHERE claim_token = <mine>`, reply "השחזור נכשל, אפשר לנסות שוב".
- **Crash-safe.** A crash leaves `restored_at` NULL and the lease expires. A rerun repeats steps 3–5 correctly: restored messages no longer match step 3, and adding a label a message already has is a no-op.
  - **A slow response from an expired claim** finds `claim_token` changed, so it writes nothing.
- **Re-archived messages:** a message the user re-archived by hand still carries the batch label, so it comes back too. The reply says so in one line.
- **Rejected alternatives:**
  - **Per-id label checks:** up to 50 metadata calls, the whole subrequest budget.
  - **A time-window search:** imprecise, and it needs timestamp conversion.
- **Visible side effect, stated on the card:** the bot adds a temporary label under «בוט/» in Gmail, removed after a restore, after a failed archive, or after 7 days.

**Label cleanup (durable, idempotent, never gives up silently).**
- **Due when:** `label_state` is `present` or `unknown`, **and** the fence has expired (`exec_until IS NULL OR exec_until < now`), **and** either `op` is `restored` or `failed`, or `created_at + 7 days` has passed. Then `next_cleanup_at <= now`.
  - **Why the fence matters here:** a label is never deleted while an archive request might still remove `INBOX`.
  - **Why `failed` is safe to clean:** an execute that timed out at step 4 leaves `op = 'pending'`, never `failed`, so cleanup waits for a restore or 7 days. A `failed` row means step 4 was never issued, so a late-arriving step 3 can only add a harmless label.
- **The tick:** `runMaintenance` takes at most 3 due rows per tick. The bot only ever touches a label whose stored `label_name` starts with `בוט/ארכוב-` (a name it generated itself).
  - **`present`:** first `labels.get(label_id)`.
    - **The current name still equals the stored name** → `labels.delete(label_id)`.
    - **404 on get or on delete** → `label_state = 'deleted'`.
    - **The user renamed it** (current name ≠ stored name) → **do not delete**: `label_state = 'kept'`, a terminal state that counts as done for the tombstone rule. One notice, queued in the same transaction as the state change (shared rule): "התווית ששיניתם את שמה ב־Gmail נשארה; אפשר למחוק אותה ידנית". A renamed label is taken as the user's.
    - **Cost:** 2 calls per row, at most 6 subrequests per tick.
  - **`unknown`** (reconciling an uncertain create): one `labels.list` call, then look for the **exact** stored name.
    - **Found:** store its `label_id`, set `label_state = 'present'`, and delete it on the next pass.
    - **Not found:** `label_state = 'none'`, but only once a full day has passed since `created_at`. Before that, keep `unknown` and try again later, in case the create was still landing.
  - **A failed attempt:** keep the row. Set `cleanup_attempts + 1`, and `next_cleanup_at = now + min(2^attempts hours, 24 h)` (backoff).
  - **The 10th failure:** log one `label_cleanup_failing` line (row id and attempt count only, no names). Retrying goes on once a day, so an orphaned label is never abandoned silently.
- **What the retries keep:** only `label_name`, `label_id` and counters. `ids_json` is already NULL after 7 days, whatever the cleanup state.
- **Row deletion:** the tombstone rule (both 7 days passed **and** `label_state` is `none`, `deleted` or `kept`).
- Deleting the label also removes it from any messages, which is the intended end state.

**Checks and tests.**
- `MAX_WRITE_CALLS = 3` is exactly enough: archive makes 3 calls (`labels.create` + 2 × `batchModify`). `/unarchive` (2 calls) and cleanup are commands or maintenance, not tool executes.
- **Tests:**
  - **Archive bounds:** 49 / 50 / 50 + `nextPageToken` → no card; 0 results.
  - **Confirm:** a double confirm; an expired card.
  - **Restore targets:** stored ids now in the inbox, the trash, spam, or still archived; a labelled id outside the stored ids → never sent; an empty label query → `restored_at` set and nothing sent.
  - **Concurrency:** a double `/unarchive`; a slow first claim finishing after a second claim → no write.
  - **Archive steps:** an error and a timeout at each of steps 2, 3 and 4, plus a throw after each step:
    - step 2 with a definite error → `failed` / label `none`;
    - step 2 with a timeout → `failed` / label `unknown`;
    - step 3 → `failed` / label `present`, inbox untouched;
    - step 4 → `pending`, and `/unarchive` restores exactly the labelled stored ids;
    - a throw after step 1 → `pending` without an id, then `/unarchive` → "לא בוצע" and `failed`.
    
    Also: a create error is never treated as "exists", and the call count is ≤ 3.
  - **Interleaving (deterministic, with fake Gmail calls that pause on a promise):**
    - The archive pauses after step 3 (label added, `INBOX` still on). `/unarchive` runs → "עדיין מתבצע", with no read and no write. The archive resumes, finishes step 4 → `done`. A later `/unarchive` restores every stored message.
    - `/unarchive` while `labels.create` is in flight → "עדיין מתבצע".
    - Maintenance runs while the archive is paused at step 3 → the row is not due, and the label is not deleted.
    - The archive dies at step 4 (no final write). Before `exec_until`: "עדיין מתבצע". After it: `/unarchive` restores the labelled, archived messages.
    - **Assertion for every case:** each stored message ends up either in the inbox or archived with its label present while the row is restorable.
  - **Uncertain create:** the create succeeds remotely but times out locally. Maintenance `labels.list` finds the exact name → `present` → deleted next pass → `deleted`. A not-found before one day keeps `unknown`; after a day → `none`.
  - **Restore crash points:** after the claim, before the API call, after the API call before `restored_at` → the next `/unarchive` completes correctly.
  - **Repeat semantics.** In every sequence below, A is never touched:
    - Archive A, archive B, restore B, `/unarchive` again → "כבר שוחזר".
    - Archive A, B fails, `/unarchive` → "לא בוצע".
    - Archive A, archive B, restore B, cleanup deletes B's label, `/unarchive` → "כבר שוחזר" (B's tombstone is still within 7 days).
    - Archive A, archive B, 8 days pass, B's row is deleted, `/unarchive` → "עברו 7 ימים" (A is older).
  - **Labels:** a renamed label → found by id; a label the user deleted → no restore, the "deleted" reply, `label_state = 'deleted'`, `op` unchanged.
  - **Cleanup:**
    - **Normal outcomes:** the name matches → deleted; 404 on get or delete → `deleted`; a 5xx on get or delete → backoff and retry (and the retry rechecks the name); a stored name outside the prefix → never touched.
    - **Renamed by the user:** → `kept`, one notice, never deleted; the tombstone is then removable after 7 days.
    - **Retention:** `ids_json` cleared at 7 days even while cleanup is still failing; the row is deleted only after 7 days and once the label is `none` or `deleted`.
    - **Repeated failure:** the 10th failure logs once and continues daily; an `unknown` label not found within a day stays `unknown`, then `none`.
  - **Limits:** an expired lease; restore after 7 days; scope missing; scope unticked at consent.
- **Evals:** `ma-`, including overflow.

## L6: Documents ("Files", idea #5, server + app 0.20.x; new scope)

**Tool.** `docs.create` (Tier 2, `dataSource: 'drive'`, `consent: 'always'`; decision D1). The body may summarize data read earlier in the turn, so the tool is not `exempt-own-input`.
- **Body:** model free text, display-only (invariant 3), at most 8,000 chars, links defanged. The title is capped.
- **Tainted turns:** refused. Marked `refusesTainted`, and its own `resolve` checks `ctx.tainted`; the orchestrator only passes the flag (`core/orchestrator.ts:252-254`).

**Card.**
- **Destinations, named explicitly:** "יישמר בטלפון (הורדות) ויועלה ל־Google Drive כמסמך", or "יישמר בטלפון בלבד" when Drive is not connected or lacks `drive.file`.
- **Content:** the title, the length, and the first and last lines.

**Drive.**
- **Scope:** `drive.file` (non-sensitive), in `grants.ts`, `oauth.ts:23`, plus reconnect and a PLAN §14 line.
- **Upload:** `files.create` multipart, target `application/vnd.google-apps.document`, with `appProperties: { op: <confirm id> }`.
- **Source type:** `about.importFormats` is read once and cached. Upload as `text/markdown` if it is listed, otherwise `text/plain`.
- **Staging check before the feature counts as done:** the created Doc holds the body.

**Three outcomes, worded exactly:**
- **Created:** the create returned the file, or reconciliation found it. "נוצר ב־Drive" + link.
- **Failed:** only when Google answered the create with an error response (4xx). A server that answered with an error did not create the file. "ההעלאה ל־Drive נכשלה".
- **Unknown:** a timeout, a network error, a 5xx, or the turn deadline. One reconciliation call, `files.list` with:
  - `q = "appProperties has { key='op' and value='<id>' } and trashed = false"`
  - `fields=files(id,webViewLink)`, `pageSize=1`
  
  The `<id>` is the confirm action's hex id, so no quote escaping is needed and the schema forbids anything else. Found → **Created**. Not found, or the lookup fails → stays **Unknown**: "לא ברור אם המסמך נוצר ב־Drive, אפשר לבדוק שם". It is never "failed", because a just-created file may not be listed yet.
- **No retry** of the create, ever. The confirm machinery executes a stored input once. A new request is a new document, intended.
- **To verify in staging** (Google's Drive reference could not be fetched in this review): the `appProperties has` query syntax, and that `drive.file` lists files the app created. Both are written as integration tests against the fake, plus one staging run.

**Partial failure.**
- **Drive fails:** the reply says the document was saved on the phone only, and the file card still goes.
- **The phone save fails:** the app shows its existing save error, and the Doc link is already in the reply.
- **Neither failure rolls back the other,** and every reply names exactly what happened.

**Stored body.** The document body lives in `pending_actions.input_json` until the card's expiry plus 1 h, the same as the CSV export. §6 says so.

**File card.** Widened to the closed pair `text/csv | text/markdown`, with matching name patterns, on server and app (`render/phone.ts:45`, `DeviceActions.kt:375,392`, `Protocol.kt` vectors). **Server first.** The body sits in the outbox for its retention, like any card.

**Tests.** Tainted refusal; the card wording with and without Drive; an uncertain outcome found and not found; reconciliation failure; Drive 403 scope missing; importFormats with and without Markdown; the file card schema on both sides. **Evals:** `doc-`.

---

## Cross-cutting checks

- **Catalog:** the four new tools (`mail.follow_up`, `expenses.monthly_pack`, `mail.archive`, `docs.create`) are offered **only when their group is selected**, like `screen.task`/`routine.run`, and are kept out of the full catalog (40 tokens of slack). Each one is measured; no re-pin without a measured `fit.test` case.
- **Persistence paths:**
  - **History:** these tools' replies go through the existing `settleAgentResult` (consent placeholders in smart conversations; scheduled notices never enter history).
  - **Learn journal:** stores only what its existing kinds collect (`core/learn-store.ts`).
  - **Logs:** the log-canary test is extended with fake subjects, amounts and titles.
- **No new dependencies.** $0.
- **Docs:** PLAN §6 sections for the four features, §14 lines for both scopes, ARCHITECTURE (new tables 0037–0040, client methods), and `ops/runbook.md` commands.

## Rejected or adjusted

- **Undo for archiving through the Tier 1 framework:** archiving must confirm, and Undo exists only for Tier 1 (`tools/types.ts:268,307`). The deterministic `/unarchive` replaces it with no framework change.
- **A general idempotency subsystem for Drive:** one `appProperties` marker plus one reconciliation call covers the only uncertain side effect.
- **Matching the reply sender to the original recipient (L2):** it needs stored email addresses (invariant 2). The semantics are stated as "someone replied" instead.
- **Converting currencies in L4:** no requirement for it, and a free rates API would add a dependency.

## Review log (2026-10-15, final round)

Confirmed in code and fixed in this plan:
1. **Lost tap replies (L2/L3):** a state could move while its card was never delivered.
   - **Fix:** L2 updates its row and creates the pending card in one transaction; L3 uses a 2-minute lease.
   - **Recovery:** a re-tap re-sends a live card.
   - **Backstop:** `reminders.leave` checks `event_id` at execute.
2. **`/unarchive` mixed claim and completion,** so a crash could leave a batch unrestorable. **Fix:** a separate lease (`claim_at`) and completion field (`restored_at`); a repeat is safe because adding a label is a no-op.
3. **`listIds` could not detect overflow** (`gmail.ts:171-179` ignores `nextPageToken`). **Fix:** `listIdsBounded` returns `more`. Both the archive bound and the restore bound use it.
4. **Granted scopes were never compared with the requested ones** (`oauth.ts:183`). **Fix:** they are stored and checked per tool. A new scope is proven only by a fresh consent.
5. **The bills scan is capped at 8 and skips failed reads silently** (`bills.ts:31`, `gmail.ts:160`). **Fix:** a `skipped` count and cut lines in the file.
6. **The earlier wording of where the monthly CSV is stored was wrong.** It lives in `pending_actions.input_json` until expiry + 1 h, and the outbox holds a 300-char preview. Corrected.
7. **L2 header rules:** `Precedence: list`, `List-Id`, `report-type=delivery-status`, `X-Failed-Recipients` and case-insensitive matching were missing. Added, with a test matrix.

Already covered by existing code:
- **Transaction rollback:** `transactionSync` and the test driver's BEGIN/ROLLBACK cover it. A failure-injection test was added rather than a new abstraction.
- **Push retry:** the outbox's own `next_push_at`.

Rejected:
- **A generic lease or workflow layer:** two per-feature fields cover the real failure points.
- **Per-id label checks for restore:** they would use the whole subrequest budget.
- **Raising `MAX_BILLS`:** it shares the tick's subrequest budget.
- **Reporting Drive "not found" as a failure:** the listing may lag.

Additional review (2026-10-15), confirmed and fixed:
1. **L5 timestamp units:** a milliseconds `after:`/`before:` window, but Gmail takes seconds or dates. The window was removed and replaced by a per-batch label: exact, no boundaries, no 500 limit.
2. **L5 archive crash recovery:** the batch row is now written before any Gmail call (confirm marks the action executed first, `pending.ts:138-143`), with `pending|done|failed` and an "unknown" reply.
3. **L5 card "top senders":** it would cost up to 50 metadata subrequests. The card now shows the count and the filter in words.
4. **L3 stale suggestions:** a "too late" check on the re-read start, plus `reminders.leave`'s own future check.
5. **L3 and `/unarchive` stale claims:** a `claim_token` on every lease, so a slow response from an expired claim writes nothing.
6. **OAuth:** the 7-day observation is now labelled indirect evidence. Only a fresh `gmail.modify` consent is proof.

Edge-case review (2026-10-15), accepted:
1. **Label ids, not names:** the row stores `label_id` and `label_name`; the restore filters by the `labelIds` parameter; a deleted label gets its own reply.
2. **The label is added before `INBOX` is removed,** in separate calls, within `MAX_WRITE_CALLS = 3`; any label-create error stops the run with nothing archived.
3. **`/unarchive` targets only the newest batch** and answers "כבר שוחזר" instead of moving on to an older one.
4. **Durable cleanup:** at most 3 rows per tick, 404 counts as done, the prefix is checked, and `ids_json` is cleared at 7 days. Superseded by the consistency review below: the label lifecycle is now its own field, `label_state`.
5. **L3:** every exit from `checking` carries the claim token.
6. **L2:** a mailer-daemon sender alone → `unsure` ("ייתכן"); `bounced` only on a DSN or `X-Failed-Recipients`.

Rejected: looking up an existing label **inside the execute** after a create error. It would be a fourth call. An uncertain create is reconciled later in maintenance instead (see below).

Consistency review (2026-10-15), contradictions found and fixed:
1. **`/unarchive` selection contradicted "newest only".** It picked the newest `done|pending` row, so it could skip a newer `restored` or `failed` batch and restore an older one.
   - **Fix:** select the newest row by `created_at` whatever its `op`, then branch; nothing falls through.
   - Rows are tombstones, kept until their 7 days pass, so a deleted newest row implies every remaining row is older.
2. **`status` mixed the mail operation with the label lifecycle,** so cleanup could overwrite `restored`. **Fix:** two fields, `op` and `label_state`; cleanup never touches `op`.
3. **An uncertain `labels.create` left an orphan label untracked.** **Fix:** `label_state = 'unknown'` is written *before* the create, and maintenance reconciles it with one `labels.list` by the exact name, waiting one day before concluding "none".
4. **Cleanup "retried until success" contradicted "dropped after 10".** **Fix:** backoff up to daily, one redacted log line at 10 failures, and it never gives up silently. The message ids still go at 7 days.
5. **A crash after step 1 left `pending` with no label id,** and its handling was undefined. **Fix:** it is treated as "nothing archived" (`INBOX` is removed only in step 4), and the row is set to `failed`.

Concurrency review (2026-10-15):
1. **Possible in the code (fixed): `/unarchive` or cleanup racing a running archive.**
   - **Why it can happen:** a confirm executes without the agent lock (`pipeline.ts:445-468`), and Durable Objects interleave requests at `fetch`.
   - **Fix:** an `exec_until` fence, written in the row before any Gmail call and re-checked inside every claim and cleanup selection. 5 minutes is well beyond `MAX_WRITE_MS`. The stated assumption: a Gmail request does not complete minutes after it was sent.
   - **Not used:** a database token, because it cannot stop a request already sent. The fence waits for any such request to finish instead.
2. **Confirmed (fixed): cleanup would delete a label the user renamed.**
   - **Fix:** a `labels.get` before delete. A changed name → `kept`, never deleted, with one notice.
   - **Cost:** one extra call per row, at most 6 per tick.

Not verified (documentation could not be fetched here; to verify at implementation):
- Gmail: `labels.create` / `labels.delete` responses (404 on a missing label), the `labelIds` filter on `messages.list` combined with `q`, and whether `batchModify` is atomic. The design does not rely on that last one.
- Google's refresh-token expiry rules.
- The Drive `appProperties has` query syntax.
- Whether `drive.file` lists app-created files.
- Whether the consent screen is In production today (checked indirectly in L5 step 1).

## Execution order and verification

1. **L2.** Then L3, L4, L5 (after its precondition), L6.
2. **Per part:** `pnpm typecheck && pnpm lint && pnpm test`; `pnpm eval:agent --filter fu-|ma-|doc-` (and the monthly pack's eval cases) on qwen with a human read; then `pnpm deploy:staging`, with the version id recorded in HANDOFF §8.
3. **App 0.20.0,** after L2's deploy (command list). App 0.20.x after L6's deploy (Markdown card). Both are built to Downloads; installing them is the user's step.
4. **Staging checks:**
   - **L2:** a real follow-up with a short deadline.
   - **L3:** `/suggest on` and the next day's notice.
   - **L4:** an on-request pack.
   - **L5:**
    - **Step 1 without the user:** the gmail grant is older than 7 days and still refreshing.
    - **After deploy:** `/connect gmail`, then check that the stored scopes include `gmail.modify`.
    - **Test:** archive 2 test mails, then `/unarchive`.
   - **L6:** a document with Drive connected, whose body appears in the Doc.

## Unresolved (needs the user)

- **D1:** `docs.create` uses `dataSource: 'drive'` with `consent: 'always'` (recommended).
- **Reconnect:** L5 and L6 each need the user to run `/connect` for Gmail and Drive after deploy. This is the user's own action, not a decision.
