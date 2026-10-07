/**
 * `/misses` text → draft eval cases (PLAN §6.23, 2026-10-07).
 *
 * The user pastes the `/misses` reply into a file; this turns each "בקשה:" line
 * into a draft case under `evals-private/` (gitignored). The drafts hold the
 * user's real words — possibly a note, or someone else's forwarded text — so
 * they are never committed as they are: a human rewrites each one with fake
 * values, fills in `expect`, and only then moves it into `test/evals/`.
 *
 *   tsx scripts/misses-to-evals.ts <pasted-misses.txt>
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const OUT_DIR = 'evals-private';
const OUT_FILE = `${OUT_DIR}/cases.misses.draft.yaml`;
/** The isolate marks the bot wraps around user text (src/render/bidi.ts). */
const ISOLATES = /[⁦-⁩]/g;

/**
 * A path, not a secret: anything that looks like a key, token or JSON blob is
 * refused, and never echoed back.
 */
function looksLikeSecret(value: string): boolean {
  return (
    /[{}]/.test(value) ||
    value.includes('-----BEGIN') ||
    /\b(?:AIza|ghp_|gho_|sk-|gsk_|xox[bp]-)/.test(value) ||
    /[A-Za-z0-9+/=]{40,}/.test(value)
  );
}

const out = (line: string) => process.stdout.write(`${line}\n`);
const err = (line: string) => process.stderr.write(`${line}\n`);

function main(): void {
  const arg = process.argv[2];
  if (!arg) {
    err('usage: tsx scripts/misses-to-evals.ts <pasted-misses.txt>');
    process.exit(2);
  }
  if (looksLikeSecret(arg)) {
    err('That argument does not look like a file path. Nothing was read.');
    process.exit(2);
  }

  const text = readFileSync(resolve(arg), 'utf8').replace(ISOLATES, '');
  const requests = text
    .split('\n')
    .map((line) => /^\s*בקשה:\s*(.+)$/.exec(line)?.[1]?.trim())
    .filter((line): line is string => line !== undefined && line.length > 0 && !line.startsWith('['));

  if (requests.length === 0) {
    err(`No "בקשה:" lines in ${basename(arg)}. Paste the /misses reply as it is.`);
    process.exit(1);
  }

  const cases = requests.map((request, index) =>
    [
      `- id: miss-${String(index + 1).padStart(3, '0')}`,
      '  now: "2026-10-07T10:00:00+03:00"',
      `  input: ${JSON.stringify(request)}`,
      '  expect:',
      '    intent: TODO',
      '    missing: []',
    ].join('\n'),
  );

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    OUT_FILE,
    [
      '# DRAFTS — real words. Rewrite every input with fake values and fill in',
      '# `expect` before moving a case into test/evals/. Never commit this file.',
      '',
      cases.join('\n\n'),
      '',
    ].join('\n'),
    'utf8',
  );
  out(`${cases.length} draft case(s) written to ${resolve(OUT_FILE)}`);
  out('WARNING: they may contain a note or text someone else wrote. Rewrite before committing.');
}

main();
