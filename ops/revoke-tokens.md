# Revoking access (incident response)

Use when the phone is lost or stolen, or a secret may have leaked.

## Immediate — stop the bot from acting

1. Send `/pause` from any allowlisted number. This denies every write.
2. If the phone itself is compromised, skip to step 3.

## Cut off the channel

3. Meta Business → System Users → revoke the access token.
   The webhook keeps arriving but nothing can be sent.
4. Or clear `ALLOWLIST_WA_IDS` — every inbound message is then dropped silently
   before any LLM call.

## Cut off Google

5. https://myaccount.google.com/permissions → remove the app.
   The next API call fails with `invalid_grant` and the integration marks itself
   `disconnected`.

## After the incident

6. Rotate every secret (`ops/rotate-secrets.md`).
7. Read the audit log before it ages out. `audit_log` holds one row per decision
   with the tool, tier, decision and outcome — enough to see what was done, and
   deliberately not enough to see what was said.
8. Check `outbound_messages` and the monthly counter for sends you did not make.

## What revoking does not do

Revoking the Google grant does not delete events the assistant already created.
They are tagged `extendedProperties.private.assistant = "1"`, so they can be
found and removed from the Google Calendar UI by searching that calendar.

Revoking the Meta token does not stop webhooks arriving. It stops replies. To
stop processing as well, clear `ALLOWLIST_WA_IDS`: inbound messages are then
dropped before parsing, before any LLM call, and before anything is stored.
7. Review `audit_log` for entries around the window.
8. Re-authorize with `/connect google`.
