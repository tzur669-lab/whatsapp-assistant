# Block H — a smarter, more useful bot

## Context

The user reports three failures in daily use:
1. **Notes vanish.** Asking to "save my stock list" goes to `notes.save`, and asking for it
   later fails. `notes.find` matches `query_variants` by substring (`src/tools/match.ts:38`).
   A note "AAPL 10, MSFT 5" contains neither "מניות" nor "פתקים", so both "show my stock
   list" and "show my notes" answer "לא מצאתי פתק". The model never sees notes (private by
   design), so it cannot help. Only the 10 newest notes are ever shown.
2. **No stocks.** There is no quote source, and the model is told never to calculate.
3. **It often misunderstands.** One 27B free-tier model, a short prompt (a9), a generic
   "לא הבנתי", no memory of the user beyond 6 exchanges, and no way to learn from real
   misses.

**User decisions (2026-10-06/07):**
- US and TASE quotes, with a free API key (the human sets the secret).
- Lists in the bot (private), not in Google Tasks.
- Capture "לא הבנת", keep a lasting facts memory the model sees, and evaluate stronger Groq
  models.
- Review round 3: adopt B1–B3, M3, H1–H6 and the MEDIUM items.
- Review round 4: adopt N1–N3, H1–H6 and M1–M12.
- Review round 5: adopt T1–T4, I1 and I2.

**Constraints kept:** $0, Groq only, invariants 1–13. Facts are an explicit amendment to
invariant 2 (PLAN §7, §14, CLAUDE.md).

## Parts (build order = numbering), one commit and push each

| Part | Content | Migration |
|---|---|---|
| 15 | Notes that can be found | — |
| 16 | "לא הבנת" capture | 0022 |
| 17 | Tool selection + token fit, then named lists | 0023 |
| 18 | Facts, fallback | 0024 |
| 19 | Stock portfolio (after the spike) | 0025 |
| — | Model evaluation (uses real misses from 16) | — |

**Dependencies:**
- 16 is independent.
- 17 always starts with the union selection and the budget fitter, before the list tools
  (I1).
- 18 adds facts as one more input the fitter can drop.
- 19 relies on 17's selection and fitter.
- The model evaluation needs 16.
- Scheduled-portfolio code ships in the same commit as migration 0025.

## Cross-cutting rules
- **Migrations:** additive only, and each one registered in `src/platform/migrations.ts`. A
  migration that has been deployed is never edited.
- **Draft schemas:** every new tool's draft schema goes in `src/nlu/slot-schemas.ts`.
  - `pnpm eval` runs in every part.
  - New tools are agent-only, so `PARSER_TOOL_NAMES` does not change.
- **Token gate (N3):** every part that adds tools runs `scripts/bench-tokens.ts`. The worst
  corpus case must be ≤ 6,000 tokens.
- **Synchronous execute:** `resolveAsync` only validates. Caps, existence and versions are
  re-read inside `execute`, in one synchronous DO transaction, so no await sits between a
  check and its write.
- **Versioned Undo:**
  - Mutable rows carry a `version`. The compensation stores `{ids, expectedVersions,
    previous state}`.
  - **One Undo is one transaction (H4).** If any touched row changed, the whole Undo is
    refused with "השתנה מאז — לא ביטלתי". This matches the all-or-nothing caps.
  - Versions are checked for every touched row. The list row's version is checked only when
    the action deleted that list.
  - Undoing an add that created a list removes only its own items. It removes the list only
    when no other active items remain.
  - A restore that would collide with an active duplicate (the same folded item text in the
    list, the same list `name_key`, or the same symbol and market) is refused cleanly. A
    unique-index violation is caught as a refusal, never as an escaping SQL error.
  - A restore re-checks the cap and refuses when the store is full.
- **Soft-deletes:**
  - A removed row gets `removed_at` and is restored by id, so `compensating_json` never
    carries text.
  - Every store read filters `removed_at IS NULL`.
  - Caps count active rows only.
  - Uniqueness uses partial indexes `WHERE removed_at IS NULL`.
  - Soft-deleted rows are purged once the Undo window has passed.
