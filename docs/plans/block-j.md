# Block J — ideas taken from OpenClaw, kept free

## Context

The user asked for a scan of OpenClaw (github.com/openclaw/openclaw) and a plan to improve the bot with what fits, under one hard rule: **$0 recurring cost**.

OpenClaw is a large self-hosted assistant (~200 plugins). Most of it does not fit:
- **Breaks the $0 rule:** paid providers, media generation.
- **Breaks the invariants:** code execution, browser control, self-learning skills, standing autonomous orders.

Seven ideas survive. Each one maps onto existing code and stays inside CLAUDE.md invariants 1–13, Workers Free, and the Groq/Gemini free tiers. The block is called **J**, the next free ROADMAP block.

Every part is its own small commit:
- `pnpm typecheck && pnpm lint && pnpm test`, plus the evals the part names.
- In the same commit: HANDOFF, ARCHITECTURE, PLAN §14, and the ROADMAP line.
- **Server before APK** for any wire change.
- Migrations take the next free number at build time. 0031 is the latest committed now, and another session works on screen files, so re-check.

## Order and why

| # | Part | OpenClaw source | Size | Moves the Groq eval fingerprint? |
|---|---|---|---|---|
| J1 | Fewer wasted calls when a model repeats a bad call | tool loop detection | small, server | No (loop code only) |
| J2 | Room in the full catalog | Tool Search ("shorten before omitting") | medium, server | **Yes**: one full `eval:agent` |
| J3 | Read a shared link | link-understanding + web-readability | medium, server | No (offered only when a URL is present) |
| J4 | "When X arrives, remind me" | Standing Intents | large, server + app | No (offered only when named) |
| J5 | Smarter digest (conflicts, bills) | Heartbeat (code-only) | medium, server | No |
| J6 | Speak replies to voice notes | TTS | small, app | No |
| J7 | Do not save the same fact twice | Dreaming (code-only subset) | small, server | No |

J3 and J4 are gated like `screen.task`: a flag on `OfferOptions` in `agentToolNames` (`src/agent/tools.ts:198-214`), set by the pipeline (`pipeline.ts:862-866`). They are never in `agentToolNames(FULL)`, which is what the fingerprint hashes (`test/evals/fingerprint.ts:52,58`). So **J2 is the only part that needs a full eval run**.

---

## J1 — Fewer wasted calls when a model repeats a bad call

The facts:
- On Groq, `maxModelCalls` is 3 (qwen and gpt-oss, `models.ts:74-76,90`), and the last call is already text-only (`loop.ts:932-934`). J1 gains nothing there.
- Only smart models (Gemini, 6 calls, `models.ts:133`) can repeat a bad call 3–5 times.

### Design
- Add a `code` field to `ToolOutcome.retry` (`loop.ts:1017`). Its values are the existing reasons: `unknown_tool`, `invalid_arguments`, `arguments_not_json`, `access_not_allowed`, `one_phone_read_per_turn`.
- Add `retryKeys: string[]` to `Loop` (`loop.ts:301-342`).
  - The key is the tool name + a hash of the raw arguments + the code.
  - Record it in `act()` on the retry branch (`loop.ts:857-860`).
- When a key repeats, the next model call is **text-only**: tools are dropped, the same as the existing last-call rule. The turn does not fail, so no extra parser call is spent and the wording stays the model's.
- This applies only when `maxModelCalls > 3`.
- `retryKeys` is not stored in the suspended state (`paused()`, `loop.ts:822-847`), so a resumed turn starts fresh. That is harmless and stated in the code comment.
- One `agent_turn` log field `repeat: true`. Codes only.

### Tests and evals
- Test first, `test/unit/agent/loop*.test.ts`, with a fake provider and a 6-call model:
  - A repeated invalid call makes the next call text-only.
  - Different arguments do not.
  - A Groq-shaped model (3 calls) is unchanged.
- No eval is owed: the prompt, catalog and wire are unchanged. A short `--model gemini-3.5-flash-lite --filter inj-` run is optional.

---

## J2 — Room in the full catalog (closes PLAN §13 lines 2952 and 2955)

A local turn whose message names no tool group sends ~6,500 tokens of catalog against a 6,600 budget. OpenClaw's rule: when space is tight, shorten descriptions before dropping tools.

A separate "describe" call, as OpenClaw does, costs a model call, which is too dear with a 3-call cap.

### Decision D1: both mechanisms, local turns only. Smart turns are unchanged.

