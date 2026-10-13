/**
 * A model that repeats a call code refused (block J, J1): the next call is
 * text-only, so the model words its answer instead of spending the rest of the
 * turn on the same refusal. Only a model allowed more than 3 calls (Gemini, 6):
 * a Groq model's last call is already its third, text-only as before.
 */
import { describe, expect, it } from 'vitest';
import { TokenBudget } from '../../../src/agent/budget.js';
import { QWEN, SMART_MODELS } from '../../../src/agent/models.js';
import { runAgentTurn } from '../../../src/agent/loop.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import { createFakeAgent } from '../../integration/fake-agent.js';
import type { FakeStep } from '../../integration/fake-agent.js';

/** Thursday 2026-09-24, 12:00 local. */
const NOW = Date.parse('2026-09-24T09:00:00Z');
const GEMINI = SMART_MODELS[0]!.id;

/** A call strict Zod refuses (`invalid_arguments`); nothing is resolved or run. */
const bad = (value: number): FakeStep => ({ tool: 'calc.compute', args: { not_a_slot: value } });

async function turn(steps: FakeStep[], smart: boolean) {
  const agent = createFakeAgent(steps, smart ? GEMINI : QWEN, 500, smart ? 'smart' : 'primary');
  const log = createFakeLogger();
  const result = await runAgentTurn(
    {
      text: 'כמה זה 15 אחוז מ-80?',
      lang: 'he',
      nowMs: NOW,
      turn: { principal: 'p_repeat', nowMs: NOW } as never,
      history: [],
      ...(smart ? { smart: true } : {}),
    },
    { providers: [agent], budget: new TokenBudget(() => NOW), log, now: () => NOW },
  );
  const turnLog = log.captured.find((entry) => entry.event === 'agent_turn');
  return { agent, result, turnLog };
}

describe('a repeated refused call', () => {
  it('makes the next call text-only on a 6-call model', async () => {
    const { agent, result, turnLog } = await turn([bad(1), bad(1), { text: 'לא הצלחתי לחשב' }], true);
    expect(result).toMatchObject({ kind: 'reply', reply: { text: 'לא הצלחתי לחשב' } });
    expect(agent.tools[0]!.length).toBeGreaterThan(0);
    expect(agent.tools[1]!.length).toBeGreaterThan(0);
    expect(agent.tools[2]).toEqual([]);
    expect(turnLog?.fields['repeat']).toBe(true);
  });

  it('does not when the arguments differ', async () => {
    const { agent, turnLog } = await turn([bad(1), bad(2), { text: 'בסדר' }], true);
    expect(agent.tools[2]!.length).toBeGreaterThan(0);
    expect(turnLog?.fields['repeat']).toBeUndefined();
  });

  it('does not count a call that is only refused once, then a text answer', async () => {
    const { agent, turnLog } = await turn([bad(1), { text: 'בסדר' }], true);
    expect(agent.tools[1]!.length).toBeGreaterThan(0);
    expect(turnLog?.fields['repeat']).toBeUndefined();
  });

  it('leaves a 3-call Groq model as before: tools on call 2, text-only on the last', async () => {
    const { agent, turnLog } = await turn([bad(1), bad(1), { text: 'בסדר' }], false);
    expect(agent.tools[1]!.length).toBeGreaterThan(0);
    expect(agent.tools[2]).toEqual([]);
    expect(turnLog?.fields['repeat']).toBeUndefined();
  });
});
