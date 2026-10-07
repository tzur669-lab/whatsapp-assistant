/**
 * Tool selection by code (PLAN §6.19 §4, 2026-10-06). Zero tokens: the fixture
 * and the eval corpus run through the selector, and a single wrong group — one
 * that would hide the tool a request needs — is a failure.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { GROUPS, groupOf, matchGroups, selectionLabel, selectTools } from '../../../src/agent/tool-groups.js';
import type { GroupName } from '../../../src/agent/tool-groups.js';
import { agentToolNames } from '../../../src/agent/tools.js';
import { TOOL_NAMES } from '../../../src/tools/registry.js';
import type { ToolName } from '../../../src/tools/registry.js';

/** `allow`: a group, a union written `a+b` in group order, or `full`. */
type Case = { text: string; allow: string[] };
type CorpusCase = { id: string; input: string; expect: { intent: string } };

const root = resolve(__dirname, '../../..');
const fixture = parseYaml(readFileSync(resolve(root, 'test/fixtures/tool-selection.he.yaml'), 'utf8')) as Record<string, Case[]>;
// The whole corpus, phone and personal cases included (block H's 100% gate).
const corpus = readdirSync(resolve(root, 'test/evals'))
  .filter((file) => /^cases\..+\.yaml$/.test(file))
  .flatMap(
  (file) => parseYaml(readFileSync(resolve(root, 'test/evals', file), 'utf8')) as CorpusCase[],
);

const everything = agentToolNames({ cards: true, fileCards: true, phoneReads: true, grants: { gmail: true, tasks: true, drive: true } });

/** `time`, `mail+time` (fixed group order), or `full`. */
function selected(text: string): string {
  return selectionLabel(selectTools(text, everything));
}

describe('groups', () => {
  it('puts every registry tool in exactly one group', () => {
    for (const tool of TOOL_NAMES) {
      const owners = (Object.keys(GROUPS) as GroupName[]).filter((group) => GROUPS[group].includes(tool));
      expect(owners, tool).toHaveLength(1);
    }
    expect(Object.values(GROUPS).flat()).toHaveLength(TOOL_NAMES.length);
  });

  it('never offers more than agentToolNames', () => {
    const narrow = agentToolNames({ cards: false });
    for (const text of ['תתקשר לאמא', 'יש מייל חדש?', 'מה מזג האוויר?', 'כן']) {
      const { tools } = selectTools(text, narrow);
      expect(tools.every((tool) => narrow.includes(tool))).toBe(true);
    }
  });

  it('keeps the full set when the one group would leave nothing offered', () => {
    const noMail = agentToolNames({ cards: false });
    const selection = selectTools('יש מייל חדש מהבנק?', noMail);
    expect(selection.groups).toEqual([]);
    expect(selection.tools).toEqual(noMail);
  });

  it('keeps registry order', () => {
    const { tools } = selectTools('מה יש לי ביומן מחר?', everything);
    const order = (tool: ToolName) => TOOL_NAMES.indexOf(tool);
    expect([...tools].sort((a, b) => order(a) - order(b))).toEqual(tools);
  });
});

describe('unions (2026-10-07)', () => {
  it('offers the union of two named groups, nothing else', () => {
    const selection = selectTools('תשלח לדני מייל שאני מאחר לפגישה', everything);
    expect(selection.groups).toEqual(['time', 'mail', 'phone']);
    expect(selection.tools).toContain('mail.draft');
    expect(selection.tools).toContain('reminders.create');
    expect(selection.tools).not.toContain('notes.save');
  });

  it('keeps the full set when any matched group is mostly unavailable', () => {
    const noCards = agentToolNames({ cards: false, grants: { gmail: true } });
    // "תעיר אותי" is phone (alarm, a card) and "מייל" is mail: phone has too
    // little here, so the reminder that can wake the user stays offered.
    const selection = selectTools('תעיר אותי מחר ותבדוק מייל', noCards);
    expect(selection.groups).toEqual([]);
    expect(selection.tools).toEqual(noCards);
  });

  it('keeps the full set for four groups or more', () => {
    const selection = selectTools('תזכיר לי מחר לשלוח מייל עם הקובץ ולרשום את ההוצאה', everything);
    expect(matchGroups('תזכיר לי מחר לשלוח מייל עם הקובץ ולרשום את ההוצאה').length).toBeGreaterThanOrEqual(4);
    expect(selection.groups).toEqual([]);
  });
});

describe('the selection fixture', () => {
  for (const [section, cases] of Object.entries(fixture)) {
    for (const testCase of cases) {
      it(`${section}: ${testCase.text}`, () => {
        expect(testCase.allow, `matched ${matchGroups(testCase.text).join(',') || 'none'}`).toContain(selected(testCase.text));
      });
    }
  }
});

describe('the eval corpus', () => {
  // The 100% gate (block H): every tool a case expects is offered.
  it("never narrows a case to groups without its expected tool", () => {
    const wrong = corpus.filter((testCase) => {
      const tool = testCase.expect.intent as ToolName;
      if (!TOOL_NAMES.includes(tool)) return false;
      const { groups } = selectTools(testCase.input, everything);
      const owner = groupOf(tool);
      return groups.length > 0 && (owner === null || !groups.includes(owner));
    });
    expect(wrong.map((c) => `${c.id}: ${matchGroups(c.input).join(',')}`)).toEqual([]);
  });
});