**(a) Inherit groups.**
- A local message that names no group, sent within 10 minutes of the previous **agent** turn in the same conversation, is offered that turn's selected groups instead of the full set.
- **Storage:** a new small table, `last_selection(principal, conversation, seq INTEGER, groups TEXT, tainted INTEGER, at INTEGER)`, primary key `(principal, conversation)`.
  - Plain text: group names are code constants, not content.
  - **Written when the local plan is made, not at settle time.**
    - `selectTools` runs inside the loop's lazy `local()` (`loop.ts:425-435`).
    - A new synchronous callback, `AgentDeps.onLocalSelection(selection)`, is called there.
    - The pipeline passes the callback only for a new message: not a resume, not the read-only second try. It does one synchronous upsert with `seq` from `deps.repo.inboundSeq(wamid)` (`pipeline.ts:694`).
    - The inherited groups go into `runAgentTurn` as input, and `selectTools` takes them at `loop.ts:427`.
    - Writing at plan time avoids the suspend, failed and resume paths of `settleAgentResult` (`pipeline.ts:879-900`, `945-957`, `1083`, `1193`) and needs no new field on `AgentResult`.
  - **Ordered by `seq`:** the upsert is `ON CONFLICT … DO UPDATE … WHERE excluded.seq >= last_selection.seq`, as `last_exchange` orders by `seq` (`exchanges.ts:6-9,62`).
  - **Purge:** a `purgeExpired()` in the `alarm()` purge list (`assistant-do.ts:364-368`) deletes rows older than 10 minutes. Without it, nothing would ever remove them.
  - Read synchronously by the pipeline before `selectTools`, and passed in as an argument. `selectTools` stays pure and synchronous (`tool-groups.ts:186`).
  - `ExchangeLog` is **not** used: it must never reach the agent (`core/exchanges.ts:13-14`), and its `groups` are matched words, not the offered selection.
  - Evals cannot cover inheritance, because the fingerprint selects on single messages (`test/evals/fingerprint.ts:65`). Unit and pipeline tests are its only gate.
- **Never inherited:**
  - when the previous turn **started** tainted (a forwarded message). Taint picked up later by reads is not tracked here. The groups are code constants and only narrow what is offered, and taint itself carries through history and `PolicyContext` as today. So the `tainted` column holds only the starting taint.
  - when the previous selection was the full set;
  - the `routine` and `screen` groups, which are offered only when named.
- Migration `00NN_last_selection.sql`. HANDOFF and ARCHITECTURE count it.

**(b) Brief descriptions.**
- Add an optional `llmBrief` (≤ 80 chars, enforced by a test) to `ToolSpec` (`registry.ts:246`). It is written by hand for the largest tools first.
- `wireTools(names, { brief })` (`tools.ts:244-262`): `plan()` (`loop.ts:406-419`) passes `brief: true` only for a **local** turn whose selection is the full set. Smart plans (`loop.ts:444`) pass nothing, so `smartFingerprintFor` does not move.
- Slot schemas (`compactSlot`) are unchanged, so Zod validation is identical.
- Target: a full local first call ≤ 5,500 tokens, measured with `scripts/bench-tokens.ts`.

### Fingerprint, tests and evals
- `fingerprintFor` also hashes `wireTools(agentToolNames(FULL), { brief: true })`, so the brief catalog is pinned. Re-pin `test/unit/agent/fingerprint.test.ts`.
- `fit.test.ts`: the full set fits ≤ 5,500 + 400.
- `tool-groups.test.ts` and a pipeline test, for the inherit cases: in window; out of window; tainted; full; routine/screen never inherited; smart unaffected.
- Evals:
  - One full `pnpm eval:agent` on qwen and on gpt-oss-120b, with `--resume` across days for the daily 200K budget.
  - Plus `--select-tools` on qwen. That also clears that §13 item.
- `canWrite` does not change. Because J3 and J4 do not move the fingerprint, this is the block's only full run.

---

## J3 — "Read this link": summarize a page

### Tool `web.read`
- **Tier and source:** Tier 0, agent-only. `dataSource: 'public'`, with no `consent` field: the type pairs `public` with `consent?: never` (`registry.ts:234-236`).
- **Taint:** always taints (`TAINTING_TOOLS`), since the page is someone else's words.
- **Offering:** only through a new `webRead` flag on `OfferOptions`. The pipeline sets it when the user's own text holds exactly one `https://` URL, or the shared text does.
- **Smart conversations:** the DO merges shared text into the message (`assistant-do.ts:1360`), and a forwarded turn never goes to a smart model (`smartWanted`, `pipeline.ts:586,806`). So invariant 2 holds by construction: a shared URL is read only in a local, tainted turn. A URL the user typed in a smart conversation may be read there: the page is public, and its text is scrubbed. The URL count runs on the composed text.
- **Arguments:** none. Code takes the URL from the message, so the model never supplies it.

### Fetch and extract
**Fetch, with an SSRF guard:**
- `https` only, port 443 only.
- Refuse IP literals, `localhost`, and `.local` / `.internal` hosts.
- Manual redirects, at most 2, each re-checked.
- 300 KB byte cap, read streamed. Reuse the `readCapped` pattern from `/wa/webhook`.
- 8 s timeout combined with the turn signal (`AbortSignal.any`, `src/tools/turn-signal.ts`).
- Place the new call site in `test/security/turn-signal-fetch.test.ts`. Use a fetch closure, never `this.fetchImpl`.

