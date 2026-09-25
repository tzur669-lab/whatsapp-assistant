#!/usr/bin/env node
/**
 * A secret scan that is always in force (PLAN §11.6, backlog B3).
 *
 * The pre-commit hook used to run gitleaks when it was installed and print
 * "skipping secret scan" when it was not — which is how every commit in this
 * repository was made. A guardrail that announces its own absence is not a
 * guardrail, so this runs in its place: no install, no network, nothing but
 * node and git.
 *
 * It is deliberately **not** a gitleaks replacement. gitleaks ships hundreds of
 * provider rules and entropy analysis; this covers the four things that would
 * actually leak from this project, plus the project's own rules read straight
 * out of `.gitleaks.toml` so there is one place to add a rule rather than two.
 * When gitleaks is installed the hook runs that as well.
 *
 * Usage:
 *   node scripts/scan-secrets.mjs --staged     # added lines in the index
 *   node scripts/scan-secrets.mjs <path…>      # whole files, for CI
 *
 * Findings are reported by rule, file and line. The matched text is never
 * printed — a scanner that echoes the secret it found into a terminal and a CI
 * log has moved the problem rather than solved it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const FAKE_ALLOWED = [
  // The obviously-fake values CLAUDE.md requires in code, tests and docs.
  '972500000000',
  '0500000000',
  'example.com',
  'example.test',
  'example.org',
  'noreply@anthropic.com',
  'test@example.com',
];

/** Paths that may never be committed at all, whatever is in them. */
const FORBIDDEN_PATHS = [
  /(^|\/)\.dev\.vars(\..*)?$/,
  /(^|\/)\.env(\..*)?$/,
  /(^|\/)secrets\//,
];

/**
 * Rules that always apply, on top of whatever `.gitleaks.toml` declares.
 *
 * The last two are this project's own rule rather than a general one: a real
 * phone number or email address in code, a fixture or a doc is exactly the leak
 * this assistant is most likely to produce, and no off-the-shelf scanner treats
 * it as one.
 */
const BUILT_IN = [
  { id: 'private-key', regex: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: 'aws-access-key', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'bearer-token', regex: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{24,}/ },
  { id: 'israeli-phone-number', regex: /(?<![\d])(?:\+?972|0)5\d-?\s?\d{3}-?\s?\d{4}(?![\d])/ },
  { id: 'email-address', regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
];

/** Custom rules out of `.gitleaks.toml`, so a rule is added in one place. */
function projectRules(configPath = '.gitleaks.toml') {
  if (!existsSync(configPath)) return [];
  const toml = readFileSync(configPath, 'utf8');
  const rules = [];

  for (const block of toml.split('[[rules]]').slice(1)) {
    const id = /^\s*id\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const pattern = /^\s*regex\s*=\s*'''([\s\S]*?)'''/m.exec(block)?.[1];
    if (!id || !pattern) continue;
    try {
      rules.push({ id, regex: new RegExp(pattern) });
    } catch {
      // A rule gitleaks accepts that JavaScript does not. Say so rather than
      // silently scanning with one rule fewer than the config declares.
      console.error(`scan-secrets: cannot compile rule "${id}" — skipped`);
    }
  }
  return rules;
}

/** Allowlisted paths out of the same config, plus this script itself. */
function allowedPaths(configPath = '.gitleaks.toml') {
  const patterns = [/^scripts\/scan-secrets\.mjs$/, /^\.gitleaks\.toml$/];
  if (!existsSync(configPath)) return patterns;

  const section = readFileSync(configPath, 'utf8').split('[allowlist]')[1];
  const paths = /paths\s*=\s*\[([\s\S]*?)\]/.exec(section ?? '')?.[1] ?? '';
  for (const match of paths.matchAll(/'''([\s\S]*?)'''/g)) {
    try {
      patterns.push(new RegExp(match[1]));
    } catch {
      /* same as above: a pattern JavaScript will not take */
    }
  }
  return patterns;
}

/**
 * Forward slashes always. Git reports paths that way, but a path typed on the
 * command line on Windows does not, and every pattern here is written for the
 * git form.
 */
function normalize(path) {
  return path.split('\\').join('/');
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Added lines in the index, as {path, line, text}.
 *
 * Only added lines: a line that was already committed is a different problem
 * from one being introduced now, and rescanning history on every commit would
 * make the hook slow enough to be turned off.
 */
function stagedAdditions() {
  const diff = git(['diff', '--cached', '-U0', '--diff-filter=ACM']);
  const additions = [];
  let path = null;
  let lineNumber = 0;

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      path = raw === '+++ /dev/null' ? null : raw.slice(6);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (hunk) {
      lineNumber = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith('+') && !raw.startsWith('+++') && path) {
      additions.push({ path, line: lineNumber, text: raw.slice(1) });
      lineNumber += 1;
    }
  }
  return additions;
}

function wholeFiles(paths) {
  const lines = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const content = readFileSync(path, 'utf8');
    content.split('\n').forEach((text, index) => lines.push({ path, line: index + 1, text }));
  }
  return lines;
}

function scan(lines, rules, allowed) {
  const findings = [];

  for (const { path, line, text } of lines) {
    if (allowed.some((pattern) => pattern.test(normalize(path)))) continue;
    // A line naming only fake values is the shape CLAUDE.md asks for, not a leak.
    const stripped = FAKE_ALLOWED.reduce((acc, fake) => acc.split(fake).join(''), text);

    for (const rule of rules) {
      if (rule.regex.test(stripped)) findings.push({ rule: rule.id, path, line });
    }
  }
  return findings;
}

function stagedPaths() {
  return git(['diff', '--cached', '--name-only', '--diff-filter=ACM'])
    .split('\n')
    .filter((path) => path.length > 0);
}

// -- main ---------------------------------------------------------------------

const args = process.argv.slice(2);
const staged = args.includes('--staged');
const targets = args.filter((arg) => !arg.startsWith('--'));

const rules = [...BUILT_IN, ...projectRules()];
const allowed = allowedPaths();

const forbidden = (staged ? stagedPaths() : targets).filter((path) =>
  FORBIDDEN_PATHS.some((pattern) => pattern.test(normalize(path))),
);

const findings = scan(
  staged ? stagedAdditions() : wholeFiles(targets),
  rules,
  allowed,
);

if (forbidden.length === 0 && findings.length === 0) {
  console.log(`scan-secrets: clean (${rules.length} rules)`);
  process.exit(0);
}

for (const path of forbidden) {
  console.error(`scan-secrets: ${path} must never be committed`);
}
for (const { rule, path, line } of findings) {
  // The match itself is deliberately absent. Open the file.
  console.error(`scan-secrets: ${rule} at ${path}:${line}`);
}

console.error('');
console.error('Fix it, or if this is a false positive, re-run with SKIP_SECRET_SCAN=1');
console.error('and say why in the commit message. Do not make that a habit.');
process.exit(1);