- **Sweeps:** expired `last_exchange`, `misses` and `quote_cache` rows, and soft-deleted rows
  ready to purge, are deleted on read and in the existing daily cron. A read also checks
  `expires_at` itself.
- **Caps are all-or-nothing:** an add that would cross a cap is refused whole.
- **Prompt text goes into tool descriptions first.** The system prompt gets at most one line
  per part.
  - A prompt change bumps the version.
  - The eval fingerprint (`test/evals/fingerprint.ts:42-49`) changes with it, so `--resume`
    never carries across parts.
- **Least-privilege deps (M3):** the agent gets only the stores its tools need. It never
  gets `last_exchange` or `misses`; a test checks that the prompt builder cannot reach them.

### Part 15 — Notes that can be found
- In `notes.find`, code strips generic words (פתק/פתקים/הערה/הערות/שלי/כל/את/notes/my/all).
  If nothing remains, it lists all notes. If nothing matches, it shows the latest notes
  under "לא מצאתי התאמה — הנה האחרונים".
- `LIST_LIMIT` goes up to 15, followed by "ועוד N — אפשר לחפש לפי מילה".
- Rules fallback (`src/nlu/rules-fallback.ts`): "מה הפתקים שלי" as a whole-message match,
  after stripping punctuation (M7).
  - **Check first** that the rules provider can emit agent-only intents through the parser
    path (`src/nlu/json-schema.ts:169` pins the response schema to `PARSER_TOOL_NAMES`).
  - If it cannot, these fallback rules are dropped from every part, with a §13 note.
- Evals:
  - `nx-find-003`: "מה הפתקים שלי".
  - `nx-find-004`: "תראה לי את רשימת המניות", where the note does not contain those words.

### Part 16 — Capturing "לא הבנת" (migration 0022)
- **`last_exchange(principal, conversation, seq, ciphertext, expires_at)`**, with
  `PRIMARY KEY (principal, conversation)`, the conflict target for the upsert.
- **Ordering key (N1, T1):** `seq` comes from a durable counter in `settings`
  (`migrations/0001_init.sql:4`, key `inbound_seq`).
  - It is incremented together with the `recordInbound` insert (`src/core/repo.ts:112`),
    inside `repo.transaction` (`repo.ts:78`, which is `storage.transactionSync` per
    `src/core/sql.ts:20`), and only when the insert succeeds. So a duplicate consumes no
    number, and two messages can never share one.
  - It never resets. The rowid can't be used: `inbound_messages` is pruned
    (`repo.ts:156`), so its rowid can restart at 1.
  - One global counter orders correctly within every `(principal, conversation)` key.
  - The write is one synchronous
    `INSERT … ON CONFLICT DO UPDATE … WHERE excluded.seq > seq OR expires_at <= :now`, so an
    expired row that hasn't been swept never blocks a new write.
  - The suspended phone-read turn keeps its original `seq` inside the encrypted state of
    `agent_turns` (`migrations/0013_phone_reads.sql:14`), so no migration is needed. A turn
    suspended before the deploy has no `seq`, and its resume skips the write.
    `resumeFromPhone`
    (`src/core/pipeline.ts:625`, `:715`) writes with it. An old turn that resumes late never
    overwrites a newer exchange.
  - A duplicate message never reaches the pipeline, because `recordInbound` dedupes it.
- **Who writes (N2):** only turns that reached a model, meaning the agent, the parser, or
  the read-only try.
  - Typed confirmations, buttons, open-question answers and commands never write.
  - The `agentBusy` reply (`src/core/pipeline.ts:566-569`) makes no model call, so it never
    writes either (T1). The running turn writes its own row, with its earlier `seq`, when it
    finishes.
  - So "לא הבנת" after a confirmation still captures the original request together with the
    bot's question.
- **Contents:** the user text, the reply, the outcome code, the matched groups and the tools
  called. Everything is encrypted with AES-GCM (`src/security/crypto.ts`) and kept 1 hour.
  - Private turns and voice notes store a placeholder (invariant 13).
  - If encryption fails, the write is skipped and only a code is logged (M4).
  - Known exposure, recorded in §14: a failed turn has no `private` stamp yet, so its row
    may hold the text of a note. It is encrypted, and only the user's own "לא הבנת" copies
    it.
