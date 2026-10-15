/**
 * Migrations are inlined rather than read from disk: a Worker bundle has no
 * filesystem. The numbering matches the files in `migrations/`, which stay the
 * source of truth for review and for the Node Plan B.
 */
import init0001 from '../../migrations/0001_init.sql';
import confirm0002 from '../../migrations/0002_confirm.sql';
import reminders0003 from '../../migrations/0003_reminders.sql';
import google0004 from '../../migrations/0004_google.sql';
import questions0005 from '../../migrations/0005_questions.sql';
import outbound0006 from '../../migrations/0006_outbound.sql';
import ical0007 from '../../migrations/0007_ical.sql';
import birthdays0008 from '../../migrations/0008_birthdays.sql';
import devices0009 from '../../migrations/0009_devices.sql';
import app0010 from '../../migrations/0010_app.sql';
import agent0011 from '../../migrations/0011_agent.sql';
import cards0012 from '../../migrations/0012_cards.sql';
import phoneReads0013 from '../../migrations/0013_phone_reads.sql';
import conversations0014 from '../../migrations/0014_conversations.sql';
import quota0015 from '../../migrations/0015_quota.sql';
import grants0016 from '../../migrations/0016_grants.sql';
import recurring0017 from '../../migrations/0017_recurring.sql';
import scheduledReads0018 from '../../migrations/0018_scheduled_reads.sql';
import notesExpenses0019 from '../../migrations/0019_notes_expenses.sql';
import missedCalls0020 from '../../migrations/0020_missed_calls.sql';
import reminderPlace0021 from '../../migrations/0021_reminder_place.sql';
import misses0022 from '../../migrations/0022_misses.sql';
import lists0023 from '../../migrations/0023_lists.sql';
import facts0024 from '../../migrations/0024_facts.sql';
import portfolio0025 from '../../migrations/0025_portfolio.sql';
import smartConversations0026 from '../../migrations/0026_smart_conversations.sql';
import consentTurns0027 from '../../migrations/0027_consent_turns.sql';
import routines0028 from '../../migrations/0028_routines.sql';
import routineCards0029 from '../../migrations/0029_routine_cards.sql';
import screenTasks0030 from '../../migrations/0030_screen_tasks.sql';
import screenTaskMode0031 from '../../migrations/0031_screen_task_mode.sql';
import screenTaskReply0032 from '../../migrations/0032_screen_task_reply.sql';
import lastSelection0033 from '../../migrations/0033_last_selection.sql';
import watches0034 from '../../migrations/0034_watches.sql';
import learning0035 from '../../migrations/0035_learning.sql';
import learnProposals0036 from '../../migrations/0036_learn_proposals.sql';
import mailFollowups0037 from '../../migrations/0037_mail_followups.sql';
import suggestions0038 from '../../migrations/0038_suggestions.sql';
import monthlyExports0039 from '../../migrations/0039_monthly_exports.sql';
import mailArchives0040 from '../../migrations/0040_mail_archives.sql';
import routineDrafts0041 from '../../migrations/0041_routine_drafts.sql';

export const MIGRATIONS = [
  { id: 1, sql: init0001 },
  { id: 2, sql: confirm0002 },
  { id: 3, sql: reminders0003 },
  { id: 4, sql: google0004 },
  { id: 5, sql: questions0005 },
  { id: 6, sql: outbound0006 },
  { id: 7, sql: ical0007 },
  { id: 8, sql: birthdays0008 },
  { id: 9, sql: devices0009 },
  { id: 10, sql: app0010 },
  { id: 11, sql: agent0011 },
  { id: 12, sql: cards0012 },
  { id: 13, sql: phoneReads0013 },
  { id: 14, sql: conversations0014 },
  { id: 15, sql: quota0015 },
  { id: 16, sql: grants0016 },
  { id: 17, sql: recurring0017 },
  { id: 18, sql: scheduledReads0018 },
  { id: 19, sql: notesExpenses0019 },
  { id: 20, sql: missedCalls0020 },
  { id: 21, sql: reminderPlace0021 },
  { id: 22, sql: misses0022 },
  { id: 23, sql: lists0023 },
  { id: 24, sql: facts0024 },
  { id: 25, sql: portfolio0025 },
  { id: 26, sql: smartConversations0026 },
  { id: 27, sql: consentTurns0027 },
  { id: 28, sql: routines0028 },
  { id: 29, sql: routineCards0029 },
  { id: 30, sql: screenTasks0030 },
  { id: 31, sql: screenTaskMode0031 },
  { id: 32, sql: screenTaskReply0032 },
  { id: 33, sql: lastSelection0033 },
  { id: 34, sql: watches0034 },
  { id: 35, sql: learning0035 },
  { id: 36, sql: learnProposals0036 },
  { id: 37, sql: mailFollowups0037 },
  { id: 38, sql: suggestions0038 },
  { id: 39, sql: monthlyExports0039 },
  { id: 40, sql: mailArchives0040 },
  { id: 41, sql: routineDrafts0041 },
] as const;
