/**
 * Google grants (PLAN §6.6, 2026-10-01): one per area, each its own consent,
 * its own refresh token, and its own row. A grant for mail never carries the
 * calendar's scopes, and revoking one leaves the others working.
 *
 * New scopes are a security decision (CLAUDE.md); these were approved by the
 * user on 2026-10-01 and recorded in PLAN §14. Nothing here sends mail, and
 * nothing writes to Drive. `contacts` was approved on 2026-10-06.
 * `gmail.modify` was approved on 2026-10-14 for archiving only (block L, L5):
 * it could also send, so `test/security/gmail-endpoints.test.ts` holds the
 * Gmail client to reading, drafts, INBOX and the bot's own labels.
 * `drive.file` was approved on 2026-10-14 for `docs.create` (block L, L6).
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
    // Read, write drafts, and archive (block L, L5). Never send: a draft is sent
    // by the user, in Gmail; never delete or trash.
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/gmail.modify',
    ],
    command: 'gmail',
  },
  tasks: {
    account: 'tasks',
    scopes: ['https://www.googleapis.com/auth/tasks'],
    command: 'tasks',
  },
  drive: {
    account: 'drive',
    // File names and dates; and, since 2026-10-14 (block L, L6), creating
    // Docs: `drive.file` sees only the files the bot itself made.
    scopes: ['https://www.googleapis.com/auth/drive.metadata.readonly', 'https://www.googleapis.com/auth/drive.file'],
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
