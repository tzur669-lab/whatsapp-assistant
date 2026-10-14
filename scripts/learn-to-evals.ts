/**
 * The learning export → draft eval cases (block K, K4, PLAN §6.31).
 *
 * Reads the `bot-learn-YYYY-MM-DD.json` the app saved (☰ ← ייצוא למידה) and
 * writes, under `evals-private/` (gitignored):
 *
 * - `drafts/cases.learn-misses.draft.yaml` — every reported miss ("לא הבנת"):
 *   the user said the bot got it wrong, so each is a draft case.
 * - `candidates/learn-rephrases.yaml` — every heuristic pair: "this failed,
 *   then this rephrase ran these tools". NEVER a case until a human confirms
 *   the two really are the same request; then it moves to `drafts/` by hand.
 *
 * The export is scrubbed (phones, emails, links, codes, long numbers) but not
 * anonymized: names, addresses and places stay. So nothing written here is
 * committed as it is — a human rewrites each input with fake values, fills
 * in `expect`, and only then moves it into `test/evals/`. The `learn-review`
 * skill (`.claude/skills/learn-review/SKILL.md`) drives the whole loop.
 *
 *   tsx scripts/learn-to-evals.ts <bot-learn-YYYY-MM-DD.json>
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { z } from 'zod';

const OUT_DIR = 'evals-private';
const DRAFTS = `${OUT_DIR}/drafts/cases.learn-misses.draft.yaml`;
const CANDIDATES = `${OUT_DIR}/candidates/learn-rephrases.yaml`;

const turnSchema = z.object({
  user: z.string(),
  reply: z.string(),
  outcome: z.string(),
  intent: z.string().nullable(),
});
const recordSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('miss'), at: z.string(), confidence: z.literal('reported'), failed: turnSchema }),
  z.object({
    type: z.literal('pair'),
    at: z.string(),
    confidence: z.literal('heuristic'),
    gapSeconds: z.number(),
    tools: z.array(z.string()),
    failed: turnSchema,
    fixed: turnSchema,
  }),
]);
const exportSchema = z.object({
  schema: z.literal(1),
  exportedAt: z.string(),
  records: z.array(recordSchema),
  truncated: z.object({ pairs: z.number(), misses: z.number() }),
  taps: z.array(z.object({ tool: z.string(), undo: z.number(), confirmNo: z.number(), medianSeconds: z.number().nullable() })),
  leave: z.object({ count: z.number(), stated: z.number(), medianStatedMinutes: z.number().nullable() }),
  weeks: z.array(z.object({ week: z.string(), messages: z.number(), misses: z.number(), rephrases: z.number() })),
  proposals: z.array(z.object({ kind: z.string(), status: z.string(), count: z.number() })),
});

/** A path, not a secret: anything that looks like a key, token or JSON blob is refused and never echoed. */
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
const quote = (text: string) => JSON.stringify(text);

function main(): void {
  const arg = process.argv[2];
  if (!arg) {
    err('usage: tsx scripts/learn-to-evals.ts <bot-learn-YYYY-MM-DD.json>');
    process.exit(2);
  }
  if (looksLikeSecret(arg)) {
    err('That argument does not look like a file path. Nothing was read.');
    process.exit(2);
  }

  const parsed = exportSchema.safeParse(JSON.parse(readFileSync(resolve(arg), 'utf8')));
  if (!parsed.success) {
    err(`${basename(arg)} is not a learning export (schema 1). Nothing was written.`);
    process.exit(1);
  }
  const data = parsed.data;
  const day = data.exportedAt.slice(0, 10);
  const now = `${day}T10:00:00+03:00`;

  const misses = data.records.filter((r) => r.type === 'miss');
  const pairs = data.records.filter((r) => r.type === 'pair');

  const drafts = misses.map((record, index) =>
    [
      `- id: learn-${day}-m${String(index + 1).padStart(3, '0')}`,
      `  now: ${quote(now)}`,
      `  input: ${quote(record.failed.user)}`,
      `  # bot answered (${record.failed.outcome}): ${quote(record.failed.reply.slice(0, 160))}`,
      '  expect:',
      '    intent: TODO',
      '    missing: []',
    ].join('\n'),
  );
  const candidates = pairs.map((record, index) =>
    [
      `- id: learn-${day}-r${String(index + 1).padStart(3, '0')}`,
      `  confidence: heuristic   # confirm it is the same request before it becomes a case`,
      `  gap_seconds: ${record.gapSeconds}`,
      `  failed: ${quote(record.failed.user)}`,
      `  failed_outcome: ${quote(record.failed.outcome)}`,
      `  rephrase: ${quote(record.fixed.user)}`,
      `  rephrase_tools: [${record.tools.map(quote).join(', ')}]`,
    ].join('\n'),
  );

  const header = [
    '# DRAFTS — real words from the learning export (scrubbed, NOT anonymized).',
    '# Rewrite every input with fake values and fill in `expect` before moving',
    '# a case into test/evals/. Never commit this file. Delete the export after.',
    '',
  ];
  mkdirSync(`${OUT_DIR}/drafts`, { recursive: true });
  mkdirSync(`${OUT_DIR}/candidates`, { recursive: true });
  writeFileSync(DRAFTS, [...header, drafts.join('\n\n'), ''].join('\n'), 'utf8');
  writeFileSync(CANDIDATES, [...header, candidates.join('\n\n'), ''].join('\n'), 'utf8');

  out(`${drafts.length} draft case(s) from reported misses → ${resolve(DRAFTS)}`);
  out(`${candidates.length} candidate pair(s), heuristic, NOT cases → ${resolve(CANDIDATES)}`);
  if (data.truncated.pairs + data.truncated.misses > 0) {
    out(`The export was cut at 256 KB: ${data.truncated.pairs} pair(s) and ${data.truncated.misses} miss(es) left out.`);
  }
  out('Undo / "no" taps per tool:');
  for (const tap of data.taps) out(`  ${tap.tool}: undo ${tap.undo}, no ${tap.confirmNo}, median ${tap.medianSeconds ?? '-'} s`);
  out(`Leave: ${data.leave.count} set, ${data.leave.stated} with a stated time, median ${data.leave.medianStatedMinutes ?? '-'} min.`);
  out(`Weeks: ${data.weeks.map((w) => `${w.week} ${w.messages}/${w.misses}/${w.rephrases}`).join(', ') || 'none'} (messages/misses/rephrases).`);
  out(`Proposals: ${data.proposals.map((p) => `${p.kind} ${p.status} ${p.count}`).join(', ') || 'none'}.`);
  out('WARNING: the drafts hold real words. Rewrite before committing.');
}

main();
