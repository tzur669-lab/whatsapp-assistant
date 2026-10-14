# Facts the user mentions in passing (PLAN §6.26 amendment, 2026-10-14)

## Context

The user: "I say things about myself — I study here, work here, do this — and I want
the bot to learn me and understand me, to be more accurate for me."

Today (§6.26) a fact is kept only on an explicit "about me" signal ("תזכור עליי",
"על עצמי", "תזכור לתמיד", "remember about me"), stated only in the tool's
description; the model sees every fact on every agent turn. 25 facts, 800 chars.

User's decisions (2026-10-14):
1. A fact mentioned in passing ("אני לומד באריאל") is **offered** with a confirm card
   (כן / לא). Never saved silently.
2. Caps ×2: 40 facts, 1,600 characters (one fact still ≤ 200).

## Design

The model proposes, code decides whether it was asked. Code reads the user's words
for the explicit signal; without it, the same tool goes behind a confirmation.

1. **Lexicon** — `src/agent/tool-groups.ts` already normalizes Hebrew for matching
   (`normalizeHebrew`); add `namesRememberAboutMe(text): boolean` next to it (code,
   not the model): `תזכור/תזכרי/זכור עליי|עלי`, `על עצמי`, `תזכור/תזכרי לתמיד`,
   `remember (this )?about me`. This is the one list code acts on; the prose in the
   description, help and hint only describes it.
2. **Context** — `ToolContext.explicitFact?: boolean`, set by `turnOf`
   (`src/core/pipeline.ts`) from the `text` argument it already takes for the market
   words. Paths that pass no text (open-question answer, buttons, resume after a
   phone read or consent) leave it undefined = not explicit = confirm. Fail safe.
3. **Resolve** — `ResolveOutcome` `ready` gets optional `unrequested?: true`
   (`src/tools/types.ts:148` area, next to `needsConfirm`). `memory.remember.resolve`
   (`src/tools/memory.ts:54`) keeps its refusals in order (no text, tainted, private
   data) and then returns `unrequested: true` when `ctx.explicitFact !== true`.
4. **Policy** — `PolicyContext.unrequested?: boolean` (`src/policy/engine.ts:42`
   area); for a write it adds reason `unrequested` → CONFIRM, like `far_future`
   (`engine.ts:130`). The orchestrator passes `unrequested: resolved.unrequested ===
   true` (`src/core/orchestrator.ts:303`). Test-first in `test/unit/policy/engine.test.ts`.
   The card stores the validated input; "כן" executes the stored input
   (`runConfirmed`, `orchestrator.ts:~691`); "לא" cancels. `execute` keeps its own
   tainted / private / duplicate / full checks.
