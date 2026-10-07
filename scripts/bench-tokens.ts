/**
 * Tokens per call, estimated, before and after tool selection (PLAN §9).
 *
 * No network and no model: it builds the first call the loop would send for
 * every phrase in the eval corpus and the selection fixture, with the full
 * catalog and with the catalog code selects, and reports the estimator's
 * tokens for each. Also the second call of a read turn: tools as before, or
 * none (the text-only rule, §3).
 *
 * An estimate (characters / 2.5), so a ranking and an order of magnitude — the
 * real numbers come from `pnpm eval:agent` and `run-turn-evals.ts`.
 *
 *   tsx scripts/bench-tokens.ts
 */
import { estimateTokens } from '../src/agent/loop.js';
import type { AgentMessage } from '../src/agent/provider.js';
import { languageLine, nowLine, SYSTEM_PROMPT } from '../src/agent/prompt.js';
import { selectionLabel, selectTools } from '../src/agent/tool-groups.js';
import { agentToolNames, wireTools } from '../src/agent/tools.js';
import { fingerprintPhrases } from '../test/evals/fingerprint.js';

const NOW = Date.parse('2026-09-24T12:00:00+03:00');
const FULL = agentToolNames({ cards: true, fileCards: true, phoneReads: true, grants: { gmail: true, tasks: true, drive: true } });
const fullChars = JSON.stringify(wireTools(FULL)).length;

/** A typical read result the model gets back: about 400 characters. */
const READ_RESULT = 'יום ה׳ 24.9\n• 13:00–14:00 פגישה\n'.repeat(12);

function firstCall(text: string): AgentMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `${nowLine(NOW)}\n${languageLine('he')}\n\n${text}` },
  ];
}

function afterRead(text: string): AgentMessage[] {
  return [
    ...firstCall(text),
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'calendar__list_events', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: READ_RESULT },
  ];
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

const phrases = fingerprintPhrases();
const rows = phrases.map((text) => {
  const selection = selectTools(text, FULL);
  const selectedChars = JSON.stringify(wireTools(selection.tools)).length;
  const oldFirst = estimateTokens(firstCall(text), fullChars);
  const newFirst = estimateTokens(firstCall(text), selectedChars);
  // A read turn: the old loop sent the catalog again; the new one sends none.
  const oldTurn = oldFirst + estimateTokens(afterRead(text), fullChars);
  const newTurn = newFirst + estimateTokens(afterRead(text), 0);
  return { group: selectionLabel(selection), oldFirst, newFirst, oldTurn, newTurn };
});

const narrowed = rows.filter((row) => row.group !== 'full').length;
const byGroup = new Map<string, number>();
for (const row of rows) byGroup.set(row.group, (byGroup.get(row.group) ?? 0) + 1);

const out = (line: string) => process.stdout.write(`${line}\n`);
out(`phrases: ${rows.length}, narrowed: ${narrowed} (${((narrowed / rows.length) * 100).toFixed(0)}%)`);
out(`by group: ${[...byGroup.entries()].map(([g, n]) => `${g} ${n}`).join(', ')}`);
out(`first call, median tokens:     old ${median(rows.map((r) => r.oldFirst))}  new ${median(rows.map((r) => r.newFirst))}`);
out(`read turn (2 calls), median:   old ${median(rows.map((r) => r.oldTurn))}  new ${median(rows.map((r) => r.newTurn))}`);
out(`read turn, worst new:          ${Math.max(...rows.map((r) => r.newTurn))}  (turn cap 7000)`);
