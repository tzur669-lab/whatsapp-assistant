/**
 * Spike for block H part 19 (docs/plans/block-h.md, "Spike (blocking)"):
 * what the Finnhub free tier really gives before the portfolio is built on it.
 *
 * Answers, for PLAN §6.24:
 *   1. US quote with the key in a header: fields, prev close, timestamp.
 *   2. Batch quotes: does one call return several symbols?
 *   3. TASE: is a `.TA` symbol quoted on the free tier?
 *   4. Currency codes (profile), a dual-listed symbol (TEVA) in search.
 *   5. Market status, and the rate-limit headers / shape.
 *
 * Only public market data is requested. The key is read from the environment
 * (or `.dev.vars`) into this process and never printed; it travels in the
 * `X-Finnhub-Token` header, never in a URL. An error prints its status code
 * and at most a short body (Finnhub's errors are plain messages).
 *
 * Usage: pnpm tsx scripts/probe-quotes.ts
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = 'https://finnhub.io/api/v1';

/** stdout is the point of a spike; `console` stays banned (eslint). */
function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

type Probe = { status: number; body: unknown; remaining: string | null; limit: string | null };

async function get(apiKey: string, path: string): Promise<Probe> {
  const response = await fetch(`${BASE}${path}`, { headers: { 'X-Finnhub-Token': apiKey } });
  const text = await response.text();
  let body: unknown = text.slice(0, 200);
  try {
    body = JSON.parse(text);
  } catch {
    // keep the short text
  }
  return {
    status: response.status,
    body,
    remaining: response.headers.get('x-ratelimit-remaining'),
    limit: response.headers.get('x-ratelimit-limit'),
  };
}

function show(label: string, probe: Probe, pick?: (body: Record<string, unknown>) => unknown): void {
  const body = probe.body;
  const shown =
    pick && body && typeof body === 'object' && !Array.isArray(body) ? pick(body as Record<string, unknown>) : body;
  out(`${label}: HTTP ${probe.status} · ${JSON.stringify(shown).slice(0, 400)}`);
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function loadDevVars(): void {
  const path = fileURLToPath(new URL('../.dev.vars', import.meta.url));
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || process.env[key] !== undefined) continue;
    process.env[key] = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, '');
  }
}

async function main(): Promise<void> {
  loadDevVars();
  const apiKey = (process.env['QUOTES_API_KEY'] ?? '').trim();
  if (!apiKey) throw new Error('QUOTES_API_KEY is not set (environment or .dev.vars).');
  if (!/^[A-Za-z0-9]{10,64}$/.test(apiKey)) throw new Error('QUOTES_API_KEY does not look like a Finnhub key.');

  out('== 1. US quote (AAPL)');
  const aapl = await get(apiKey, '/quote?symbol=AAPL');
  show('quote AAPL', aapl);
  out(`rate-limit headers: limit=${aapl.limit ?? '—'} remaining=${aapl.remaining ?? '—'}`);

  out('\n== 2. Batch: two symbols in one call');
  show('quote AAPL,MSFT', await get(apiKey, '/quote?symbol=AAPL,MSFT'));

  out('\n== 3. Profiles: currency and exchange');
  for (const symbol of ['AAPL', 'TEVA', 'TEVA.TA']) {
    show(`profile2 ${symbol}`, await get(apiKey, `/stock/profile2?symbol=${encodeURIComponent(symbol)}`), (b) => ({
      ticker: b['ticker'],
      name: b['name'],
      exchange: b['exchange'],
      currency: b['currency'],
    }));
    await pause(300);
  }

  out('\n== 4. TASE quotes');
  for (const symbol of ['TEVA.TA', 'LUMI.TA', 'POLI.TA']) {
    show(`quote ${symbol}`, await get(apiKey, `/quote?symbol=${encodeURIComponent(symbol)}`));
    await pause(300);
  }

  out('\n== 5. Search: dual listing (TEVA) and a Hebrew name');
  for (const query of ['TEVA', 'teva pharmaceutical', 'טבע']) {
    show(`search "${query}"`, await get(apiKey, `/search?q=${encodeURIComponent(query)}`), (b) => {
      const result = Array.isArray(b['result']) ? (b['result'] as Record<string, unknown>[]) : [];
      return { count: b['count'], first: result.slice(0, 6).map((r) => `${String(r['symbol'])} (${String(r['type'])})`) };
    });
    await pause(300);
  }

  out('\n== 6. Market status');
  show('market-status US', await get(apiKey, '/stock/market-status?exchange=US'));
  show('market-status TA', await get(apiKey, '/stock/market-status?exchange=TA'));

  out('\n== 7. Unknown symbol');
  show('quote NOSUCHXYZ', await get(apiKey, '/quote?symbol=NOSUCHXYZ'));

  out('\n== 8. FX (USD/ILS) on the free tier');
  show('forex rates USD', await get(apiKey, '/forex/rates?base=USD'), (b) => ({
    ILS: (b['quote'] as Record<string, unknown> | undefined)?.['ILS'],
  }));

  out('\ndone. Paste this output back; it holds no key.');
}

main().catch((error: unknown) => {
  out(`failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
});
