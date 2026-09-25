/**
 * The secret scan that replaced "skipping secret scan" (PLAN §11.6, backlog B3).
 *
 * Every commit in this repository was made with the pre-commit hook printing
 * `gitleaks not installed — skipping`. A guardrail nobody has ever seen fire is
 * indistinguishable from no guardrail, so these cases fire it: the scanner is
 * run as a subprocess, exactly as the hook runs it, against files written for
 * the purpose.
 *
 * Every fixture secret is **assembled at runtime**. Writing one as a literal
 * would put a string shaped like a credential into the repository, which is the
 * thing being guarded against — and the scanner would be right to flag it.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = 'scripts/scan-secrets.mjs';

type Result = { code: number; stdout: string; stderr: string };

function runScan(paths: string[]): Result {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...paths], { encoding: 'utf8' });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      code: failure.status ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

describe('the built-in secret scan', () => {
  let dir: string;

  const file = (name: string, content: string): string => {
    const path = join(dir, name);
    writeFileSync(path, content, 'utf8');
    return path;
  };

  beforeEach(() => {
    // Not under `test/`, which the config allowlists — these fixtures have to
    // be scanned, not skipped.
    dir = mkdtempSync(join(tmpdir(), 'secret-scan-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('passes a clean file', () => {
    const result = runScan([file('clean.ts', 'export const answer = 42;\n')]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('clean');
  });

  it('catches a Meta access token', () => {
    const token = `EAA${'b'.repeat(48)}`;
    const result = runScan([file('leak.ts', `const t = '${token}';\n`)]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('wa-access-token');
  });

  it('catches a Groq key', () => {
    const key = `gsk_${'c'.repeat(48)}`;
    const result = runScan([file('leak.ts', `const k = '${key}';\n`)]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('groq-api-key');
  });

  it('catches a Google client secret', () => {
    const secret = `GOCSPX-${'d'.repeat(28)}`;
    const result = runScan([file('leak.ts', `const s = '${secret}';\n`)]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('google-oauth-client-secret');
  });

  it('catches a private key header', () => {
    const header = `-----BEGIN${' '}PRIVATE KEY-----`;
    const result = runScan([file('key.pem', `${header}\n`)]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('private-key');
  });

  it('catches a real phone number, which no off-the-shelf scanner would', () => {
    // This project's own rule (CLAUDE.md): a number in code, a fixture or a doc
    // is the leak this assistant is most likely to produce.
    const result = runScan([file('doc.md', 'Send it to 054-1234567.\n')]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('israeli-phone-number');
  });

  it('allows the obviously fake number CLAUDE.md asks for', () => {
    const result = runScan([file('fixture.ts', "const from = '972500000000';\n")]);
    expect(result.code).toBe(0);
  });

  it('catches a real email address and allows an example one', () => {
    expect(runScan([file('a.md', 'write to someone@gmail.com\n')]).code).toBe(1);
    expect(runScan([file('b.md', 'write to test@example.com\n')]).code).toBe(0);
  });

  it('refuses a secrets file by its path, whatever is inside it', () => {
    const result = runScan([file('.dev.vars', 'NOTHING=interesting\n')]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('must never be committed');
  });

  it('never prints the secret it found', () => {
    // A scanner that echoes the credential into a terminal and a CI log has
    // moved the problem, not solved it.
    const token = `EAA${'e'.repeat(48)}`;
    const result = runScan([file('leak.ts', `const t = '${token}';\n`)]);
    expect(result.stderr).not.toContain(token);
    expect(result.stdout).not.toContain(token);
    expect(result.stderr).toContain('leak.ts:1');
  });

  it('loads the project rules from .gitleaks.toml, not from a second copy', () => {
    // One place to add a rule. If this count drops, a rule stopped being read.
    const result = runScan([join(dir, 'nothing-here.ts')]);
    expect(result.stdout).toMatch(/\d+ rules/);
    const count = Number(/(\d+) rules/.exec(result.stdout)?.[1]);
    expect(count).toBeGreaterThanOrEqual(8);
  });
});
