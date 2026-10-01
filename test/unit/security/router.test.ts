import { describe, expect, it } from 'vitest';
import { matchCommand } from '../../../src/core/router.js';

describe('matchCommand', () => {
  it('matches system commands exactly', () => {
    expect(matchCommand('/help')).toEqual({ kind: 'help' });
    expect(matchCommand('  /ping  ')).toEqual({ kind: 'ping' });
    expect(matchCommand('/STATUS')).toEqual({ kind: 'status' });
    expect(matchCommand('/connect google')).toEqual({ kind: 'connect_google', grant: 'calendar' });
    expect(matchCommand('/connect gmail')).toEqual({ kind: 'connect_google', grant: 'gmail' });
    expect(matchCommand('/connect tasks')).toEqual({ kind: 'connect_google', grant: 'tasks' });
    expect(matchCommand('/connect drive')).toEqual({ kind: 'connect_google', grant: 'drive' });
    expect(matchCommand('/connect outlook')).toBeNull();
  });

  it('matches the Hebrew help alias', () => {
    expect(matchCommand('עזרה')).toEqual({ kind: 'help' });
  });

  it('does not match a command embedded in a sentence', () => {
    expect(matchCommand('שלח /help לחבר')).toBeNull();
    expect(matchCommand('/helpme')).toBeNull();
  });

  it('returns null for free text so it goes to NLU', () => {
    expect(matchCommand('תזכיר לי מחר ב-8')).toBeNull();
    expect(matchCommand('')).toBeNull();
  });
});