5. **Preview** — `memory.remember.preview` is the confirm summary
   (`orchestrator.ts:422`). Today it returns `factText.remembered` ("נשמר כעובדה
   עליך…") followed by "לאשר?" — wrong tense, and already shown on every confirmed
   save (smart model, backup model, uncertain voice, stale). `preview` always
   returns `factText.offer(text)`; every confirm card for this tool shows it. A
   confirmed save carries no Undo (`runConfirmed` drops `compensating`,
   `orchestrator.ts:690-701`): accepted — the user tapped yes; `/memory` and
   `memory.forget` remain.
6. **Description** — registry `memory.remember.llmDescription`
   (`src/tools/registry.ts:906`) and its brief (`src/agent/briefs.ts:44`): also when
   the user states a lasting fact about themselves in passing (study, work, family,
   routine, preferences) and the message asks for nothing else; code asks them
   first. See 9 for the length limits.
7. **Caps** — `src/tools/fact-store.ts`: `MAX_FACTS` 40, `MAX_FACTS_TOTAL_CHARS` 1,600
   (and its header comment). No migration: caps are checked at insert only.
8. **Fitter: facts go one at a time, oldest first** (`src/agent/loop.ts:442-444`).
   Today all facts go at once when the first call exceeds `turnCap − COMPLETION_RESERVE`;
   with 1,600 chars (~530 tokens) on a brief full catalog (5,710) that would empty the
   facts exactly on "אני לומד באריאל"-type turns. Order: old history goes first down
   to the last exchange (`fitHistory` measures with all facts, `loop.ts:443`); then
   facts. New: drop the oldest fact until it
   fits (≤ 40 estimates, cheap); `agent_fit` logs the count dropped. Newer facts win
   (a newer one may correct an older one). Test in `fit.test.ts`: full facts on the
   brief full catalog keep most facts and fit.
9. **Brief** — `BRIEF_MAX` 80 chars and shorter than its description
   (`briefs.ts:18`, `fit.test.ts:151-152`); the brief catalog is pinned ≤ 5,750
   against 5,710 measured (`fit.test.ts:166-169`): re-measure; the description may
   grow only within the pin.
10. **Journal** — a "לא" on a `memory.remember` card is not a `confirm_no` learning
    event (`writeLearnSignals` skips that tool): an offer declined is not a
    refusal of an action the user asked for.

## Invariants

1 (code decides: the confirm comes from code reading the words, not the model);
2 (unchanged: user's own words, never tainted, `containsPrivateData` refused);
7 (the confirmation is the existing deterministic path); 8 (nothing from chat
changes policy: the reason is static code); 10 (a card ends the turn — a message
with a self-mention and a request: the description tells the model to do the
request; if it offers the fact instead, the user sees a card and can ask again).

## Accepted

- A declined fact may be offered again later (the dedupe covers stored facts only);
  bounded by the tool's 20 per hour. A "don't ask again" list is a follow-up.
- Two saves of the same fact at once may both insert (the existing J7 note); each
  needs a tap now.
- "תזכור עליי" with no fact asks `fact_text`; that clarify is `personal`, which records
  **no** open question (`askedSlotOf`, `orchestrator.ts:379` — no `personal` case), so
  the answer is a fresh message without the signal words and gets a card: one extra
  tap, fail safe.

## Tests

- lexicon: explicit phrases true; "אני לומד באריאל", "תזכור שהחניה…" false.
- policy: `unrequested` write → CONFIRM with reason `unrequested`; a read unaffected.
- resolve: explicit → ready without `unrequested`; implicit → `unrequested`; tainted
  still asks; private data still asks.
- pipeline (fake agent): "אני לומד באריאל" + agent calls `memory.remember` → a
  confirm card with the offer text, no fact stored; tapping ok stores it; "לא"
  stores nothing; "תזכור עליי ש…" → stored at once with Undo (unchanged).
- caps: 40th fact saved, 41st full; 1,600 chars (`memory.test.ts` cap loops).
- `smart-own-input.test.ts:264-283`: the smart / tainted confirm cards show the offer text.
- policy: `PolicyReason` union gains `unrequested` (`engine.ts:17`).
- fit: oldest facts dropped first; brief pin and `BRIEF_MAX`.
- journal: "לא" on a memory card writes no `confirm_no`.
- evals: `mem-006` "אני לומד הנדסת תעשייה וניהול באריאל" → memory.remember;
  `mem-007` "אני עובד מחר בשמונה, תזכיר לי לקום בשבע" → reminders.create.
  Run `pnpm eval:agent --filter mem-` on qwen. The description moves the
  fingerprint: the full `eval:agent` (already owed since J2) stays owed.

## Docs

PLAN §6.26 (amend "What becomes a fact", caps) + §14 row; HANDOFF §8 (+§6 note);
ROADMAP log (Hebrew); help (`he.ts:38`) and the hint (`personal.ts:264`) mention
the offer; HANDOFF §6 headroom figure; CLAUDE.md invariant 2 untouched.

## Rejected objections

- "Carry `explicitFact` through the open question" — no open question is recorded
  for a `personal` clarify (`orchestrator.ts:379-410`), so there is nothing to carry;
  the case is listed under Accepted.

## Review rounds

Round 1: 0 blockers, 7 gaps, 6 nits — all gaps fixed above except the one rejected.
Round 2 ([consistency], [blast-radius]): APPROVE; 3 nits applied (item 5 wording, trimming order, journal test in `learn.test.ts`; `agent_fit` logs a count).
