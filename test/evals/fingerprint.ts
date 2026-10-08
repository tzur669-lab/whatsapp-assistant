/**
 * The eval fingerprint (PLAN §6.19, 2026-10-06): the environment a model was
 * judged in. A `canWrite` model whose recorded fingerprint no longer matches
 * was judged on a different prompt, catalog, request or selection, and must be
 * evaluated again before it may write.
 *
 * Behavior, not source: the selection part hashes what `selectTools` offers for
 * every phrase in the eval corpus and the selection fixture — the same scope
 * the eval itself covers. A code change that offers nothing different on those
 * phrases does not invalidate an eval.
 *
 * Node only (`node:crypto`): used by the eval scripts and the unit test, never
 * by the Worker.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { ModelEntry } from '../../src/agent/models.js';
import { SMART_NOTE, SMART_NOTE_VERSION, SYSTEM_PROMPT } from '../../src/agent/prompt.js';
import { ADAPTER_VERSION } from '../../src/agent/provider.js';
import { selectTools } from '../../src/agent/tool-groups.js';
import { agentToolNames, smartOfferedTools, wireTools } from '../../src/agent/tools.js';

const FULL = { cards: true, fileCards: true, phoneReads: true, grants: { gmail: true, tasks: true, drive: true } };

/** Every phrase the eval and the selection fixture use, in a fixed order. */
export function fingerprintPhrases(): string[] {
  const at = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
  const phrases: string[] = [];
  for (const file of ['cases.he.yaml', 'cases.en.yaml', 'cases.phone.yaml']) {
    const cases = parseYaml(readFileSync(at(file), 'utf8')) as Array<{ input: string }> | null;
    for (const c of cases ?? []) phrases.push(c.input);
  }
  const fixture = parseYaml(readFileSync(at('../fixtures/tool-selection.he.yaml'), 'utf8')) as Record<string, Array<{ text: string }>>;
  for (const section of Object.values(fixture)) for (const c of section) phrases.push(c.text);
  return phrases;
}

export function fingerprintFor(entry: ModelEntry): string {
  const offered = agentToolNames(FULL);
  const hash = createHash('sha256');
  hash.update(SYSTEM_PROMPT);
  hash.update('\0');
  hash.update(JSON.stringify(wireTools(offered)));
  hash.update('\0');
  hash.update(JSON.stringify({ maxCompletionTokens: entry.maxCompletionTokens, params: entry.params }));
  hash.update('\0');
  hash.update(ADAPTER_VERSION);
  hash.update('\0');
  for (const phrase of fingerprintPhrases()) {
    hash.update(JSON.stringify(selectTools(phrase, offered).tools));
    hash.update('\n');
  }
  return hash.digest('hex').slice(0, 16);
}

/**
 * The catalog policy of a smart model's turn (smart conversations, 2026-10-08):
 * no selection, and what `smartOfferedTools` keeps for a typed turn that may
 * ask for consent — public tools and every consent source's, never a private
 * one (slice 5). Bumped by hand when the policy changes, like `ADAPTER_VERSION`.
 */
export const SMART_CATALOG_POLICY = 'smart-catalog/public-and-consent-sources/no-selection/2';

/**
 * The environment a smart model is judged in: the system prompt with the smart
 * note and its version, the smart catalog and its policy, the request and the
 * adapter. Separate from `fingerprintFor`, so the Groq fingerprint does not
 * move when the smart note does. No selection part: a smart turn has none.
 */
export function smartFingerprintFor(entry: ModelEntry): string {
  const offered = smartOfferedTools(agentToolNames(FULL), { granted: [], ask: true });
  const hash = createHash('sha256');
  hash.update('smart\0');
  hash.update(SYSTEM_PROMPT);
  hash.update('\0');
  hash.update(SMART_NOTE_VERSION);
  hash.update('\0');
  hash.update(SMART_NOTE);
  hash.update('\0');
  hash.update(SMART_CATALOG_POLICY);
  hash.update('\0');
  hash.update(JSON.stringify(wireTools(offered)));
  hash.update('\0');
  hash.update(JSON.stringify({ maxCompletionTokens: entry.maxCompletionTokens, params: entry.params }));
  hash.update('\0');
  hash.update(ADAPTER_VERSION);
  return hash.digest('hex').slice(0, 16);
}
