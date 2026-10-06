/**
 * Google grants (PLAN §6.6, 2026-10-01): one per area, each its own consent,
 * its own refresh token, and its own row. A grant for mail never carries the
 * calendar's scopes, and revoking one leaves the others working.
 *
 * New scopes are a security decision (CLAUDE.md); these were approved by the
 * user on 2026-10-01 and recorded in PLAN §14. Nothing here sends mail, and
 * nothing writes to Drive. `contacts` was approved on 2026-10-06.
 */
export const GRANT_NAMES = ['calendar', 'gmail', 'tasks', 'drive', 'contacts'] as const;
export type GrantName = (typeof GRANT_NAMES)[number];

export type GrantSpec = {
  /** The `integrations.account` the grant is stored under. `primary` predates the others. */
  account: string;
  scopes: readonly string[];
  /** What `/connect` takes for it. */
  command: string;
};

export const GRANTS: Readonly<Record<GrantName, GrantSpec>> = {
  calendar: {
    account: 'primary',
    scopes: [
      'https://www.googleapis.com/auth/calendar.events.owned',
      'https://www.googleapis.com/auth/calendar.app.created',
      // Read every calendar, shared ones included (2026-10-01).
      'https://www.googleapis.com/auth/calendar.readonly',
    ],
    command: 'google',
  },
  gmail: {
    account: 'gmail',
    // Read, and write drafts. Never send: a draft is sent by the user, in Gmail.
    scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose'],
    command: 'gmail',
  },
  tasks: {
    account: 'tasks',
    scopes: ['https://www.googleapis.com/auth/tasks'],
    command: 'tasks',
  },
  drive: {
    account: 'drive',
    // File names and dates only, never contents.
    scopes: ['https://www.googleapis.com/auth/drive.metadata.readonly'],
    command: 'drive',
  },
  contacts: {
    account: 'contacts',
    // Approved by the user on 2026-10-06 (ROADMAP #11), reversing §14 of
    // 2026-09-25. Read only; `src/google/contacts.ts` asks for names and
    // birthdays and nothing else.
    scopes: ['https://www.googleapis.com/auth/contacts.readonly'],
    command: 'contacts',
  },
};

export function grantByCommand(word: string): GrantName | null {
  const lower = word.toLowerCase();
  return GRANT_NAMES.find((name) => GRANTS[name].command === lower) ?? null;
}

export function isGrantName(value: unknown): value is GrantName {
  return typeof value === 'string' && (GRANT_NAMES as readonly string[]).includes(value);
}