- **Wiping:** `/forget` and `/pair off` (`pipeline.ts:1116-1119`, `:950`) delete it.
- **The command** is a `Command` in `matchCommand` (`src/core/router.ts:44-55`).
  - **Trigger:** the whole message is "לא הבנת", "לא הבנת אותי" or "/missed", after
    stripping punctuation and spaces.
  - **Placement:** it runs at step 1 (`pipeline.ts:420`), before confirmations and open
    questions. Forwarded or shared text skips it (`:418`).
  - **What it does:** copies the row into `misses(id, principal, ciphertext, created_at)` —
    encrypted, kept 30 days, at most 50, never logged, never sent to a model.
  - **Replies:**
    - Saved: "שמרתי: '<first ~40 characters of the captured request>'. אפשר לנסח שוב." The
      reply is `private: true` (I2). The user sees at once whether the right exchange was
      captured: a button flow from a pushed reminder, a placeholder, or a chain of
      confirmations.
    - The agent lock is held: "התשובה הקודמת עוד בדרך — אפשר לשלוח שוב אחריה".
    - No row, an expired row, or a decryption failure (that row is deleted): "אין הודעה
      אחרונה לשמור" (M4).
- **`/misses`** shows the latest 10 as numbered text, each with its outcome code and tools.
  The reply is `private: true`.
- **`scripts/misses-to-evals.ts`** writes to `evals-private/`, which is gitignored.
  - It warns that the text may contain notes or someone else's words.
  - A human rewrites each case with fake values before it goes into a committed corpus.

### Part 17 — Tool selection and token fit, then named lists (private; migration 0023)

**Part 17 is one commit.** Inside it, the tool selection and the budget fitter are built, and
their gates pass, before any list tool is added (I1).
- **Selection:**
  - 2–3 matched groups → their union. 0 or 4+ matched groups → the full catalog.
  - If the "≤ half offered" rule (`src/agent/tool-groups.ts:157`) fires for **any** group in
    the union, the whole selection becomes the full catalog (M5).
  - `Selection.group` becomes `groups[]`, and its readers change with it
    (`src/agent/loop.ts:200`, `scripts/bench-tokens.ts:58-63`).
- **Gate:** a zero-token test over the whole eval corpus. Every tool a case expects must be
  in the offered set, in 100% of cases.
- **Budget fitter:**
  - It runs once per turn, before the estimate and the reservation
    (`src/agent/loop.ts:215-222`). Nothing changes between the turn's calls, and
    `TURN_SHAPE_FAILURES` is unchanged.
  - Over the budget, it drops the oldest history. It **never drops the last exchange**
    (M6).
  - Part 18 adds facts as the next thing it can drop.
  - The 6,000-token gate is confirmed against real `promptTokens` from one run, recorded in
    `test/fixtures/token-calibration.json`. This closes the §13 item.

**Then the lists:**
- **Tables:**
  - `lists(id, principal, name, name_key TEXT NOT NULL CHECK (name_key <> ''), version,
    removed_at, created_at)`.
    - `name_key` = fold(strip generic words(name)) (T4).
    - `CREATE UNIQUE INDEX … ON lists(principal, name_key) WHERE removed_at IS NULL`.
    - So "רשימת קניות" and "קניות" are the same list. Creating a list whose key already
      exists uses that list. An empty key ("רשימה") → CLARIFY "איך לקרוא לרשימה?".
    - Keys are compared both with and without one leading ה ("הקניות" = "קניות"). No other
      prefix is stripped.
  - `list_items(id, list_id, text, item_key TEXT NOT NULL CHECK (item_key <> ''), position,
    version, removed_at, created_at)`.
    - `item_key` is the folded text, made with the same function that matches items.
    - `CREATE UNIQUE INDEX … ON list_items(list_id, item_key) WHERE removed_at IS NULL`:
      a list has no duplicate active items.
    - `lists.add` **skips** an item that is already active on the list and reports it
      ("חלב כבר ברשימה"). Skipping is not a cap failure.
    - The same index enforces the rule that a restore refuses on a collision.
  - Every mutable table declares `version INTEGER NOT NULL DEFAULT 0` and a nullable
    `removed_at INTEGER`.
