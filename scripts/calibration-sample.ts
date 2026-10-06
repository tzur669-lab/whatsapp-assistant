/**
 * Refresh `test/fixtures/token-calibration.json` from the eval recordings
 * (PLAN §6.19): every recorded call with both `chars` and `promptTokens`.
 * Integers only — no ids that name a message, no text.
 *
 *   tsx scripts/calibration-sample.ts
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'test/evals/recordings';
const pairs: Array<{ chars: number; promptTokens: number }> = [];

if (existsSync(dir)) {
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json') || file.startsWith('ledger-')) continue;
    const data = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
      cases?: Array<{ chars?: number; promptTokens?: number }>;
      runs?: Record<string, { calibration?: Array<{ chars: number; promptTokens: number }> }>;
    };
    for (const c of data.cases ?? []) {
      if (Number.isInteger(c.chars) && Number.isInteger(c.promptTokens) && c.promptTokens! > 0) {
        pairs.push({ chars: c.chars!, promptTokens: c.promptTokens! });
      }
    }
    for (const run of Object.values(data.runs ?? {})) {
      for (const pair of run.calibration ?? []) if (pair.promptTokens > 0) pairs.push(pair);
    }
  }
}

writeFileSync('test/fixtures/token-calibration.json', `${JSON.stringify({ source: 'eval recordings (synthetic corpus)', pairs }, null, 1)}\n`);
process.stdout.write(`${pairs.length} pairs written\n`);