**Extract:**
- New `src/platform/html-text.ts` using `HTMLRewriter`. It is a Cloudflare API, so it lives in `platform/` (invariant 11).
- Keep the text of `title`, `h1–h3`, `p` and `li`. Skip `script`, `style`, `nav`, `footer`, `aside` and `form`.
- Exposed as an interface on `ToolContext` and bound in `tools/turn-signal.ts`, so tests run on Node with a fake extractor.

**To the model:** 1,500 chars, through `resultForModel` (`loop.ts:1100`), which scrubs and caps. The summary is display-only and defanged.

### Tests and evals
- Tests (security, test first):
  - URL guard table.
  - Redirect to a private host refused.
  - Byte cap.
  - Taint carries to a following write.
  - A forwarded turn with a URL runs local and tainted, never smart.
  - Extractor fake on 3 saved HTML fixtures.
- CPU measured on a real page in `wrangler dev` (10 ms budget).
- Eval cases `wr-` in their own YAML: summarize; a link plus "remind me about this", where the write CONFIRMs; injection in the page. `pnpm eval:agent --filter wr-`.
- `pnpm eval` is not owed (agent-only).
- PLAN gets a §6.x for the tool and a §14 line. Run the `add-tool` skill.

---

## J4 — Event-triggered reminders ("when … arrives, remind me …")

### The tool
- **Name and tier:** `reminders.when`. Tier 1: creating a watch echoes only the user's own words, so Undo is enough. The `add-tool` skill decides `consent` (`exempt-own-input` only if proven).
- **Offering:** only through a new `watch` flag on `OfferOptions`, and only when `channel === 'app'`. There is no outbox on WhatsApp (`assistant-do.ts:2100-2101`); the gate is the pattern of `pipeline.ts:862-866`. The pipeline sets the flag when the words match a "when … arrives / comes" pattern (Hebrew and English) in `tool-groups.ts` patterns. It is never in the full catalog, so the fingerprint is unchanged.
- **Slots** (strict Zod):
  - `source`: `mail` | `notification` | `sms`.
  - `keywords`: 1–3 items, each ≤ 30 chars.
  - `text`: ≤ 200 chars.
  - optional `expires` TimeSpec, resolved by code (`src/time/resolve.ts`). The default is 30 days.
- **Limits:** at most 10 active watches. One fire by default; `repeat` gives up to 5 fires with a 1-hour cooldown.
- **Listing and cancelling:** a deterministic `/watches` command with cancel buttons `wt:<id>:<nonce>`, the pattern of `/consents`. The parser tools `reminders.list` and `reminders.cancel` are **not** touched, so `pnpm eval` is not owed. Expired and cancelled watches are not listed.

### Matching

**Phone sources (notification, SMS): matched on the phone. No message text ever leaves it.**
- The app fetches active watches (id, source, normalized keywords, `expires_at`) from a new signed route `/app/watches`, at app start and on a new FCM `kind: watches` signal after any change.
  - The signal needs a sender in `src/device/fcm.ts`, next to `routine` and `screenTask` (`fcm.ts:95-103`), and a branch in `CompanionMessagingService.kt:35-44`.
  - An older APK ignores the signal. A missed signal only delays a cancel; it never causes a wrong fire, because the server claim re-checks the watch.
- The phone itself skips an expired watch.
- **Where to check:** `NotificationCollector.kt`, **after** its hidden-app check (`NotificationCollector.kt:31`).
  - `notification` watches skip the default SMS app's package.
  - `sms` watches check only the newest SMS, read when that SMS app posts a notification. No new permission or receiver.
  - So one SMS cannot fire both kinds.
- **Normalization** is identical on both sides: Hebrew final letters folded, niqqud and punctuation stripped, lowercase. It must equal `test/fixtures/watch-normalize.json`, with a test on each side, as `screen-policy.json` does.
- **A match sends** `POST /app/watch/fired {watchId, matchedAt, nonce}`. The key is marked handled only after a 2xx, and a failure is queued (see the follow-up).
  - It follows invariant 9's ingress order and carries no message text.
  - The server drops anything with `matchedAt` older than 10 minutes (invariant 12) and logs `watch_stale`.

**Mail: matched on the server, in the hourly `/do/tick`** (`src/index.ts:249-275`), for active mail watches only.
- The check runs **before** `maybeSendDigest`, in its own try/catch. A digest error or early return never skips it (`assistant-do.ts:342-345`).
- Code builds the query: `after:<max(created_at, last_checked − 15min)>`, so mail from before the watch existed never fires. Plus the keywords as quoted terms (or `from:` words when the user said "from X").
- Ids only, no bodies. The existing Gmail grant, with no new scope; if one were needed, stop and ask.
- A per-watch set of the last 50 seen ids stops the 15-minute overlap from firing twice (see the review additions). Gmail list order is not relied on.
- After the await, `last_checked` and the seen set are written with a conditional `UPDATE … WHERE status='active'`, so a watch cancelled meanwhile stays cancelled.