- **Caps:** 30 lists, 100 items per list, 200 characters per item, 40 per name.
- **Store:** `src/tools/list-store.ts`, following the pattern of `note-store.ts`.
- **Matching (H2):**
  - Variants are reduced to keys with the same function as `name_key`.
  - An exact key match wins over a substring match. Only when there is no exact match does
    `matchByText` apply, over the keys.
  - Items use the same rule, so "חלב" picks "חלב" over "חלב סויה".

| Tool | Tier | What it does |
|---|---|---|
| `lists.add` | 1 + Undo | Finds the list. If none matches, creates one, and the reply always says "יצרתי רשימה חדשה: X". When other lists exist, it adds "התכוונת ל-…?" listing them, up to 5 (H3). No list named and exactly one list → that list; otherwise CLARIFY with the list names. |
| `lists.show` | 0, terminal | One list, or all lists with their counts. No list named and exactly one list → that list. |
| `lists.remove` | 1 + Undo | Removes the matched items. Several matches → a numbered choice. |
| `lists.delete` | 2 | Soft-deletes the list and its items with the same `removed_at`. The count is rendered at execute time. Undo restores only the rows with that `removed_at`, and refuses when an active list now has the same name. |

- **Routing, in the tool descriptions:**
  - a named list (shopping, stocks, ideas) → `lists.*`;
  - Google Tasks → only when the user says "משימות" or "Tasks".
  - The `tasks.add` description and the prompt sentence "a list item is a task" change to
    match. `pnpm eval` covers the shared parser description.
- **Also changes:** `GROUPS.records`, `/help`, and the rules fallback for "מה הרשימות שלי"
  (whole message only).
- **Docs:** your existing shopping list in Google Tasks stays there. Say this once in
  ROADMAP, HANDOFF and the summary.
- **Evals (`li-`):**
  - add creating a list;
  - add to an existing list;
  - add with no list named;
  - show one list, and show all lists;
  - remove;
  - delete;
  - a shopping-list request that used to go to Tasks;
  - "קניות" when both "קניות" and "קניות לבית" exist (exact match wins).

### Part 18 — Facts and the fallback (migration 0024)
- **Storage:** `facts(id, principal, ciphertext, version, removed_at, created_at)`. At most 25
  facts and 800 characters in total.
- **`memory.remember`** (Tier 1 + Undo):
  - Runs **only on an explicit signal**: "תזכור עליי", "על עצמי", "תזכור לתמיד", or
    `/remember`. Plain "תזכור ש…" stays a note (`src/agent/tool-groups.ts:100`).
  - The reply names where the text was saved: "נשמר כעובדה עליך" or "נשמר כפתק".
  - It is refused in a tainted turn.
  - Validation rejects emails, phone numbers, links and runs of 6 or more digits. These are
    named detectors exported from `src/security/scrub.ts:18-26`.
- **`memory.forget`** (Tier 2) finds the fact by `query_variants`.
- **`/memory`** lists the facts and ends with "יש גם N פתקים" (M2). It is private.
- **Note hint (M2):** from this part on, when a saved note starts with אני or שאני, the
  reply to `notes.save` adds "אם זה משהו עליך שכדאי שאזכור תמיד — 'תזכור עליי ש…'".
- **`/forget memory`** clears the facts. `/pair off` keeps them.
- **In the prompt:** facts go into the user turn as "About the user:". They are neither
  private nor tainting.
- **The fitter:** Part 17's fitter gains facts as the second thing to drop, after the oldest
  history. The last exchange is still never dropped. The token gate runs again.
- **Fallback:** when nothing ran, the "לא הבנתי" reply adds 2–3 static example phrasings
  for the matched group.
- **Evals (`mem-`):**
  - "תזכור עליי…" saves a fact.
  - "תזכור ש…" saves a note.
  - Weather with a city known from a saved fact.
  - A tainted turn refuses to save a fact.

