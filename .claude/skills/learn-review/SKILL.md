---
name: learn-review
description: Turn the bot's monthly learning export (bot-learn-YYYY-MM-DD.json in Downloads, block K, K4) into fixes — cluster what failed, propose lexicon / description / fallback / ROADMAP changes, write eval cases with fake values, run the owed evals, then delete the export. Use when the user hands over a learning export or asks to "learn from the export".
---

The export is the user's real words, **scrubbed but not anonymized** (names,
addresses and places stay). It never enters git, a commit message, a doc, a
log or a model prompt. Only the fixes do, written with fake values.

1. **Find the file.** `C:\Users\tzur6\Downloads\bot-learn-*.json` (the newest
   unless the user names one). Check `"schema": 1`; anything else → stop and ask.
2. **Make the drafts.** `pnpm exec tsx scripts/learn-to-evals.ts <file>` from
   `bot/`. It writes, under `evals-private/` (gitignored):
   - `drafts/cases.learn-misses.draft.yaml` — reported misses ("לא הבנת").
   - `candidates/learn-rephrases.yaml` — heuristic pairs. **Not cases.** Read
     each pair and keep it only if the rephrase is clearly the same request;
     a pair that changed the subject is dropped, never turned into a case.
   It also prints the Undo/"no" taps per tool, the leave stats, the weekly
   counters and the proposal outcomes.
3. **Cluster.** Group the misses and confirmed pairs by cause, and say how many
   each holds. Typical causes and where the fix goes:
   - a time or date phrase the parser does not know → `src/time/hebrew-lexicon.ts`
     (and `src/time/resolve.ts` tests; DST rules stay);
   - the model picked the wrong tool, or none → the tool's description in
     `src/tools/registry.ts` / its brief in `src/agent/briefs.ts`, or a group
     word in `src/agent/tool-groups.ts`;
   - a reply that did not help → `src/render/fallback.ts`;
   - a capability the bot does not have → a ROADMAP item (Hebrew,
     `hebrew-content-writer`), not code;
   - many Undo taps on one tool soon after it ran → look at what it did by
     default (a wrong default time, a wrong target).
   Present the clusters and the proposed fix for each **before** changing code.
   Nothing learned may touch policy, tiers, allowlists or limits (invariant 8),
   and nothing may default a missing time (invariant 4).
4. **Write cases.** For each fix, write eval cases in `test/evals/` with **fake
   values** (invented names, places, `972500000000`, `test@example.com`), the
   same shape as the draft (`id`, `now`, `input`, `expect`). Never copy a real
   input verbatim. Follow `add-tool` if a tool changes.
5. **Verify.** `pnpm typecheck && pnpm lint && pnpm test`. Then the evals owed:
   `pnpm eval` for `src/nlu/`; `pnpm eval:agent --filter <prefix>` for
   `src/agent/` or a description. A description or catalog change moves the
   Groq fingerprint (`test/evals/fingerprint.ts`): re-pin it, and record that a
   full `eval:agent` (with `--resume`, over several days) is owed in PLAN §13.
6. **Log.** Add a dated row to `docs/learn-log.md`: the export's date, the
   counts, each cluster's cause and fix, the cases added, the evals run. No
   private text — causes in general words only.
7. **Clean up.** Delete `evals-private/drafts/cases.learn-misses.draft.yaml`,
   `evals-private/candidates/learn-rephrases.yaml` and, after asking the user,
   the export in Downloads. Remind them that `/learn forget` clears the bot's
   copy, and that this file was the only other one.
8. Commit and push the fixes (CLAUDE.md rules; Hebrew strings via the Hebrew
   skills); deploy staging if server code changed.
