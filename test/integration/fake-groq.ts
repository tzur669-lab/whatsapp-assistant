/**
 * A fake Groq endpoint. Unit tests make no network calls (CLAUDE.md, Testing
 * rules), so the provider is handed this in place of `fetch`.
 */
export type FakeGroqScript =
  | { kind: 'content'; content: string }
  | { kind: 'status'; status: number }
  | { kind: 'network_error' }
  | { kind: 'connect_timeout' }
  | { kind: 'timeout' }
  | { kind: 'bad_envelope' };

export type FakeGroq = {
  fetchImpl: typeof fetch;
  /** Every request body the provider sent, parsed. */
  requests: { model: string; temperature: number; messages: { role: string; content: string }[] }[];
};

/** Each call consumes the next script entry; the last one repeats. */
export function createFakeGroq(script: FakeGroqScript[]): FakeGroq {
  const requests: FakeGroq['requests'] = [];
  let index = 0;

  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body ?? '{}')));
    const step = script[Math.min(index++, script.length - 1)] ?? { kind: 'network_error' as const };

    switch (step.kind) {
      case 'timeout': {
        const error = new Error('timed out');
        error.name = 'TimeoutError';
        throw error;
      }
      case 'network_error':
        throw new TypeError('fetch failed');
      case 'connect_timeout': {
        // Shaped like undici's: the cause carries the code, not the name.
        const error = new TypeError('fetch failed');
        (error as unknown as { cause: { code: string } }).cause = { code: 'UND_ERR_CONNECT_TIMEOUT' };
        throw error;
      }
      case 'status':
        return new Response('{"error":"nope"}', { status: step.status });
      case 'bad_envelope':
        return new Response('{"choices":[]}', { status: 200 });
      case 'content':
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: step.content } }],
            usage: { prompt_tokens: 120, completion_tokens: 40 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
    }
  }) as unknown as typeof fetch;

  return { fetchImpl, requests };
}