### Part 19 — Stock portfolio (migration 0025, after the spike)
- **Spike (blocking): `scripts/probe-quotes.ts` under `wrangler dev`.**
  - **It passes only if:**
    - US quotes work with the key in a header;
    - **batch** quotes work;
    - TASE works, possibly from a second source.
  - **It also records:**
    - the response's currency codes (ILA, ILS, USD);
    - a dual-listed symbol (TEVA) showing both listings, through a listings or search
      endpoint;
    - prev-close and market-status fields;
    - the rate-limit shape (HTTP 429, or 200 with an error body), with a fixture;
    - credits used per batch;
    - the Workers Free per-call limit on outbound requests.
  - The results go in PLAN §6.24.
  - **No free TASE source passes → ship US-only.** The `market` enum keeps `tase`.
- **Secret: `QUOTES_API_KEY`.**
  - Add it to `src/core/env.ts`, `SETUP.md`, and an `ops/` note.
  - Update the "no keys" header in `src/lookup/http.ts`.
  - The key goes in a header only. A failure logs only a code, never the URL.
  - The human runs `wrangler secret put`.
- **`src/lookup/quotes.ts`, a `QuoteSource` per market:**
  - Signature: `quote(symbols[], market) → QuoteResult[]`. Portfolio code sees only
    `QuoteResult`.
  - Results: `ok{priceMinor, prevCloseMinor | null, currency, asOf, marketOpen}`,
    `stale{…}`, `unavailable`, `error`.
  - **Units come from the response's currency code, normalized exactly once (H1, T3).**
    The source adapter converts before the cache: USD → cents (currency `USD`); ILS → ×100
    and ILA → as is (both currency `ILS`, in agorot).
    - From that point on, the cache, the holdings and the renderer only ever see
      `{USD, ILS}` in minor units. ILA never leaves the adapter.
    - The adapter turns any of these into `error`: an unknown currency code, a price ≤ 0, or
      a returned symbol different from the one requested.
    - **The portfolio layer** (not the adapter, which never sees a holding) compares the
      normalized currency with `holding.currency`. A mismatch is `error` for that holding
      only.
    - `holding.currency` is set when the holding is created, from the first validated
      quote's normalized currency, never from a guess about the market.
  - **Other cases:**
    - A batch that omits a symbol → that symbol is `unavailable`.
    - Duplicates → the first one is kept.
    - A malformed response → `error`, via Zod.
  - Calls go through a closure `fetch`. Only symbols that are not fresh are fetched, in one
    batch.
  - `quote_cache` has `PRIMARY KEY (symbol, market)`.
  - **Canonical symbol:** `portfolio.update` validates a symbol **once**.
    - A provider lookup returns the canonical `(symbol, exchange, name)`. It accepts a TASE
      security number or a provider's own spelling ("BRK.B" / "BRK-B").
    - The canonical symbol is what gets stored.
    - At creation, the check is against the lookup's canonical result. Every later quote
      request uses the stored canonical symbol, so the strict check "returned symbol =
      requested symbol" (after upper-casing) stays exact.
- **Cache (H6):**
  - Market hours come from the source's market-status field when it has one. Otherwise
    they are computed in the exchange's own zone (`America/New_York`, `Asia/Jerusalem`)
    with the existing tz helpers.
  - While the market is open, quotes keep 5 minutes. While it is closed, at most 2 hours.
  - On a rate limit or error, the stale quote is served with its `asOf`.
- **Units, quantity and exchange rate:**
  - All money is in integer minor units.
  - Quantity is `quantity_milli`, capped at 10 million shares.
  - The exchange rate comes from a new numeric export in `src/lookup/rates.ts`, built on
    `ratesOf`: `usdIls(fetch) → {rate, date} | null`. Today `ratesFor` returns only text
    (`rates.ts:43-48`).
- **`holdings` table**, with explicit `CHECK`s as in `migrations/0019_notes_expenses.sql:22`:
  - `market TEXT NOT NULL CHECK (market IN ('us','tase'))`
  - `quantity_milli INTEGER NOT NULL CHECK (quantity_milli > 0 AND quantity_milli <= 10000000000)`
  - `buy_price_minor INTEGER CHECK (buy_price_minor > 0)` (NULL is allowed)
  - `currency TEXT NOT NULL CHECK (currency IN ('USD','ILS'))`
  - plus `id, principal, symbol, version, removed_at, added_at`.
  - A partial unique index (`CREATE UNIQUE INDEX … WHERE removed_at IS NULL`) on
    `(principal, symbol, market)`.
  - At most 20 holdings (enforced in code).
