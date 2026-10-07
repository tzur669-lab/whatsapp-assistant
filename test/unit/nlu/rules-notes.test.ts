/**
 * The rules fallback's notes pattern (2026-10-07): "מה הפתקים שלי" still works
 * when every model is unavailable, and only as the whole message.
 */
import { describe, expect, it } from 'vitest';
import { bare, parseByRules } from '../../../src/nlu/rules-fallback.js';
import { validateIntentDraft } from '../../../src/nlu/intent-schema.js';

describe('rules fallback: notes', () => {
  it.each(['מה הפתקים שלי?', 'תראה לי את כל הפתקים!', 'הפתקים שלי', 'show my notes', 'My notes.'])(
    'reads "%s" as notes.find, and the draft validates',
    (text) => {
      const draft = parseByRules(text);
      expect(draft['intent']).toBe('notes.find');
      expect(validateIntentDraft(draft).ok).toBe(true);
    },
  );

  it.each(['אני לא זוכר מה הפתקים שלי אומרים', 'תסביר לי מה זה פתקים', 'תמחק את הפתק על החניה'])(
    'leaves "%s" alone',
    (text) => {
      expect(parseByRules(text)['intent']).not.toBe('notes.find');
    },
  );

  it('strips punctuation, geresh and gershayim, and extra spaces', () => {
    expect(bare('  מה   הפתקים, שלי?! ')).toBe('מה הפתקים שלי');
    expect(bare('צה״ל')).toBe('צה ל');
  });
});
