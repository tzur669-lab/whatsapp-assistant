---
name: add-tool
description: Steps for adding or changing a tool in this WhatsApp assistant (src/tools/, registry, evals, PLAN.md). Use when defining a new ToolDefinition or modifying an existing tool.
---

1. Define a `ToolDefinition` in `src/tools/` with name, LLM description, Zod draft schema, `resolve`, tier, Google scopes, `preview`, `execute`, optional `undo`, and rate limits.
2. Register it in `src/tools/registry.ts`. The LLM catalog is generated from the registry. Don't hand-edit prompt tool lists.
3. Add it to exactly one group in `src/agent/tool-groups.ts` (`GROUPS`), with keyword patterns if the group's don't cover it, and a few phrasings in `test/fixtures/tool-selection.he.yaml`. A tool in no group fails `tool-groups.test.ts`; a tool in the wrong one is hidden whenever that group's words match. Any change here changes the eval fingerprint (`test/evals/fingerprint.ts`), so backups that may write must be re-evaluated.
4. Add unit tests (resolve + policy + preview) and **eval cases** in `test/evals/`.
5. If it needs a new Google scope: stop and ask. New scopes are a security decision recorded in PLAN §14.
6. Update PLAN §6.4 and the §14 Decisions Log.