- **`portfolio.update`** (Tier 1 + Undo, private):
  - Input: `{op: 'set'|'add'|'reduce', symbol, market?, quantity, buy_price?,
    buy_price_unit?: 'shekel'|'agorot'}`.
  - The model fills `op` from the words (T2):
    - `set` for "יש לי";
    - `add` for "קניתי", "תוסיף", "עוד";
    - `reduce` for "מכרתי".
  - Code applies these rules, in integer math, rounding once:

| op | Quantity | Buy price |
|---|---|---|
| `add` with a price, and a price is stored (or it is a new holding) | quantity grows | weighted average: `(q1·p1 + q2·p2)/(q1+q2)` |
| `add` with no price, and the holding has one | — | CLARIFY "באיזה מחיר קנית?". Never guessed. |
| `add` with a price, and none stored (one price per holding cannot hold a mixed basis) | — | CLARIFY "באיזה מחיר קנית את N הקודמות? (או 'לא ידוע')". Given a price → weighted average. "לא ידוע" → quantity grows, price stays null, and the reply says P/L can't be computed. |
| `add` with no price, and none stored | quantity grows | stays null |
| `reduce` | quantity drops | average unchanged. A sale price ("מכרתי 3 ב-200") is ignored, and the reply claims no realized P/L. |
| `set` with a price | absolute | the price replaces the whole basis, because the user stated it |
| `set` without a price, existing holding | absolute | the difference follows the `add` rules (an increase) or the `reduce` rules (a decrease), so an increase with a stored price → CLARIFY |
| `set` without a price, new holding | creates it | null |

  - Reaching 0 removes the holding, whether by `reduce` to 0 or by `set` 0. Reducing below 0
    is CLARIFY.
  - A new holding with `reduce` is CLARIFY.
  - `buy_price_unit` is filled only from the words (₪ / שקל / אגורות / אג׳). **There is no
    default.** A TASE buy price with no unit word → CLARIFY "N שקל או N אגורות?"
    (invariant 12). US prices are always dollars. The confirmation still shows the buy
    price in ₪ and the P/L %.
  - **The market is decided in this order (H5):**
    1. Market words in the user's text, matched by a code regex: בארה״ב/ניו יורק/נאסד״ק/NYSE
       → `us`; בת״א/בורסה בתל אביב/TASE → `tase`.
       - These always win, and the model's `market` is then ignored.
       - Only when the text names **both** markets → CLARIFY.
    2. The text names no market → the model's `market`.
    3. Still none, and the company is listed in both markets → CLARIFY with "ארה״ב ($)" or
       "ת״א (₪)". Listings come from the source, plus a small static table of dual
       listings.
  - A TASE security may be given by its numeric security number.
  - An unknown symbol → CLARIFY. The source is down → "לא הצלחתי לאמת — אפשר לנסות שוב בעוד
    דקה".
  - **The confirmation** shows the company name, the ticker, the market, the currency and
    the current price.
  - The symbol from the model is the one deliberate exception to "code finds targets"; code
    verifies it. The company name is someone else's text inside a private reply: it never
    reaches the model and does not taint (§14).
  - The buy price is in the holding's own currency.
- **`portfolio.show`** (Tier 0, terminal, private):
  - **Each holding** shows the price, the daily change, the value and the P/L.
    - The daily change carries the quote's own date. When the market is closed it shows
      "סגירה אחרונה (date)". With no previous close it shows "—".
    - P/L is in the holding's currency, with its percentage from the average buy price. It
      is labelled "רווח/הפסד בדולרים (לא כולל שינוי שער)" for US holdings (M12) and
      "רווח/הפסד בשקלים" for TASE. With no buy price it shows "—".
    - A stale or unavailable quote is labelled on its own line.
  - **The ₪ total** is the sum of the rounded per-holding ₪ values, labelled
    "לפי השער היציג מ-…".
  - **Total P/L** is shown per currency, counting only holdings that have a buy price,
    labelled "(N מתוך M)".
  - **Anything missing** labels the total "חלקי — N מתוך M".
  - **No holdings:** explain how to add one, and note that an old stock note can still be
    found with "מה הפתקים שלי".
