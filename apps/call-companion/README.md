# העוזר (Call Companion)

The Android front end of the personal assistant (the server is this
repository's root, PLAN §6.18; the app moved here from its own repository on
2026-10-01). It started
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

## Conversations (0.5)

Like an LLM client: ☰ opens the list of conversations, ＋ starts a new one,
and a long press on a conversation deletes it from the phone. Each message
carries its conversation's id (`conversationId` in the body, or a second path
segment for a voice note), and the server keeps the assistant's short memory
per conversation, under the same limits as before: six exchanges, twelve hours.
An answer goes to the conversation of the message it answers; what the server
sends on its own (reminders, the digest, birthdays) goes to the fixed
**🔔 תזכורות** conversation, which is read-only. A notification opens the
conversation its row is in.

A long press on any message copies it. Typing `/` in the field offers the
commands (`ChatLogic.COMMANDS`), and the guide (settings → 📖, or the menu)
explains the app and lists every command.

Needs the server from 2026-10-01 (migration 0014) or later: an older one
refuses the new field.

## Quotas (0.6)

📊 מכסות, in the ☰ menu and in settings, asks `GET /app/quota` (signed) and
shows a bar per quota. **Exact** (Groq's `x-ratelimit-*` headers, as of the
last call to that model): the day's requests and the minute's tokens, per
model. **Approximate** (counted by the server): Groq tokens over the last 24
hours — Groq reports that limit in no header, and the count misses anything
spent on the same key elsewhere, such as an eval run — and the server's
requests today. Recordings in the last hour are the server's own cap, exact.
Every time is measured on the server's clock. Needs migration 0015.

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

It never picks between people on its own (0.4.1). The fullest words are tried
first, so "יאיר אלע" never settles for every "יאיר". Several matching contacts
are a list, each with its own dial button. A match on only part of what was said
("יאיר אלע" when only "יאיר דוד" exists) is always that list too, titled
"התכוונת ל…?", even with one contact on it. A message card follows the same rule.

## How a phone action goes (0.3, PLAN §6.20)

An alarm, a timer, navigation, opening an app, a quick setting or a message
arrives as a **card** under the assistant's answer: a preview written by the
server, and Run / Cancel. The card carries an id and a nonce, never the
parameters.

1. Run (or, for a low-risk card on a clean turn, the app itself while the chat
   is open and the card is under two minutes old) first takes the card in the
   local database — once — and then sends a signed **claim**. The server
   consumes its pending row atomically and only then returns what to run. A
   second claim is answered "used".
2. `DeviceActions` validates the parameters again and runs them: the clock app
   for an alarm or timer, Waze or Google Maps, the launcher app the words match,
   the torch, do-not-disturb or the ringer (after notification-policy access is
   granted), the Wi-Fi or Bluetooth panel.
3. A message opens **prefilled** in the SMS app or WhatsApp, to a contact matched
   here by name. Sending it is the user's own tap there.
4. The app reports `done`, `failed`, `no_match` or `unsupported`, never what it
   matched.

Messages, do-not-disturb and the ringer never run on their own. Card buttons
never appear in a notification. The app declares `caps: ["cards"]` with its push
address; a build that does not is never sent a card.

## How a phone read goes (0.4, PLAN §6.21)

"What did I get on SMS today?", "any notifications from the bank?", "do I have
Dani in my contacts?" — the server cannot read these, so it asks the phone.

1. The answer to the typed message is `device_query`: a query id and a closed
   query (`contacts` by name, `notifications` from the last hours, `sms` from the
   last hours, optionally from one sender or app).
2. `PhoneReads` answers it on the Turns thread, each read checking its own
   permission (`denied` without it). What goes back is the minimum
   (`PhoneReadLogic`): at most 20 items of 300 characters, **names and never
   numbers** (an unknown sender is "מספר לא שמור"), and **no message carrying a
   one-time code** — those are dropped here and never leave.
