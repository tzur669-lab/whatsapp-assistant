# העוזר (Call Companion)

The Android front end of the personal assistant (`bot/`, PLAN §6.18). It started
as the phone half of "תתקשר לדוד דני" (§6.17) and is now the whole channel: a
chat screen, hold-to-record voice, and notifications for reminders. WhatsApp
is frozen on the server behind `CHANNEL`. The engine behind the chat (parsing,
time, policy, confirmations, reminders, the calendar) is the server's and did
not change.

The package is still `com.tzur.callcompanion`, so the update installs over 0.1.
It has to be paired again: 0.1's bearer token is no longer accepted, and the
app deletes it on first start.

## How a message goes

1. The app gives the message a fresh id (a UUID) and sends it **signed**.
   Every request carries `x-device-id`, `x-timestamp`, `x-nonce` and
   `x-signature`: ECDSA P-256 with a Keystore key that cannot be exported,
   over `ASSISTANT-REQ-v1 · METHOD · path · device · timestamp · nonce ·
   sha256(body)` (`Protocol.kt`). Someone reading the traffic on the way
   cannot sign another request.
2. The answer comes back in the response, and is also written to the server's
   outbox. The app stores it under its `seq` and then acks that seq.
3. If no answer comes back (a timeout, or no network), the app sends **the same
   id** again. The server never runs a message twice. It answers with the
   stored reply, or says `pending`, `done` or `unknown`. While `pending`, the
   app polls the outbox every 5 seconds, for up to 3 minutes.
4. One message at a time (`Turns`). Sending stays locked until the answer
   arrives.

## How a reminder arrives

The server writes the reminder to its outbox and sends an FCM push with
`{kind: outbox}` and nothing else. The app fetches the outbox, stores the rows,
acks the stored seqs, and shows a notification. Reminders use the high-importance
channel and carry their snooze and done buttons as actions. If the fetch fails, a
generic "new message" notification shows instead, so a reminder is never silent.
An unacked row is pushed again after 15 minutes, 1 hour and 4 hours, and the app
also fetches whenever it opens. A reminder that arrives late shows the time it
was due.

## How a call goes

Unchanged from 0.1, except that the requests are signed. The push carries an
opaque dispatch id. The app fetches the words to match, matches them against the
contacts **by name only** (`ContactMatcher`), and shows the resolved number on a
full-screen notification. It reports `{ matched, outcome }` and never a name or
a number.

## Setup

1. **Firebase**: project `tzur-call-companion`, Android app
   `com.tzur.callcompanion`. `app/google-services.json` is gitignored:
   `firebase apps:sdkconfig ANDROID <app id> --project tzur-call-companion -o app/google-services.json`
2. **Service account for the server**: Firebase → Project settings → Service
   accounts → Generate new private key. Give the file to
   `bot/scripts/set-staging-secrets.ps1` (it becomes `FCM_SA_KEY`), then delete it.
3. **Build**: `gradlew assembleDebug`, then install
   `app/build/outputs/apk/debug/app-debug.apk`. The server URL is
   `companionServerUrl` in `gradle.properties`.
4. **Pair**: run `bot/scripts/set-staging-secrets.ps1 -PairCode`. It shows a
   20-character code once. Type it into the app, preferably over mobile data
   rather than the home Wi-Fi. The code itself is never sent: the app sends its
   public key and an HMAC, keyed by the code, over that key. Each code works
   once. Pairing a new phone unpairs the old one.
5. In the app's settings screen: allow notifications, set the battery to
   "unrestricted", and allow the microphone (and contacts and phone for calls).

`/pair off` in the chat unpairs the phone on the server.

## What stays on the phone

- **Chat history:** a private SQLite database, the last 500 messages, excluded
  from backup and device transfer (`data_extraction_rules.xml` excludes every
  domain).
- **The signing key:** in the Keystore.
- **Recordings:** live in `noBackupFilesDir` only while recording. They are
  deleted after reading, and any leftovers are removed at startup.
- **Contacts:** names and numbers are read on the phone and never leave it.

The only dependency is Firebase Messaging. HTTP, JSON, SQLite, crypto and the
recorder all come from the platform.

## Tests

`gradlew testDebugUnitTest` runs on the JVM.

- **Matching rules.**
- **The wire protocol** (`ProtocolTest`), pinned against vectors from the
  server's own code:
  - the canonical string;
  - a server-side signature, which must verify over the string the app builds;
  - the pairing MAC;
  - pairing-code normalisation.

If the app and the server drift apart, these fail.

`gradlew lintDebug` is clean except for version-upgrade suggestions.