- **Scheduled portfolio:**
  - Add `portfolio` to `SCHEDULED_TOPICS` (`src/nlu/slot-schemas.ts:368`).
  - A dedicated branch in `src/core/scheduled-read.ts` skips `runLookup` and uses the same
    renderer as `portfolio.show`, so partial and unavailable states are visible.
  - With no holdings, it sends one line: "התיק ריק — אפשר לבטל את השליחה היומית" (M9).
  - `private` is passed through `outbox.accept` (`src/platform/assistant-do.ts:1517-1523`).
    The outbox already carries it (`src/channels/app/outbox.ts:95, 118, 315`).
  - A `scheduledLabel` entry goes in `src/render/reminders.ts:83`.
  - **Rollback safety (M8):** a test checks that an unknown topic is marked failed once and
    not retried on every alarm.
- **Group patterns:** `word('מניה|מניות|מניית|המניות')`, `/תיק השקעות/`, `/תיק המניות/`,
  `/\b(stocks?|shares?|portfolio|ticker)\b/i`.
- **Rules fallback:** "מה שווי התיק" as a whole-message match.
- **Evals (`pf-`):**
  - add with a buy price;
  - add by Hebrew name (אפל, נבידיה);
  - "טבע" → CLARIFY;
  - "טבע בת״א" → no CLARIFY;
  - a TASE security by its number;
  - "קניתי עוד 5 אפל ב-180": `add` with a weighted average;
  - "קניתי עוד 5 אפל" when a price is stored → CLARIFY;
  - "מכרתי 3 אפל": `reduce`;
  - "יש לי 20 אפל": `set`;
  - "טבע ב-6000 אגורות": `buy_price_unit`;
  - "טבע ב-6000" → CLARIFY about the unit;
  - "קניתי עוד 5 אפל ב-180" when no price is stored → CLARIFY about the old price;
  - "אפל בת״א בארה״ב" → CLARIFY. "טבע בת״א" with the model saying `us` → `tase`;
  - show;
  - remove with quantity 0;
  - schedule.

### Model evaluation (PLAN §13, "More Groq backups")
1. The human lists the free models and their limits in the Groq console.
2. Each candidate runs `pnpm eval:agent --model <id> --select-tools`, resumable. The corpus
   includes the rewritten misses.
3. A candidate that passes the §11.2 gates and beats qwen gets a one-week trial as
   primary.
4. The trial tracks:
   - misses per 100 turns;
   - Undo within 2 minutes of a write, the signal for silent mistakes (M10);
   - the clarification rate;
   - 429s and fallbacks.
   With one user, the trial is a **veto**, not the decision.
5. Then a reviewed commit updates `src/agent/models.ts`, after the human reads the report.

## Docs (in the same commits)
- **PLAN:**
  - §6.22 notes;
  - new §6.23 misses, §6.24 portfolio (provider, units, scope), §6.25 lists and §6.26 facts;
  - §7 lists `last_exchange` and `misses` as stored, encrypted message text, and gets the
    facts amendment;
  - dated lines in §14.
- **CLAUDE.md:** invariant 2 amendment.
- **ROADMAP:** block H, parts 15–19, and the scope that shipped (US-only or US + TASE).
- **HANDOFF:**
  - §1, §6 and §8;
  - the "private tools" row gains lists and the portfolio;
  - the Tasks-versus-lists change.
- **ARCHITECTURE.**
- **`/help`, SETUP.md and `ops/`.**
- **The `add-tool` checklist** for each tool (M11).

## Verification
- **Every part:**
  - `pnpm typecheck && pnpm lint && pnpm test && pnpm eval` all green;
  - the token gate in parts 17–19.
