/**
 * Every tool names the data its replies may carry (2026-10-08, smart
 * conversations, slice 1). The source is decided by what a reply, a resolve
 * outcome, a confirmation card, a candidate list or an Undo text may hold —
 * not by whether the tool reads or writes.
 */
import { describe, expect, it } from 'vitest';
import { dataSourceOf, REGISTRY, TOOL_NAMES } from '../../../src/tools/registry.js';
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
