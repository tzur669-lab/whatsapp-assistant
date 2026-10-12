/**
 * The screen agent's risk policy (PLAN §6.28) against the shared fixture. The
 * app runs the same file in `ScreenLogicTest`, so a list or a rule that drifts
 * on either side fails there or here.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GENERIC_WORDS,
  higherClass,
  normalizeLabel,
  riskClass,
  SEARCH_WORDS,
  SENSITIVE_WORDS,
  usableScreen,
} from '../../../src/agent/screen-policy.js';
import type { PolicyAction, PolicyElement, RiskClass, RiskWhy } from '../../../src/agent/screen-policy.js';

type Vector = {
  name: string;
  action: PolicyAction;
  el: PolicyElement | null;
  ctx: { askEveryTap?: boolean; typedNonSearch?: boolean };
  cls: RiskClass;
  why: RiskWhy | null;
};

const fixture = JSON.parse(readFileSync(new URL('../../fixtures/screen-policy.json', import.meta.url), 'utf8')) as {
  sensitive: string[];
  generic: string[];
  search: string[];
  vectors: Vector[];
};

describe('screen policy parity with the shared fixture', () => {
  it('keeps the same word lists as the fixture', () => {
    expect([...SENSITIVE_WORDS]).toEqual(fixture.sensitive);
    expect([...GENERIC_WORDS]).toEqual(fixture.generic);
    expect([...SEARCH_WORDS]).toEqual(fixture.search);
  });

  it('has enough vectors to mean something', () => {
    expect(fixture.vectors.length).toBeGreaterThanOrEqual(20);
  });

  for (const vector of fixture.vectors) {
    it(`classes: ${vector.name}`, () => {
      expect(riskClass(vector.action, vector.el, vector.ctx)).toEqual({ cls: vector.cls, why: vector.why });
    });
  }
});

describe('screen policy rules', () => {
  it('normalizes niqqud, bidi marks, camelCase and punctuation', () => {
    expect(normalizeLabel('\u200fשְׁלַח!')).toBe('שלח');
    expect(normalizeLabel('btnSendNow')).toBe('btn send now');
    expect(normalizeLabel('  confirm_order  ')).toBe('confirm order');
  });

  it('lets the higher class win', () => {
    expect(higherClass('safe', 'uncertain')).toBe('uncertain');
    expect(higherClass('sensitive', 'uncertain')).toBe('sensitive');
    expect(higherClass('safe', 'safe')).toBe('safe');
  });

  it('asks before a generic continue even when the model is sure', () => {
    expect(riskClass('tap', { t: 'המשך', f: 'c' }, {}).cls).toBe('uncertain');
  });

  it('calls a screen with no labelled clickable element unusable, and a thin labelled one usable', () => {
    expect(usableScreen([{ t: 'שלום', f: '' }, { f: 'c' }])).toBe(false);
    expect(usableScreen([])).toBe(false);
    expect(usableScreen([{ v: 'menu', f: 'c' }])).toBe(true);
    expect(usableScreen([{ t: 'חפש', f: 'c' }])).toBe(true);
  });
});
