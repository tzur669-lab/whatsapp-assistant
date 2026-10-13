/**
 * Inherited tool groups (block J, J2a): a short follow-up that names no group
 * is offered the groups of the previous local turn, when that turn ran a tool
 * from them, within 10 minutes. Only ever a narrowing of what is offered.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../../src/core/repo.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import { INHERIT_WINDOW_MS, LastSelections, mayInherit } from '../../../src/agent/last-selection.js';
import { GROUPS, selectTools } from '../../../src/agent/tool-groups.js';
import { agentToolNames } from '../../../src/agent/tools.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';

const NOW = Date.parse('2026-09-24T09:00:00Z');
const P = 'p_sel';
const C = 'conv-1';

describe('LastSelections', () => {
  let driver: TestSqlDriver;
  let clock: number;
  let store: LastSelections;

  beforeEach(() => {
    driver = new TestSqlDriver();
    new Repository(driver).migrate(MIGRATIONS);
    clock = NOW;
    store = new LastSelections(driver, () => clock);
  });
  afterEach(() => driver.close());

  it('inherits nothing until the turn that chose the groups ran a tool from them', () => {
    store.record(P, C, 5, ['time'], false);
    expect(store.inherited(P, C)).toBeNull();
    store.markRan(P, C, 5, ['calendar.list_events']);
    expect(store.inherited(P, C)).toEqual(['time']);
  });

  it('is not marked by a tool outside the groups', () => {
    store.record(P, C, 5, ['time'], false);
    store.markRan(P, C, 5, ['calendar.list_events', 'mail.search']);
    expect(store.inherited(P, C)).toBeNull();
  });

  it('is not marked by an empty tool list', () => {
    store.record(P, C, 5, ['time'], false);
    store.markRan(P, C, 5, []);
    expect(store.inherited(P, C)).toBeNull();
  });

  it('ends after the window', () => {
    store.record(P, C, 5, ['time'], false);
    store.markRan(P, C, 5, ['reminders.list']);
    clock = NOW + INHERIT_WINDOW_MS + 1;
    expect(store.inherited(P, C)).toBeNull();
  });

  it('never inherits a turn that started tainted', () => {
    store.record(P, C, 5, ['time'], true);
    store.markRan(P, C, 5, ['reminders.list']);
    expect(store.inherited(P, C)).toBeNull();
  });

  it('never inherits the full set: a full turn overwrites the earlier groups', () => {
    store.record(P, C, 5, ['time'], false);
    store.markRan(P, C, 5, ['reminders.list']);
    store.record(P, C, 6, [], false);
    store.markRan(P, C, 6, ['reminders.list']);
    expect(store.inherited(P, C)).toBeNull();
  });

  it('never stores the routine or screen groups', () => {
    store.record(P, C, 5, ['phone', 'screen'], false);
    store.markRan(P, C, 5, ['app.open']);
    expect(store.inherited(P, C)).toEqual(['phone']);
  });

  it('an older turn never overwrites or marks a newer one', () => {
    store.record(P, C, 7, ['mail'], false);
    store.record(P, C, 6, ['time'], false);
    store.markRan(P, C, 6, ['reminders.list']);
    expect(store.inherited(P, C)).toBeNull();
    store.markRan(P, C, 7, ['mail.search']);
    expect(store.inherited(P, C)).toEqual(['mail']);
  });

  it('keeps each conversation apart', () => {
    store.record(P, C, 5, ['time'], false);
    store.markRan(P, C, 5, ['reminders.list']);
    expect(store.inherited(P, 'conv-2')).toBeNull();
  });

  it('purges rows past the window', () => {
    store.record(P, C, 5, ['time'], false);
    clock = NOW + INHERIT_WINDOW_MS + 1;
    store.purgeExpired();
    expect(driver.exec('SELECT COUNT(*) AS n FROM last_selection')[0]?.['n']).toBe(0);
  });
});

describe('mayInherit', () => {
  it('only a short message that names no group', () => {
    expect(mayInherit('ובעוד שעה?')).toBe(true);
    expect(mayInherit('תבטל אותה')).toBe(true);
    expect(mayInherit('ומה עם יום ראשון בבוקר אחרי העבודה שלי')).toBe(false);
    expect(mayInherit('מה יש לי ביומן מחר')).toBe(false);
  });
});

describe('selectTools with inherited groups', () => {
  const offered = agentToolNames({ cards: true, fileCards: true, phoneReads: true, grants: { gmail: true, tasks: true, drive: true } });

  it('narrows a message that names nothing to the inherited groups', () => {
    const selection = selectTools('תבטל אותה', offered, ['time']);
    expect(selection.groups).toEqual(['time']);
    expect(selection.tools).toEqual(offered.filter((tool) => GROUPS.time.includes(tool)));
  });

  it('words that name a group win over inheritance', () => {
    expect(selectTools('מה המייל האחרון', offered, ['time']).groups).toEqual(['mail']);
  });

  it('never adds a tool not offered', () => {
    const noMail = agentToolNames({ cards: true });
    const selection = selectTools('תבטל אותה', noMail, ['time', 'mail']);
    expect(selection.tools.every((tool) => noMail.includes(tool))).toBe(true);
    // A group mostly unavailable keeps the full set, as for named words.
    expect(selection.groups).toEqual([]);
  });

  it('without inheritance a message that names nothing is the full set, as before', () => {
    expect(selectTools('תבטל אותה', offered).groups).toEqual([]);
  });
});
