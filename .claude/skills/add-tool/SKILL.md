---
name: add-tool
description: Steps for adding or changing a tool in this WhatsApp assistant (src/tools/, registry, evals, PLAN.md). Use when defining a new ToolDefinition or modifying an existing tool.
---

1. Define a `ToolDefinition` in `src/tools/` with name, LLM description, Zod draft schema, `resolve`, tier, Google scopes, `preview`, `execute`, optional `undo`, and rate limits.
2. Register it in `src/tools/registry.ts`. The LLM catalog is generated from the registry. Don't hand-edit prompt tool lists.
3. Add unit tests (resolve + policy + preview) and **eval cases** in `test/evals/`.
4. If it needs a new Google scope: stop and ask. New scopes are a security decision recorded in PLAN §14.
5. Update PLAN §6.4 and the §14 Decisions Log.
