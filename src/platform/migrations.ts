/**
 * Migrations are inlined rather than read from disk: a Worker bundle has no
 * filesystem. The numbering matches the files in `migrations/`, which stay the
 * source of truth for review and for the Node Plan B.
 */
import init0001 from '../../migrations/0001_init.sql';
import confirm0002 from '../../migrations/0002_confirm.sql';
import reminders0003 from '../../migrations/0003_reminders.sql';

export const MIGRATIONS = [
  { id: 1, sql: init0001 },
  { id: 2, sql: confirm0002 },
  { id: 3, sql: reminders0003 },
] as const;
