/**
 * PLAN §11.6 hygiene scan. These constructs must never enter the codebase:
 * dynamic evaluation, non-literal dynamic imports, child processes, and
 * hardcoded identities.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const FILES = sourceFiles(SRC).map((path) => ({ path, code: readFileSync(path, 'utf8') }));

const BANNED: ReadonlyArray<readonly [string, RegExp]> = [
  ['eval()', /\beval\s*\(/],
  ['new Function()', /\bnew\s+Function\s*\(/],
  ['child_process', /child_process|node:child_process/],
  ['non-literal dynamic import', /\bimport\s*\(\s*(?!['"`])/],
  ['setTimeout with a string body', /setTimeout\s*\(\s*['"`]/],
];

describe('ban-list scan', () => {
  it('finds source files to scan', () => {
    expect(FILES.length).toBeGreaterThan(10);
  });

  for (const [label, pattern] of BANNED) {
    it(`contains no ${label}`, () => {
      const offenders = FILES.filter((f) => pattern.test(f.code)).map((f) => f.path);
      expect(offenders).toEqual([]);
    });
  }

  it('hardcodes no phone numbers or email addresses', () => {
    const phone = /\b(?:\+?972|05)\d{7,9}\b/;
    const email = /[\w.+-]+@[\w-]+\.[\w.]+/;
    const offenders = FILES.filter(
      (f) => phone.test(f.code) || email.test(f.code),
    ).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('logs only through the redacting logger', () => {
    const offenders = FILES.filter(
      (f) => !f.path.endsWith('redact.ts') && /\bconsole\.\w+\(/.test(f.code),
    ).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('imports Cloudflare-only APIs from src/platform alone', () => {
    // DurableObjectState / DurableObjectStorage are ambient Workers types, so
    // the check is on usage, not on import statements.
    const offenders = FILES.filter(
      (f) =>
        !f.path.includes(`${'platform'}`) &&
        !f.path.endsWith('index.ts') &&
        /DurableObject(State|Storage|Namespace)\b/.test(f.code),
    ).map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