### Firing (both paths)
1. (No decrypt step: the text is stored in plain text, as in reminders. See Storage.)
2. **One synchronous transaction**: claim (`status='active' AND expires_at > now AND fires_left > 0 AND (cooldown_until IS NULL OR cooldown_until <= now)`), decrement, and **schedule a due-now one-off reminder** with the stored text in the reminder store.
3. Then `armAlarm`.

The fire therefore goes through the **same** delivery path as any due reminder: `alarm()` → `canDeliver` → the rest hold (Shabbat and chagim) → `claimDue` → outbox → FCM (`assistant-do.ts:391-407`). A fire during Shabbat waits for its end, like any reminder.

`ReminderStore.schedule` is synchronous and joins the outer transaction (`reminder-store.ts:95-140`, `core/sql.ts:17`). A held fire is delivered late with a note, never dropped (`assistant-do.ts:1878-1879`).

Consequences:
- A crash before step 2 spends nothing.
- A crash after it leaves a scheduled reminder, which the next alarm delivers. `armAlarm` already wakes on the next reminder.
- Never retried; two fires race and only one claims.
- The reminder text is the user's own words. The trigger text never reaches the server or a model, so there is no taint.
- Invariant 10 holds: a fire is a delivery, like a due reminder, with no model and no write.

### Storage
Migration `00NN_watches.sql`:
- `watches`: `id`, `principal`, `source`, `keywords`, `text`, `fires_left`,
  - `keywords` and `text` are stored in plain text, exactly as reminder text is (`reminder-store.ts:125-130`). A fire copies the text into `reminders` anyway, so encrypting only here would protect nothing.
  - So step 1 of Firing (decrypt) falls away. The claim and the `ReminderStore.schedule` call (synchronous, joins the outer transaction: `reminder-store.ts:95-140`, `core/sql.ts:17`) are one transaction.
  - The remaining columns: `cooldown_until`, `expires_at`, `last_checked`, `seen_ids`, `status`, timestamps.
- Purged 90 days after it ends, like reminders (`purgeSettledBefore`).
- Registered in `src/platform/migrations.ts`.

### App
- Version bump.
- `WatchStore.kt` and `WatchMatcher.kt`, both pure and tested.
- Wiring in `NotificationCollector.kt` and `Api.kt`.
- `Protocol.kt` vectors matching `src/channels/app/parse.ts`.
- Hebrew strings through `hebrew-i18n`.

### Tests and evals
- Server tests first:
  - Claim race: two fires, one outbox row.
  - Expired, cancelled, cooldown and cap-of-10 cases.
  - A stale `matchedAt`.
  - The mail query builder, which takes no model text. A mail from 30 minutes before the watch was created does not fire.
  - A fire during the rest hold is delivered after it.
  - The `watch` flag is never set on the WhatsApp channel.
  - A cancel during the mail tick's await.
  - The ingress order for `/app/watch/fired`: an unknown or revoked device gets 401.
- `./gradlew testDebugUnitTest`: the matcher, fixture equality, and the SMS/notification split.
- Eval cases `wh-`: Hebrew and English; a missing source gets CLARIFY; injection. `pnpm eval:agent --filter wh-`.

### Docs
- PLAN: a new §6.29 for the data flow ("the phone matches locally and sends only an id"), plus a §14 line.
- `ops/runbook.md`: `/watches`.

---

## J5 — Smarter daily digest (code only, no new pushes)

OpenClaw's heartbeat surfaces what matters. Here it stays code-only and rides the existing digest (`maybeSendDigest`, `assistant-do.ts:1000-1059`), so there are no new pushes, rate limits or quiet-hours rules.

### Two optional sections, off by default
- **Calendar conflicts tomorrow:** overlapping timed events, computed in code over tomorrow's events.
  - Reuses the read window in `src/time/range.ts` and the iCal merge in `src/ical/merge.ts`.
  - Touching ends are not a conflict, and all-day events are ignored.
  - Shows times plus titles, to the user only, defanged.
- **Bills due within 7 days:** `buildBillsQuery` and `billAmount`/`billDue` (`src/tools/bills.ts`, `bill-extract.ts`) at digest time. At most 8 bodies, as now. Only bills with a parsed due date in the window are listed.

### Other details
- An empty section is not rendered, so a quiet day stays quiet.
- **Command:** `/digest conflicts on|off` and `/digest bills on|off`. This needs a router change (`src/core/router.ts:71`), router tests, and PLAN §6.12.
- **Settings** are stored like `REST_HOLD_KEY` (`src/core/repo.ts:329`). No migration.
- **Tests:**
  - The overlap detector, including the 2026-10-25 fall-back night.
  - Digest snapshots.
  - A digest that hits a Gmail error still sends the other sections.

---

## J6 — Speak replies to voice notes (app only)

- In the app, when an incoming reply's `message_id` matches an outgoing row of kind `voice` (`ChatStore.saveRows`, `Turns.kt:72-81`), speak the displayed text with Android `TextToSpeech`, `he-IL`.
- Rules:
  - A settings toggle, **off** by default.
  - Not when the phone is on silent or vibrate.
  - Not for replies that arrive later by push.
  - Stop on tap.
