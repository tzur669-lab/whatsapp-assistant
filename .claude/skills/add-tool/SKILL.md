---
name: add-tool
description: Steps for adding or changing a tool in this WhatsApp assistant (src/tools/, registry, evals, PLAN.md). Use when defining a new ToolDefinition or modifying an existing tool.
---

1. Define a `ToolDefinition` in `src/tools/` with name, LLM description, Zod draft schema, `resolve`, tier, Google scopes, `preview`, `execute`, optional `undo`, and rate limits.
2. Register it in `src/tools/registry.ts`. The LLM catalog is generated from the registry. Don't hand-edit prompt tool lists.
3. Choose its **`dataSource`** (required; the registry does not compile without it; PLAN §6.19). Decide by what any of its replies may carry — the reply, the resolve outcome, the confirmation card, a list of candidates, the Undo text — **not** by whether it reads or writes. A consent source (`calendar`, `reminders`, `tasks`, `mail`, `drive`, `birthdays`, `contacts`, `sms`, `calls`, `notifications`, `expenses`) when it can show the user's data from there: `reminders.leave` writes a reminder but shows an event's title, and `nav.go` can navigate to an event's place, so both are `calendar`. `public` only when nothing in any reply is the user's data beyond their own words in this message (`info.lookup`, `calc.compute`, `alarm.set`). `private` for what no model may ever see (`notes.*`, `lists.*`, `memory.*`, `portfolio.*`); a private tool is never offered in a smart conversation. A new kind of source (not in `CONSENT_SOURCES`) is a decision: stop and ask. The choice moves the smart fingerprint, the consent card and the history placeholder; add a case to `test/unit/tools/data-source.test.ts`.
4. Add it to exactly one group in `src/agent/tool-groups.ts` (`GROUPS`), with keyword patterns if the group's don't cover it, and a few phrasings in `test/fixtures/tool-selection.he.yaml`. A tool in no group fails `tool-groups.test.ts`; a tool in the wrong one is hidden whenever that group's words match. Any change here changes the eval fingerprint (`test/evals/fingerprint.ts`), so backups that may write must be re-evaluated.
5. Add unit tests (resolve + policy + preview) and **eval cases** in `test/evals/`.
6. If it needs a new Google scope: stop and ask. New scopes are a security decision recorded in PLAN §14.
7. Update PLAN §6.4 and the §14 Decisions Log.