- **Tests first, part by part:**
  - **Stores:**
    - caps;
    - soft-delete;
    - Undo across several rows is all or nothing;
    - an Undo after a version change is refused;
    - an Undo that created a list keeps items added later;
    - a restore that hits a duplicate is refused, and so is one past a full cap.
  - **List matching:**
    - `name_key` uniqueness: "רשימת קניות" = "קניות" = "הקניות";
    - an empty key → CLARIFY;
    - an exact key wins;
    - a new list is announced.
  - **`last_exchange`:**
    - `seq` ordering, including equal milliseconds;
    - the counter keeps going after `inbound_messages` is pruned empty;
    - an expired row is replaced even with a lower `seq`;
    - a resumed turn keeps its original `seq`;
    - only turns that reached a model write;
    - deterministic steps and `agentBusy` don't write;
    - the miss reply echoes the captured request;
    - encrypt and decrypt failures;
    - TTL.
  - **Facts:** validation.
  - **Tool selection:** the union, the any-group "≤ half" rule, and the 100% offered-set
    gate.
  - **Budget fitter:** keeps the last exchange.
  - **Quotes:**
    - USD, ILS and ILA units, normalized exactly once, before the cache;
    - a TASE holding with ILS currency accepts an ILA quote;
    - an unknown currency, a symbol mismatch, an omitted symbol, a duplicate;
    - the `op` rules: weighted average, a missing price → CLARIFY, `reduce` to 0 or below 0,
      and `set` keeping the price;
    - agorot vs shekel buy prices;
    - a 429 inside a 200 body;
    - stale served after an error;
    - closed-market hours across mismatched DST weeks;
    - a missing quote gives a partial total;
    - a missing buy price, a missing previous close;
    - 20 holdings in one batch.
  - **Market words** override the model.
  - **Rollback:** an unknown scheduled topic.
- **Cross-feature tests:**
  - a fact plus a weather question;
  - lists versus notes routing;
  - a failed turn, then "לא הבנת";
  - a confirmation, then "לא הבנת" (the original request is captured);
  - a failed private turn stays encrypted;
  - the source fails during `portfolio.show` and during a scheduled send;
  - the agent's deps exclude `last_exchange` and `misses`.
- **Agent evals:** `pnpm eval:agent --filter nx-|li-|pf-|mem-|he-` on gpt-oss-120b and qwen,
  with `--resume` within a part.
- **The log canary and the ban-list** stay green. A failed quote logs neither the key nor
  the URL.
- **Staging (with approval):**
  1. "מה הפתקים שלי".
  2. "תוסיף חלב לרשימת קניות", then "תראה לי את הרשימות".
  3. "תזכור עליי שאני גר ברחובות", then "מה מזג האוויר".
  4. A vague request, then "לא הבנת", then `/misses`.
  5. "תוסיף 10 מניות אפל ב-150", then "תוסיף 50 טבע" (expect CLARIFY), then "50 טבע בת״א",
     then "מה שווי התיק?".

## Rejected objections
- None. Review rounds 1–2 were folded in. From round 3 (the architecture review), B1–B3, M3,
  H1–H6 and the MEDIUM items were adopted. From round 4, N1–N3, H1–H6 and M1–M12 were
  adopted. From round 5, T1–T4, I1 and I2 were adopted. From round 6, all five were adopted:
  market precedence, an add with a price when none is stored, the layer that checks
  currency, the `CHECK` constraints, and no default unit for a TASE buy price. From round 7,
  all six were adopted:
  - Part 17 is one commit;
  - `item_key`, with duplicates skipped;
  - the rules for `set` and `reduce`;
  - `seq` inside `repo.transaction` and in the payload of `agent_turns`;
  - the canonical symbol stored at creation;
  - primary keys for `last_exchange` and `quote_cache`.
- Round 5's I3–I6 and its minor observations were not adopted, by the user's choice. Two of
  the minor points are in anyway:
  - the separate `CREATE UNIQUE INDEX` syntax, which is needed for correct SQL;
  - list names shown in the "התכוונת ל-…?" hint instead of a fuzzy "closest name". With up
    to 5 lists they are all shown, which avoids a fuzzy-matching function.
- Round 3's LOW items were not adopted as such, but they are now covered:
  - M6 by the 10M cap;
  - M11 by stripping punctuation;
  - M13 by the "אין הודעה אחרונה לשמור" reply;
  - M18 by the shared renderer and the empty-portfolio line;
  - M10 by the docs line on Tasks.
- Round 4's premise that Part 15 and the misses part shared migration 0022 was wrong: Part
  15 has no migration.