- No server or wire change.
- Tests: the "was this a reply to voice" join, as a pure function.
- Hebrew strings through `hebrew-i18n`.

---

## J7 — Do not save the same fact twice

`sql.transaction` is synchronous (`src/platform/sql-repo.ts:17`) and decrypting is async (`fact-store.ts:67`).

### Design
1. In `memory.remember`'s execute, read the facts with `all()` **before** the transaction. `all()` already drops rows it cannot decrypt.
2. Compare normalized text for **equality only**. Normalization: case-fold, collapse whitespace, and strip only surrounding quotes and one trailing period. Inner punctuation and digits are kept (`1.5` ≠ `15`). Containment is not used, because a longer fact may be a correction.
3. On a duplicate, return a code-rendered "already remembered" reply and write nothing.
4. Otherwise `FactStore.add` runs as today. Its synchronous cap check stays inside the transaction (`fact-store.ts:36-43`).

The agent lock does **not** cover this. Confirmations, open-question answers and buttons run without it (`pipeline.ts:416,520-523,533-535`). So:
- `add` takes the count it saw in step 1. Inside the transaction it re-checks that the count is unchanged.
- If the count changed, it inserts anyway. The worst case is a rare duplicate, never a lost fact.
- The code comment says exactly this.

The duplicate reply carries **no** `compensating` or `externalRef`. Otherwise Undo (`memory.ts:73`) would delete the original fact. A test pins this.

### Other details
- `memory.remember` is `private` and Tier 1 (`registry.ts:896,900`), so the new reply needs no consent pin.
- The Hebrew string goes through `hebrew-i18n`.
- Tests in `test/unit/tools/memory*.test.ts`.

---

## Not in this block

| Idea | Why not |
|---|---|
| History compaction | It costs a model call per turn, and stored summaries complicate smart-conversation consent. Revisit after J2. |
| Image or PDF understanding | First a human step: check in the Groq console whether a free vision model exists. ML Kit has no Hebrew OCR. |
| DuckDuckGo search | Unofficial, and likely bot-challenged from Cloudflare IPs. |
| Self-learning, code mode, browser, standing orders | They break invariants 6, 8 and 10. |

---

## Verification

1. Per part: `pnpm typecheck && pnpm lint && pnpm test`. For J4 and J6, also `cd apps/call-companion && ./gradlew testDebugUnitTest`.
2. The evals each part names, with the report read by a human before anything gates on it.
3. `pnpm deploy:staging` only with approval in the session. For J4: server first, then the APK.
4. Phone checks:
   - **J3:** share a news link, get a summary.
   - **J4:** a watch on a notification word fires once, and a cancelled one never does.
   - **J5:** turn on conflicts with two overlapping events tomorrow.
   - **J6:** a voice note's answer is spoken.
5. ROADMAP gets block J, one line per part. HANDOFF §6 and §8 get updated in each part's commit.

---

## Caught in review (round 1)

