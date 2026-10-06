#!/usr/bin/env node
/**
 * Keeps HANDOFF.md / ARCHITECTURE.md in step with the code (CLAUDE.md, "Before
 * starting any task"). Two modes, wired in .claude/settings.json:
 *
 *   start  SessionStart: remember the commit this session began at.
 *   stop   Stop: if code, schema, config or ROADMAP changed since then and
 *          neither HANDOFF.md nor ARCHITECTURE.md did, block once and ask the
 *          session to update them (or to say why nothing needs updating).
 *
 * It blocks at most once per distinct set of changes, never while a Stop hook
 * is already active, and fails open: any error lets the session stop.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const RELEVANT = [
  /^src\//,
  /^migrations\//,
  /^apps\/call-companion\/app\/src\/main\//,
  /^apps\/call-companion\/app\/build\.gradle\.kts$/,
  /^wrangler\.jsonc$/,
  /^package\.json$/,
  /^ROADMAP\.md$/,
  /^\.claude\/skills\//,
];
const DOCS = ['HANDOFF.md', 'ARCHITECTURE.md'];

const mode = process.argv[2];
const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function git(args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

/** Every file that differs from `base` (tracked or new), with a hash of its current content. */
function dirtyFiles(base) {
  const names = new Set([
    ...git(['-c', 'core.quotepath=false', 'diff', '--name-only', base]).split('\n'),
    ...git(['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard']).split('\n'),
  ]);
  names.delete('');
  const out = {};
  for (const name of names) {
    const path = join(cwd, name);
    out[name] = existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'deleted';
  }
  return out;
}

function main() {
  const input = readInput();
  const session = String(input.session_id || 'unknown').replace(/[^A-Za-z0-9_-]/g, '');
  const dir = join(tmpdir(), 'claude-docs-guard');
  mkdirSync(dir, { recursive: true });
  const stateFile = join(dir, `${session}.json`);
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};

  if (mode === 'start') {
    // A resumed or compacted session keeps its original starting point. Files
    // already dirty then (another session's work) are snapshotted, so only
    // what changes after this point counts against this session.
    if (!state.base) {
      const base = git(['rev-parse', 'HEAD']);
      writeFileSync(stateFile, JSON.stringify({ base, atStart: dirtyFiles(base) }));
    }
    return;
  }

  if (mode !== 'stop' || input.stop_hook_active || !state.base) return;

  const now = dirtyFiles(state.base);
  const atStart = state.atStart || {};
  const changed = Object.keys(now).filter((f) => now[f] !== atStart[f]);

  if (DOCS.some((d) => changed.includes(d))) return;
  const relevant = changed.filter((f) => RELEVANT.some((re) => re.test(f))).sort();
  if (relevant.length === 0) return;

  // Ask once per set of changes; a later, different change asks again.
  const key = createHash('sha256').update(relevant.map((f) => `${f}:${now[f]}`).join('\n')).digest('hex');
  if (state.lastAsked === key) return;
  writeFileSync(stateFile, JSON.stringify({ ...state, lastAsked: key }));

  const list = relevant.slice(0, 15).join(', ') + (relevant.length > 15 ? `, +${relevant.length - 15} more` : '');
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason:
      `Docs check (CLAUDE.md): this session changed ${list}, but HANDOFF.md and ARCHITECTURE.md are untouched. ` +
      'Before finishing, update what this work made stale: HANDOFF.md (status line versions/migration, §4 "touch X → watch Y", ' +
      '§6 next work, §7 docs map, §8 session log), ARCHITECTURE.md (modules, tools by tier, tables, coupling), and README.md ' +
      'if features or stack changed. Commit and push them with the work. If nothing there is affected, say so in one line ' +
      'in your final message and stop.',
  }));
}

try {
  main();
} catch {
  // Fail open: a broken check must never trap a session.
}