3. The result is a signed `POST /app/device-result`; its answer is the reply to
   the original message. If it does not arrive, the message is asked about again,
   gets the same query, and the read runs again. The server continues the turn
   once, however many results reach it, and gives up after three minutes.

Notifications come from `NotificationCollector`, once notification access is
granted: the last day, in a private database (`notifications.db`) excluded from
backup. Never this app's own, ongoing ones, group summaries, secret ones, calls
or system status, and never an app hidden in settings ("הסתרת אפליקציות"); a
hidden app's kept rows are deleted at once.

A reply built on something read from the phone is marked `private`: its
notification says only that there is an answer. The text stays in the chat.

Voice messages never trigger a phone read (the server does not offer it), and
the app declares `caps: ["cards", "device_query"]`.

## Setup

1. **Firebase**: project `tzur-call-companion`, Android app
   `com.tzur.callcompanion`. `app/google-services.json` is gitignored:
   `firebase apps:sdkconfig ANDROID <app id> --project tzur-call-companion -o app/google-services.json`
2. **Service account for the server**: Firebase → Project settings → Service
   accounts → Generate new private key. Give the file to
   `scripts/set-staging-secrets.ps1` (in the repository root) (it becomes `FCM_SA_KEY`), then delete it.
3. **Build**: in this folder (`apps/call-companion`), `.\gradlew.bat assembleDebug`
   on Windows (`./gradlew assembleDebug` elsewhere), then install
   `app/build/outputs/apk/debug/app-debug.apk`. The server URL is
   `companionServerUrl` in `gradle.properties`.
4. **Pair**: run `bot/scripts/set-staging-secrets.ps1 -PairCode`. It shows a
   20-character code once. Type it into the app, preferably over mobile data
   rather than the home Wi-Fi. The code itself is never sent: the app sends its
   public key and an HMAC, keyed by the code, over that key. Each code works
   once. Pairing a new phone unpairs the old one.
5. In the app's settings screen: allow notifications, set the battery to
   "unrestricted", and allow the microphone (and contacts and phone for calls).
   For ringer and do-not-disturb cards, Android asks once for notification-policy
   access; the first such card opens that screen.
6. Phone reads, each optional: SMS, and notification access. On Android 13+ a
   sideloaded app may need **App info → ⋮ → Allow restricted settings** before
   notification access can be turned on.

`/pair off` in the chat unpairs the phone on the server.

## What stays on the phone

- **Chat history:** a private SQLite database, the last 500 messages, excluded
  from backup and device transfer (`data_extraction_rules.xml` excludes every
  domain).
- **The signing key:** in the Keystore.
- **Recordings:** live in `noBackupFilesDir` only while recording. They are
  deleted after reading, and any leftovers are removed at startup.
- **Contacts:** numbers never leave the phone. A name leaves only as the answer
  to a phone read the user asked for (PLAN §6.21).
- **Notifications:** the last day, in `notifications.db`, private and excluded
  from backup, until a phone read asks for some of them.

The only dependency is Firebase Messaging. HTTP, JSON, SQLite, crypto and the
recorder all come from the platform.

## Tests

`gradlew testDebugUnitTest` runs on the JVM.

- **The chat's rules** (`ChatLogicTest`): what `/` offers, conversation
  titles, where a row goes, and that only a real conversation id is sent.
- **Matching rules**, for calls (`ContactMatcherTest`), cards (`CardLogicTest`)
  and phone reads (`PhoneReadLogicTest`: the query's shape, one-time codes,
  names never numbers, the caps).
- **The wire protocol** (`ProtocolTest`), pinned against vectors from the
  server's own code:
  - the canonical string;
  - a server-side signature, which must verify over the string the app builds;
  - the pairing MAC;
  - pairing-code normalisation.

If the app and the server drift apart, these fail.

`gradlew lintDebug` is clean except for version-upgrade suggestions.
