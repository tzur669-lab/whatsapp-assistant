/**
 * The agent's transport (PLAN §6.19, 2026-10-06): what goes on the wire.
 */
import { describe, expect, it } from 'vitest';
import { createGroqAgentProvider } from '../../../src/agent/provider.js';
import type { WireTool } from '../../../src/agent/provider.js';

function capture() {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  return { bodies, fetchImpl };
}

const tool: WireTool = { type: 'function', function: { name: 'x', description: 'x', parameters: { type: 'object' } } };
const messages = [{ role: 'user' as const, content: 'hi' }];

describe('agent provider', () => {
  it('sends neither tools nor tool_choice on a text-only call', async () => {
    const { bodies, fetchImpl } = capture();
    await createGroqAgentProvider({ apiKey: 'k', model: 'm', fetchImpl }).complete(messages, []);
    expect(bodies[0]).not.toHaveProperty('tools');
    expect(bodies[0]).not.toHaveProperty('tool_choice');
  });

  it('sends both when tools are offered', async () => {
    const { bodies, fetchImpl } = capture();
    await createGroqAgentProvider({ apiKey: 'k', model: 'm', fetchImpl }).complete(messages, [tool]);
    expect(bodies[0]).toMatchObject({ tools: [tool], tool_choice: 'auto' });
  });

  it("sends the entry's completion size, and reasoning effort only when the entry has it", async () => {
    const { bodies, fetchImpl } = capture();
    await createGroqAgentProvider({ apiKey: 'k', model: 'm', fetchImpl, maxCompletionTokens: 777, params: {} }).complete(messages, []);
    expect(bodies[0]).toMatchObject({ max_completion_tokens: 777 });
    expect(bodies[0]).not.toHaveProperty('reasoning_effort');

    await createGroqAgentProvider({ apiKey: 'k', model: 'm', fetchImpl, params: { reasoningEffort: 'low' } }).complete(messages, []);
    expect(bodies[1]).toMatchObject({ reasoning_effort: 'low', max_completion_tokens: 1_024 });
  });

  it('reports zero usage when the answer carried none', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })) as typeof fetch;
    const response = await createGroqAgentProvider({ apiKey: 'k', model: 'm', fetchImpl }).complete(messages, []);
    expect(response.ok && response.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
  });
});
