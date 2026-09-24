# Disaster recovery

Losing Durable Object state is an accepted risk (PLAN §6.8): the calendar itself
lives in Google, and reminders are short-lived.

## Full rebuild

1. `pnpm install`
2. Set every secret from PLAN §7.2 for the target environment.
3. Deploy. The DO applies `migrations/` on first request.
4. Re-point the Meta webhook at the new host and redo the handshake.
5. `/connect google` to re-authorize.
6. `/status` to confirm.

## What does not come back

- Pending reminders that had not yet fired.
- The audit log.

Calendar events, including reminder backups in "Assistant Reminders", are
unaffected.
