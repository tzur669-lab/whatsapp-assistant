/**
 * Every tool names the data its replies may carry (2026-10-08, smart
 * conversations, slice 1). The source is decided by what a reply, a resolve
 * outcome, a confirmation card, a candidate list or an Undo text may hold —
 * not by whether the tool reads or writes.
 */
import { describe, expect, it } from 'vitest';
import { consentRuleOf, dataSourceOf, REGISTRY, TOOL_NAMES } from '../../../src/tools/registry.js';
import type { DataSource, ToolName, ToolSpec } from '../../../src/tools/registry.js';

const SOURCES: readonly DataSource[] = [
  'calendar',
  'reminders',
  'tasks',
  'mail',
  'drive',
  'birthdays',
  'contacts',
  'sms',
  'calls',
  'notifications',
  'expenses',
  'public',
  'private',
];

describe('dataSource', () => {
  it('every registered tool has one, from the closed set', () => {
    for (const name of TOOL_NAMES) {
      expect(SOURCES, name).toContain(REGISTRY[name].dataSource);
      expect(dataSourceOf(name)).toBe(REGISTRY[name].dataSource);
    }
  });

  it('a tool spec without a source does not compile', () => {
    const spec = REGISTRY['calc.compute'];
    const { dataSource: _dropped, ...rest } = spec;
    // @ts-expect-error -- `dataSource` is required on every ToolSpec.
    const broken: ToolSpec = rest;
    expect(broken.name).toBe('calc.compute');
  });

  it('tools that read an event are calendar, whatever their prefix', () => {
    // reminders.leave reads the event's title and start; nav.go can take the
    // event's location as its destination.
    expect(dataSourceOf('reminders.leave')).toBe('calendar');
    expect(dataSourceOf('nav.go')).toBe('calendar');
    for (const name of TOOL_NAMES.filter((n) => n.startsWith('calendar.'))) {
      expect(dataSourceOf(name), name).toBe('calendar');
    }
  });

  it('notes, lists, the portfolio and facts are private', () => {
    const privateTools = TOOL_NAMES.filter((n) => /^(notes|lists|portfolio|memory)\./.test(n));
    expect(privateTools.length).toBeGreaterThan(0);
    for (const name of privateTools) expect(dataSourceOf(name), name).toBe('private');
  });

  it('public data and arithmetic are public', () => {
    expect(dataSourceOf('info.lookup')).toBe('public');
    expect(dataSourceOf('calc.compute')).toBe('public');
    // A public page, the link the user's own (block J, J3); it taints instead.
    expect(dataSourceOf('web.read')).toBe('public');
  });

  it('the rest map to their own source', () => {
    const expected: Partial<Record<ToolName, DataSource>> = {
      'reminders.create': 'reminders',
      'reminders.list': 'reminders',
      'reminders.cancel': 'reminders',
      'reminders.scheduled_read': 'reminders',
      'tasks.list': 'tasks',
      'mail.search': 'mail',
      'mail.draft': 'mail',
      'mail.bills': 'mail',
      'drive.search': 'drive',
      'birthdays.upcoming': 'birthdays',
      'phone.contacts': 'contacts',
      'calls.place': 'contacts',
      'message.compose': 'contacts',
      'phone.sms': 'sms',
      'phone.calls': 'calls',
      'phone.notifications': 'notifications',
      'expenses.add': 'expenses',
      // Block J, J4: a watch's replies echo only its own call.
      'reminders.when': 'reminders',
      'expenses.summary': 'expenses',
      'expenses.export': 'expenses',
    };
    for (const [name, source] of Object.entries(expected)) {
      expect(dataSourceOf(name as ToolName), name).toBe(source);
    }
  });

  it('a private source and the `private` flag agree', () => {
    for (const name of TOOL_NAMES) {
      if (REGISTRY[name].private) expect(dataSourceOf(name), name).toBe('private');
    }
  });
});

/**
 * The consent rule (2026-10-11): whether a smart conversation asks before a
 * tool of a consent source runs. Exempt only when every reply holds nothing but
 * the call's own arguments, computed dates and times, and fixed strings —
 * proved per tool by reading its resolve, preview, execute and render code.
 */
describe('consent', () => {
  /** Pinned: a tool joins this list only with that proof, in review. */
  const EXEMPT: readonly ToolName[] = [
    'reminders.create',
    'reminders.repeat',
    'reminders.at_rest',
    'reminders.scheduled_read',
    'calendar.create_event',
    'expenses.add',
    // Block J, J4: created, cancelled, full or a question, from its own words
    // and a code-computed end date only; never a found mail or notification.
    'reminders.when',
  ];

  it('every consent-source tool has a rule; a public or private tool has none', () => {
    for (const name of TOOL_NAMES) {
      const source = dataSourceOf(name);
      if (source === 'public' || source === 'private') expect(consentRuleOf(name), name).toBeNull();
      else expect(['always', 'exempt-own-input'], name).toContain(consentRuleOf(name));
    }
  });

  it('exempts exactly the writes whose replies echo only their own call', () => {
    expect(TOOL_NAMES.filter((name) => consentRuleOf(name) === 'exempt-own-input').sort()).toEqual([...EXEMPT].sort());
  });

  it('never exempts a read, a phone read or action, or a tool confirmed off the chat', () => {
    for (const name of EXEMPT) {
      const spec = REGISTRY[name];
      expect(spec.tier, name).toBeGreaterThanOrEqual(1);
      expect(spec.phoneRead, name).toBeUndefined();
      expect(spec.confirmation, name).toBeUndefined();
      expect(spec.terminal, name).toBeUndefined();
    }
  });

  it('keeps asking for the borderline writes that show something of the source', () => {
    // tasks.add names the list it matched; expenses.export counts the rows;
    // calls.place's answer says whether a contact exists; message.compose's
    // contact is matched on the phone; reminders.leave and nav.go read an event.
    for (const name of ['tasks.add', 'expenses.export', 'calls.place', 'message.compose', 'reminders.leave', 'nav.go'] as const) {
      expect(consentRuleOf(name), name).toBe('always');
    }
  });

  it('a consent-source spec without a rule does not compile, nor a public one with a rule', () => {
    const spec = REGISTRY['reminders.create'];
    const { consent: _dropped, ...rest } = spec;
    // @ts-expect-error -- `consent` is required with a consent source.
    const missing: ToolSpec = rest;
    expect(missing.name).toBe('reminders.create');

    // @ts-expect-error -- a public tool has nothing to consent to.
    const extra: ToolSpec = { ...REGISTRY['calc.compute'], consent: 'always' };
    expect(extra.name).toBe('calc.compute');
  });
});
