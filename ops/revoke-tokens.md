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
7. Review `audit_log` for entries around the window.
8. Re-authorize with `/connect google`.
