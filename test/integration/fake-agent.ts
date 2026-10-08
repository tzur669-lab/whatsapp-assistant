/**
 * A fake agent provider: scripted model turns, no network, no tokens spent.
 *
 * Each `complete` consumes the next step. Tool arguments are handed over as the
 * raw JSON string a model would send, so the loop's own parsing and strict
 * validation still run on them.
 */
import type { AgentMessage, AgentProvider, AgentResponse, WireTool } from '../../src/agent/provider.js';
import type { NluErrorCode } from '../../src/nlu/provider.js';

export type FakeStep =
  | { text: string }
  | { tool: string; args: Record<string, unknown> | string }
  | { error: NluErrorCode; retryAfterSeconds?: number; daily?: boolean };

export type FakeAgent = AgentProvider & {
  /** The messages the loop sent on each call, for asserting what the model saw. */
  calls: AgentMessage[][];
  tools: WireTool[][];
};

export function createFakeAgent(
  script: FakeStep[],
  model = 'fake-model',
  tokensPerCall = 500,
  role: 'primary' | 'backup' | 'smart' = 'primary',
): FakeAgent {
  const calls: AgentMessage[][] = [];
  const tools: WireTool[][] = [];
  let index = 0;

  return {
    model,
    role,
    calls,
    tools,
    async complete(messages, offered): Promise<AgentResponse> {
      calls.push(messages.map((message) => ({ ...message })));
      tools.push([...offered]);
      const step = script[index++];
      if (!step) throw new Error(`fake agent: no step ${index}`);

      if ('error' in step) {
        return {
          ok: false,
          error: {
            code: step.error,
            ...(step.error === 'rate_limited' ? { status: 429 } : {}),
            ...(step.retryAfterSeconds ? { retryAfterSeconds: step.retryAfterSeconds } : {}),
            ...(step.daily === undefined ? {} : { daily: step.daily }),
          },
        };
      }

      const usage = { promptTokens: tokensPerCall - 50, completionTokens: 50 };
      if ('text' in step) return { ok: true, text: step.text, toolCalls: [], usage };

      return {
        ok: true,
        text: null,
        toolCalls: [
          {
            id: `call_${index}`,
            name: step.tool.replace('.', '__'),
            arguments: typeof step.args === 'string' ? step.args : JSON.stringify(step.args),
          },
        ],
        usage,
      };
    },
  };
}

/** Every message content the model was shown, across all calls. */
export function seenByModel(agent: FakeAgent): string {
  return agent.calls
    .flat()
    .map((message) => message.content ?? '')
    .join('\n');
}
