# Revoking access (incident response)

Use when the phone is lost or stolen, or a secret may have leaked.

## Immediate — stop the bot from acting

1. Send `/pause` from the app (or, on WhatsApp, any allowlisted number). This
   denies every write.
2. If the phone itself is compromised, skip to step 3.

## Cut off the channel

3. **The kill switch:** deploy with `CHANNEL` set to `off` (`wrangler.jsonc`,
   then the deploy — the human does it). Every channel route and the OAuth pair
   answer 404, nothing is pushed, and reminders are *held*, not spent: they go
   out when the channel is switched back.
4. **A lost phone, app channel:** run `scripts/set-staging-secrets.ps1 -PairCode`
   (or set a new `PAIR_BOOTSTRAP_CODE` by hand in production) and pair the
   replacement. Pairing revokes the lost phone at once: its key signs nothing
   the server accepts any more. Without a replacement at hand, the new code
   alone does not revoke — use step 3.
5. **WhatsApp channel:** Meta Business → System Users → revoke the access token.
   The webhook keeps arriving but nothing can be sent.

Clearing `ALLOWLIST_WA_IDS` is **no longer** a kill switch: its first entry is
the identity every record belongs to (PLAN §6.18), so clearing it orphans them.

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
stop processing as well, use `CHANNEL=off`.

Revoking the phone (`/pair off`, or pairing a new one) does not delete its chat
history, which lives only on that phone.
7. Review `audit_log` for entries around the window.
8. Re-authorize with `/connect google`.
