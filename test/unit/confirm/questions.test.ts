/**
 * The open-question store (PLAN §6.11, §11.3). Test-first per CLAUDE.md.
 *
 * A clarification is the most common exchange in the whole system, so its
 * round-trip carries the same gates a confirmation does: same sender, expires,
 * one outstanding question at a time. It differs from a confirmation in what it
 * is allowed to do — an answer never executes anything by itself. It is merged
 * back into a draft, which is then resolved and judged by policy from scratch.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { OpenQuestions, QUESTION_EXPIRY_MS } from '../../../src/confirm/questions.js';
import { Repository } from '../../../src/core/repo.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';

const NOW = Date.UTC(2026, 8, 24, 18, 0, 0);
const SENDER = 'p_sender000000';
const OTHER = 'p_other0000000';

describe('OpenQuestions', () => {
  let driver: TestSqlDriver;
  let questions: OpenQuestions;
  let now = NOW;

  beforeEach(() => {
    now = NOW;
    driver = new TestSqlDriver();
    // Through the repository, which splits each file into its statements — a
    // raw exec runs only the first one.
    new Repository(driver).migrate(MIGRATIONS);
    questions = new OpenQuestions(driver, () => now);
  });

  it('remembers what was asked and what was already understood', () => {
    questions.open({
      principal: SENDER,
      tool: 'reminders.create',
      slots: { text: 'להתקשר לאבא', date: { kind: 'relative_days', offset: 1 } },
      asked: 'time',
      language: 'he',
    });

    const open = questions.peek(SENDER);
    expect(open?.tool).toBe('reminders.create');
    expect(open?.asked).toBe('time');
    expect(open?.language).toBe('he');
    expect(open?.slots).toEqual({ text: 'להתקשר לאבא', date: { kind: 'relative_days', offset: 1 } });
  });

  it('has nothing open for a sender who was never asked', () => {
    expect(questions.peek(SENDER)).toBeNull();
  });

  it('never shows one sender the question asked of another', () => {
    questions.open({
      principal: OTHER,
      tool: 'reminders.create',
      slots: { text: 'סוד' },
      asked: 'time',
      language: 'he',
    });
    expect(questions.peek(SENDER)).toBeNull();
  });

  it('keeps exactly one question per sender, so an answer can never match two', () => {
    questions.open({ principal: SENDER, tool: 'reminders.create', slots: { text: 'א' }, asked: 'time', language: 'he' });
    questions.open({ principal: SENDER, tool: 'calendar.create_event', slots: { title: 'ב' }, asked: 'date', language: 'he' });

    expect(questions.peek(SENDER)?.tool).toBe('calendar.create_event');
    expect(driver.exec('SELECT COUNT(*) AS n FROM open_questions')[0]?.['n']).toBe(1);
  });

  it('expires, because an answer to a question from an hour ago is not an answer', () => {
    questions.open({ principal: SENDER, tool: 'reminders.create', slots: {}, asked: 'time', language: 'he' });

    now = NOW + QUESTION_EXPIRY_MS - 1;
    expect(questions.peek(SENDER)).not.toBeNull();

    now = NOW + QUESTION_EXPIRY_MS + 1;
    expect(questions.peek(SENDER)).toBeNull();
  });

  it('clears on demand, so an unrelated message does not leave a stale question', () => {
    questions.open({ principal: SENDER, tool: 'reminders.create', slots: {}, asked: 'time', language: 'he' });
    questions.clear(SENDER);
    expect(questions.peek(SENDER)).toBeNull();
  });

  it('purges expired rows without touching live ones', () => {
    questions.open({ principal: SENDER, tool: 'reminders.create', slots: {}, asked: 'time', language: 'he' });
    now = NOW + QUESTION_EXPIRY_MS + 1;
    questions.open({ principal: OTHER, tool: 'reminders.create', slots: {}, asked: 'time', language: 'he' });

    questions.purgeExpired();

    expect(questions.peek(SENDER)).toBeNull();
    expect(questions.peek(OTHER)).not.toBeNull();
  });

  it('survives a stored row that is no longer valid JSON rather than throwing', () => {
    questions.open({ principal: SENDER, tool: 'reminders.create', slots: {}, asked: 'time', language: 'he' });
    driver.exec('UPDATE open_questions SET slots_json = ? WHERE principal = ?', '{not json', SENDER);
    expect(questions.peek(SENDER)).toBeNull();
  });

  it('refuses a stored row whose asked slot is not one code can answer', () => {
    // Defence in depth: the column is written by code, but a row that has
    // drifted must not steer a merge into a slot no tool declares.
    questions.open({ principal: SENDER, tool: 'reminders.create', slots: {}, asked: 'time', language: 'he' });
    driver.exec('UPDATE open_questions SET asked = ? WHERE principal = ?', 'permissions', SENDER);
    expect(questions.peek(SENDER)).toBeNull();
  });
});
