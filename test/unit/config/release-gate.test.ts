/**
 * The release gate in the committed config (2026-10-12, docs/IMPROVEMENT_PLAN.md
 * T2 step 5): production may not turn the agent on while its primary model has
 * no write-gate eval recorded for the environment the bot runs now.
 *
 * It reads `wrangler.jsonc`, not a deploy: a `wrangler deploy` from a dirty
 * tree is a human's step (ops/runbook.md, "Release gate").
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MODELS } from '../../../src/agent/models.js';
import type { ModelEntry } from '../../../src/agent/models.js';
import { fingerprintFor, judgingHash } from '../../evals/fingerprint.js';

type Config = { env?: Record<string, { vars?: Record<string, unknown> } | undefined> };

/** JSONC to JSON: drops comments and trailing commas outside strings. */
function parseJsonc(text: string): unknown {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) throw new Error('unterminated comment');
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as unknown;
}

/** Why this config may not ship to production, or null when it may. */
function releaseGateProblem(config: Config, models: readonly ModelEntry[], judging: string): string | null {
  if (config.env?.production?.vars?.AGENT !== 'on') return null;
  const primary = models.find((entry) => entry.role === 'primary');
  if (!primary) return 'production AGENT is "on" but no model is the primary';
  const evaluated = primary.evaluated;
  if (!evaluated) return `production AGENT is "on" but ${primary.id} has no evaluated --select-tools run`;
  if (evaluated.fingerprint !== fingerprintFor(primary)) return `production AGENT is "on" but ${primary.id} was evaluated in another environment`;
  if (evaluated.judging !== judging) return `production AGENT is "on" but ${primary.id}'s eval was judged by other expectations or thresholds`;
  return null;
}

const production = (agent: string): Config => ({ env: { production: { vars: { AGENT: agent } } } });

describe('the release gate in wrangler.jsonc', () => {
  it('holds for the committed config', () => {
    const config = parseJsonc(readFileSync(fileURLToPath(new URL('../../../wrangler.jsonc', import.meta.url)), 'utf8')) as Config;
    expect(config.env?.production?.vars?.AGENT, 'wrangler.jsonc has no production AGENT').toBeTypeOf('string');
    expect(releaseGateProblem(config, MODELS, judgingHash())).toBeNull();
  });

  it('refuses AGENT=on in production without a matching evaluated primary', () => {
    const primary = MODELS.find((entry) => entry.role === 'primary')!;
    const judging = judgingHash();
    const { evaluated: _none, ...bare } = primary;
    expect(releaseGateProblem(production('on'), [bare], judging)).toMatch(/no evaluated/);
    const stale = { ...primary, evaluated: { fingerprint: '0000000000000000', date: '2026-10-12', judging } };
    expect(releaseGateProblem(production('on'), [stale], judging)).toMatch(/another environment/);
    const misjudged = { ...primary, evaluated: { fingerprint: fingerprintFor(primary), date: '2026-10-12', judging: 'old' } };
    expect(releaseGateProblem(production('on'), [misjudged], judging)).toMatch(/judged by other/);
    const current = { ...primary, evaluated: { fingerprint: fingerprintFor(primary), date: '2026-10-12', judging } };
    expect(releaseGateProblem(production('on'), [current], judging)).toBeNull();
    expect(releaseGateProblem(production('off'), [bare], judging)).toBeNull();
  });

  it('reads JSONC: comments and trailing commas, never inside a string', () => {
    const parsed = parseJsonc('{\n  // note\n  "url": "https://x.example/a//b", /* c */\n  "list": [1, 2,],\n}');
    expect(parsed).toEqual({ url: 'https://x.example/a//b', list: [1, 2] });
  });
});
