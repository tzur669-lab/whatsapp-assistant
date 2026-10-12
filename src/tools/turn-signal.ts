/**
 * An agent turn's deadline, at the network boundary (Improvement plan §3 T3).
 *
 * One read can chain about eleven requests, each with its own timeout, so only
 * a signal makes the deadline real. `withTurnSignal` gives a tool a context
 * whose every network path is cut when the signal fires: the Google clients,
 * the quote sources and the public `fetchImpl` (`lookup/http.ts`). The
 * orchestrator hands it to a resolve and to a read's execute — never to a
 * write's `execute`, which finishes once started (its outcome would otherwise
 * be unknown).
 *
 * A new network client on `ToolContext` must be bound here too; the fetch
 * inventory in `test/security/turn-signal-fetch.test.ts` fails until a new
 * `fetch` call site is classified.
 */
import type { ToolContext } from './types.js';

/** `fetchImpl`, its every request also cut when `signal` fires. */
export function signalledFetch(fetchImpl: typeof fetch, signal: AbortSignal): typeof fetch {
  // A closure: Workers' `fetch` called as a method throws "Illegal invocation".
  return (input, init) =>
    fetchImpl(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal });
}

/**
 * Every real client has `withSignal` (typed, and pinned per class in
 * `test/unit/tools/turn-signal.test.ts`); only a test's fake, cast to the
 * class, may not — it reaches no network, so it is kept as it is.
 */
function bound<T extends { withSignal(signal: AbortSignal): T }>(client: T, signal: AbortSignal): T {
  return typeof client.withSignal === 'function' ? client.withSignal(signal) : client;
}

export function withTurnSignal(ctx: ToolContext, signal: AbortSignal): ToolContext {
  const { calendar, tasks, gmail, drive, contacts, quotes, fetchImpl } = ctx;
  return {
    ...ctx,
    signal,
    ...(calendar ? { calendar: bound(calendar, signal) } : {}),
    ...(tasks ? { tasks: bound(tasks, signal) } : {}),
    ...(gmail ? { gmail: bound(gmail, signal) } : {}),
    ...(drive ? { drive: bound(drive, signal) } : {}),
    ...(contacts ? { contacts: bound(contacts, signal) } : {}),
    ...(quotes ? { quotes: { quote: (symbol, market) => quotes.quote(symbol, market, signal) } } : {}),
    ...(fetchImpl ? { fetchImpl: signalledFetch(fetchImpl, signal) } : {}),
  };
}