- **[data] J7 BLOCKER:** the plan decrypted inside a synchronous transaction (`sql-repo.ts:17`, `fact-store.ts:10-11`). Now: `all()` first, then the sync insert.
- **[data] J4:** the claim came before an async decrypt, so a fire could be lost. Now: decrypt, then claim and outbox insert in one sync step. Also: `expires_at` in the claim, `after:` plus a seen-id set for mail, and stale `matchedAt` dropped.
- **[concurrency] J4:** the mail tick wrote after an await. Now a conditional `UPDATE … WHERE status='active'`. One SMS could fire two watches; now split by package.
- **[consistency] J1:** the premise was wrong (gpt-oss is also 3 calls, and Groq's last call is already text-only). Now: text-only after a repeat, only when `maxModelCalls > 3`. No failure, no parser call.
- **[consistency] J2:** no `ExchangeLog` (`exchanges.ts:13-14`); a `last_selection` table instead. Brief descriptions for local turns only, so the smart fingerprint is unchanged.
- **[consistency] J3:** gated in `agentToolNames` and not in `selectTools`, because smart turns skip `selectTools`. `public` with no `consent`. A shared URL is never read in smart mode.
- **[blast-radius]:** J3 and J4 are kept off the full catalog, so there is one full eval run, not two. `/watches` replaces parser changes. The `/digest` router change is now listed.

## Additions from the user's review notes (binding on the build)

**Precedence:** this section and the follow-up section below are authoritative. Where they differ from a part section above, they win; the known clashes have also been fixed in place. The "Caught in review (round N)" sections at the end are **history only**, not instructions.

### Follow-up (final pass)
- **J4, Gmail window: authoritative values.**
  - Overlap: 15 minutes.
  - At most 50 results per list.
  - One claim attempt per watch per tick.
  - `last_checked` is the tick's **start** time. It is written only after a successful list, with a conditional UPDATE `WHERE status='active'`. A failed list leaves it unchanged, so the next tick looks back further.
  - **Accepted limit, documented in PLAN §6.29:** a mail that becomes searchable more than 15 minutes after the tick that should have seen it is missed.
  - Tests:
    - A mail indexed after tick N but within the overlap fires at tick N+1.
    - One outside it does not.
    - A mail exactly at the `after:` second is included. Gmail's `after:` is inclusive at second precision, verified against the Gmail search docs at build time.
    - A full page of 50 makes one claim.
- **J4, phone offline.** The notification key is marked handled **only after** the server answers 2xx: either "claimed" or "nothing to claim" (spent, expired, cancelled or cooling down).
  - On a network failure or timeout, the event `(watchId, key, matchedAt)` goes into a persistent pending list in `SharedPreferences`: at most 20 entries, ids only, no content.
  - The list is retried on the next connectivity callback or app start, each attempt with a fresh nonce.
  - Entries older than 10 minutes are dropped without sending, since the server would refuse them as stale.
  - **A retry after a lost response is safe:** the first attempt already spent the fire. A one-fire watch has `fires_left = 0`; a repeat watch is inside its cooldown. So the retry claims nothing.
  - Tests:
    - App: a failed post keeps the key unmarked and queued; a 2xx marks it; a 10-minute-old entry is dropped.
    - Server: the same event posted twice with different nonces gives one reminder.
- **J4, event identity: authoritative, supersedes "one fire per notification key".** Apps update one notification for many messages (SMS apps and chats reuse one id), so the bare key would suppress a later real match. The identity, by source:
  - **`sms` watches:** the SMS provider's own `_id` of the newest message, read through the existing `READ_SMS` path. No new permission.
  - **`notification` watches:** `key` + a local SHA-256 of the notification's title and text, truncated to 16 hex. It never leaves the phone and is stored only as that hash. An update with new text is a new event; a repeated callback with the same text is not.
  - The wire is unchanged: the server still gets only `{watchId, matchedAt, nonce}`.
  - The dedupe store and the pending queue are keyed by `(watchId, eventId)`.
  - Tests:
    - Two different SMS updating one notification key both fire.
    - The same SMS delivered by two callbacks fires once.
    - A notification whose text changes fires again; the same text re-posted does not.
- **J4, pending queue states.** Each `(watchId, key)` is in exactly one state: **new** → **pending** (queued, not handled) → **handled** (after a 2xx).
  - Insert is keyed by `(watchId, key)`, so a repeat match while pending updates nothing and adds no copy. A handled pair is never re-queued.
  - Queuing never marks a pair handled.
  - **At capacity (20):** first drop entries whose `matchedAt` is older than 10 minutes. If the queue is still full, drop the entry with the **smallest `matchedAt`**, the one closest to its freshness deadline, with ties broken by `(watchId, key)`. Order is always by `matchedAt`, never by insertion order. This is deterministic and bounded.
  - The queue lives in `SharedPreferences`, so it survives restarts.
  - Tests: duplicate insert while pending; restart keeps the queue; retry success marks handled and removes the entry; retry failure keeps it; capacity drops stale entries, then the smallest `matchedAt`; events inserted out of `matchedAt` order evict the right one.
- **J3, canonical host.** The guard works on `new URL(u).hostname`, which the WHATWG parser lowercases and turns into punycode (IDNA). Before any check, one trailing root dot is stripped. A host still ending in `.` after that (an empty label) is refused.
  - Table tests: `example.internal.`, `EXAMPLE.INTERNAL`, `localhost.`, an IDN host that maps to `xn--…` (checked on the punycode form), `0x7f.0.0.1`, `[::ffff:127.0.0.1]`, `user@host`, `:8443`.
- **J6: the one authoritative order, at-most-once.**
  1. Engine initialized (`onInit` = `SUCCESS`).
  2. `he-IL` is available (`isLanguageAvailable` ≥ `LANG_AVAILABLE`).
  3. Persist the id (`commit()`).
  4. Call `speak()`.
  - If 1 or 2 fails, the id is **not** marked and nothing is spoken. The settings screen shows "no Hebrew voice" when that is the cause.
  - If the process dies between 3 and 4, or `speak()` returns `ERROR`, that reply is not spoken and is not retried. It is still on screen; speech is a convenience, not a delivery channel. A code comment states this.
  - A pure-function test covers each branch.

Each point was weighed against the code. Only what adds correctness or security without new cost or scope is kept.

### J1
- The key lives for one turn only, and only retry outcomes (validation and access failures) are recorded. A successful read is not a retry. So "same call after the state changed" cannot match.
- Regression test: a read, then the same read in a later step, is not flagged.

### J2a
- **Conservative inheritance.** Inherit only when all three hold:
  - the message names no group;
  - it is short (≤ 6 words);
  - the previous turn **ran a tool**. This covers follow-ups like "ומחר?" and "תבטל אותה".
  - Anything else gets the full catalog, as today.
- **Fallback with no new model call:** if the inherited turn runs no tool, the existing parser fallback runs with its own catalog, as for any turn with no tool today.
- **No new capability:** inherited groups are intersected with the current turn's `agentToolNames` output (flags, grants, channel, read-only). They can only narrow what is offered, never add.

### J2a, follow-up: how "the previous turn ran a tool" is known
- **Checked at HEAD:** the inbound row's `intent` cannot serve here. For every agent turn it is the constant `'agent'` (`pipeline.ts:947,962,966`), not a tool name.
- **The source is `AgentResult.tools`** (`loop.ts:253-279`). It lists the tools that went through the orchestrator in the turn, reads included, and it is on both the `reply` and the `failed` kinds.
  - Its meaning is: the orchestrator handled the call (executed, read, or answered with a confirm card or question).
  - A validation retry never enters it, because the retry branch returns before `loop.ran` is set (`loop.ts:857-860` vs `878,889`).
  - A pending confirmation counts. The user is in that topic, which is exactly the signal wanted.
- `last_selection` gets a `ran INTEGER NOT NULL DEFAULT 0` column.
- `settleAgentResult` (`pipeline.ts:~940`), for `reply` and `failed` results with a non-empty `tools`, does one synchronous `UPDATE last_selection SET ran = 1 WHERE principal = ? AND conversation = ? AND seq = ?`. The `seq` comes from `inboundSeq(wamid)`.
  - `seq =` (not `>=`) means only the turn that wrote the selection can mark it. An older turn finds no row with its `seq`.
  - A suspended turn is marked when it settles on resume (the resume paths call the same function with the original `wamid`).
  - The read-only second try (`secondTry`) does not mark.
- **Inherit only if** `ran = 1` **and** every tool in `tools` belongs to the stored groups. That check runs in the same UPDATE: `ran` is set only when they belong. This excludes:
  - a turn whose tools fell outside the selection;
  - a turn that ran nothing;
  - parser-only turns (no `AgentResult.tools`).
- **"An irrelevant tool executes."** Inheritance only removes tools from what the full catalog would offer; it never adds one. Any wrong tool the model could pick under inheritance, it could already pick under today's full catalog. Every write still goes through tier and policy, and `confirm/`. The new failure mode is only "the needed tool is missing". The model then answers in text, and the existing parser fallback runs, because no tool ran (`pipeline.ts`, `settleAgentResult` returns null when `!toolRan`).
- **Regression tests** (pipeline, fake provider):
  - A calendar read, then an unrelated short message with no group hit: groups inherited, the fake model calls no tool, and the parser fallback runs.
  - The same message after a turn that ran no tool: full catalog.
  - The older suspended turn settling after a newer one: the newer row is untouched.
  - A parser-chosen tool outside the selection: no inheritance next time.

### J2b
- Slot schemas are unchanged, so required parameters and enums still reach the model.
- Each brief keeps the tool's key restriction (for example "past and future", "Tier 2, confirms"). Briefs are written by hand per tool.
- Sizes are measured with `scripts/bench-tokens.ts` on the serialized request, and checked by the full Groq eval run. The estimate alone is not enough.

### J3: URL guard, all in one pure function with a table test
- Parse with WHATWG `URL`. Reject:
  - credentials (`user:pass@`);
  - any port other than 443;
  - IPv4 in any form (`URL` normalizes decimal, hex and octal to dotted form);
  - any IPv6 literal, including IPv4-mapped;
  - `localhost`, `*.localhost`, `.local`, `.internal`, `.home.arpa`;
  - single-label hosts.
- **DNS rebinding:** a Worker's `fetch` leaves from Cloudflare's network and cannot reach the user's LAN. With IP literals refused, a rebinding host can only point at public addresses. This residual is accepted and noted in PLAN.
- Every redirect (at most 2) is re-checked by the same function. The size cap is enforced on the stream, never from `Content-Length`.
- The page text is untrusted:
  - scrubbed and capped;
  - the turn is tainted, so any write confirms;
  - the model's summary is display-only.
  - An eval case puts an injection inside the page.
- Fetch and extractor are injected, so tests are deterministic.

### J4
- **Keywords:** all keywords must appear (AND), matched on whole normalized words. The tool description states it, and tests pin it.
- **Phone dedupe:** one fire per notification `key` (Android's `StatusBarNotification.getKey()`) per watch. An updated notification with the same key never fires again.
  - The last 100 `(watchId, key)` pairs are stored in `SharedPreferences`, the app's existing persistent store (`NotificationBuffer.kt`, `PushToken.kt` use it). They survive process death and restarts.
  - Keys and ids only: no content is stored, and nothing leaves the phone.
- **Eviction, an accepted limit, documented in PLAN §6.29:**
  - A pair is evicted only after 100 newer matching notifications. A one-fire watch (the default) is spent on the server after its fire, so a re-post cannot fire it again.
  - For a `repeat` watch (≤ 5 fires), a re-fire after eviction is still bounded by the server's 1-hour cooldown and `fires_left`.
  - A test pins this: the 101st key evicts the oldest, and a spent watch's re-fire claims nothing.
- **Time bounds:** the server refuses `matchedAt` older than 10 minutes or more than 2 minutes in the future, and logs `watch_stale` / `watch_future`.
- **Replays and retries:**
  - the ingress nonce is spent in the same transaction as the device check (invariant 9);
  - the claim checks owner (`principal`), status, expiry, `fires_left` and cooldown atomically;
  - a second identical post claims nothing. Tests cover a replayed nonce and a fire for another principal's watch.
- **Gmail:** `after:` takes epoch seconds, which Gmail honors.
  - The overlap is reduced from 1 hour to **15 minutes**, which is enough for Gmail's indexing delay.
  - The list asks for at most 50 results, one page, no pagination.
  - **Firing is decided per tick, not per mail:** a tick that finds any id not in the seen set makes **one** claim attempt for the watch, whatever the count.
  - Effect on an evicted id: more than 50 matching mails inside 15 minutes is unrealistic for a keyword watch. Even then, a re-seen id costs at most one more claim, which `fires_left` and the 1-hour cooldown bound. A one-fire watch is already spent.
  - Documented as best-effort dedupe in PLAN §6.29. A test pins the built query and the "one claim per tick" rule.
- **SMS:** the dependence on the SMS app posting a notification is a known limit. It is written in PLAN §6.29 and the tool description. No receiver and no permission are added.
- **Free-tier limits:** a Gmail 429 or error skips that watch until the next tick, with no retry storm.

### J5
- Settings are per principal.
- Each section is built in its own try/catch, so one failing section never drops the others.
- Tomorrow's window comes from `src/time/range.ts` in `Asia/Jerusalem`. The overlap test includes the 2026-10-25 fall-back night.

### J6
- **Spoken once:** the app keeps the last 50 spoken message ids in `SharedPreferences`, the store it already uses (`ChatStore.kt`, `PushToken.kt`). They are written with `commit()` before `speak()`, in the order of "J6: the one authoritative order" above.
  - The check and the mark run together on the main thread. Lifecycle callbacks and adapter refreshes are all main-thread, so they cannot interleave.
  - Refresh, rotation, process death or restart never speaks a reply again.
  - A pure-function test covers the guard: mark, re-check, and the 51st id evicts the oldest.
- **Lifecycle:** `TextToSpeech` is created when it is first needed and shut down in `onDestroy`.
- **No Hebrew voice:** if `he-IL` is not available, nothing is spoken and the settings screen says why. The toggle stays off by default.

### J7
- **Normalization:** case-fold, collapse whitespace, and strip only surrounding quotes and a trailing period. Inner punctuation and digits are kept, so `1.5` and `15` stay different. A test pins this.
- **Concurrency, said honestly:** duplicate prevention is **best effort**. Two requests saving the same fact at the same moment can both insert. An atomic guard would need a keyed hash column and a unique index: a migration plus a new stored derivative of private text. That is not worth it for a rare duplicate.
- The code comment, the PLAN §6.26 line and the test names all say "best effort". No test asserts that duplicates are impossible. One test documents the accepted race: two adds interleaved both insert.
- The user-facing "already remembered" text appears only when a duplicate was actually found. It promises nothing beyond that.

### Everywhere
- Re-check the migration number right before creating each migration.
- Every free-tier limit degrades to a code-rendered reply or a skipped tick, never a paid fallback.

## Caught in review (round 3)

- **[consistency] J2a:** the selection is made inside the loop, not the pipeline. Now an `onLocalSelection` callback in `AgentDeps`. The taint rule is scoped to the starting taint, with the reason stated. The leftover "existing retention" sentence is removed.
- **[data] J4:** the watch text is stored in plain text, like reminders, since a fire copies it there. Decrypt-first is no longer needed.

## Caught in review (round 2)

- **[data] J2a:** no retention existed for the new table. Now `purgeExpired()` runs in `alarm()`.
- **[data] J4:** a new watch looked back an hour before it was created. Now `after:max(created_at, last_checked − 1h)`.
- **[data] J7:** a duplicate reply must not carry an Undo, or Undo would delete the original fact.
- **[concurrency] J7:** "the agent lock serializes" was false, because answers and buttons run without the lock. Now a count re-check, with an honest comment.
- **[concurrency] J2a:** a late resume could overwrite a newer selection. Now an upsert ordered by `seq`, written at plan time instead of settle time, so the suspend, failed and resume paths are not touched.
- **[consistency] J3:** the pipeline cannot see that a URL came from shared text. A forwarded turn is never smart (`pipeline.ts:586`), so the rule holds by construction.
- **[consistency] J4:** a direct outbox insert bypassed `canDeliver` and the rest hold, and production has no outbox. Now a fire schedules a due-now reminder, and the flag is app-channel only.
- **[blast-radius] J4:** the mail check runs before the digest, in its own try/catch. The FCM `watches` sender and the Kotlin branch are now listed.
