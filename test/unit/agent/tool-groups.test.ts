/**
 * Tool selection by code (PLAN §6.19 §4, 2026-10-06). Zero tokens: the fixture
 * and the eval corpus run through the selector, and a single wrong group — one
 * that would hide the tool a request needs — is a failure.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { GROUPS, groupOf, matchGroups, selectTools } from '../../../src/agent/tool-groups.js';
import type { GroupName } from '../../../src/agent/tool-groups.js';
import { agentToolNames } from '../../../src/agent/tools.js';
import { TOOL_NAMES } from '../../../src/tools/registry.js';
import type { ToolName } from '../../../src/tools/registry.js';

type Case = { text: string; allow: Array<GroupName | 'full'> };
type CorpusCase = { id: string; input: string; expect: { intent: string } };

const root = resolve(__dirname, '../../..');
const fixture = parseYaml(readFileSync(resolve(root, 'test/fixtures/tool-selection.he.yaml'), 'utf8')) as Record<string, Case[]>;
const corpus = ['cases.he.yaml', 'cases.en.yaml'].flatMap(
  (file) => parseYaml(readFileSync(resolve(root, 'test/evals', file), 'utf8')) as CorpusCase[],
);

const everything = agentToolNames({ cards: true, fileCards: true, phoneReads: true, grants: { gmail: true, tasks: true, drive: true } });

function selected(text: string): GroupName | 'full' {
  return selectTools(text, everything).group ?? 'full';
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
    expect(selection.group).toBeNull();
    expect(selection.tools).toEqual(noMail);
  });

  it('keeps registry order', () => {
    const { tools } = selectTools('מה יש לי ביומן מחר?', everything);
    const order = (tool: ToolName) => TOOL_NAMES.indexOf(tool);
    expect([...tools].sort((a, b) => order(a) - order(b))).toEqual(tools);
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
  it("never narrows a case to a group without its expected tool", () => {
    const wrong = corpus.filter((testCase) => {
      const tool = testCase.expect.intent as ToolName;
      if (!TOOL_NAMES.includes(tool)) return false;
      const choice = selected(testCase.input);
      return choice !== 'full' && choice !== groupOf(tool);
    });
    expect(wrong.map((c) => `${c.id}: ${matchGroups(c.input).join(',')}`)).toEqual([]);
  });
});
