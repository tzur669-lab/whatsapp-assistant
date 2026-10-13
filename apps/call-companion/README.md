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

Since 0.10: navigation can go to **a contact's address** — the card carries the
name's words, the address is read and matched here (`ContactsReader.addresses`)
and never leaves — or to a calendar event's place, which the server put on the
card and which always waits for the tap. Music can play on **Spotify**
(play-from-search, else its own search).

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

Since 0.10 the **call log** is a fourth read (`calls`, `READ_CALL_LOG`): the
caller's contact name, or the name the log cached if it has letters, else
nothing — never a number — with the direction and the time.

**Missed calls for the morning digest (0.10).** At the digest hour the server
sends an empty push (`kind: calls_report`). Without the call-log permission the
app does nothing; with it, it sends a signed `POST /app/calls-report` with the
calls missed in the last day — names or none, and times. Nothing is shown.

Voice messages never trigger a phone read (the server does not offer it), and
the app declares `caps: ["cards", "device_query", "file", "calls_report"]`.

## Sharing, the assistant and the widget (0.11)

**Share to the assistant.** Any app's Share → העוזר. The text (and its subject,
capped at 1,200 characters) opens a new conversation and waits above the field;
the user writes what to do with it ("תזכיר לי מחר ב־9") and sends. A tap on the
banner drops it. It is never sent on its own, and never with a `/` command or a
recording. On the wire it is a separate `shared` field of the text message, and
the server treats it as someone else's words: every write it leads to asks for
confirmation and the answer stays off the lock screen. Needs the server from
2026-10-06 (migration 0021): an older one refuses the field.

**The default assistant.** ☰ → 🤖 עוזר ברירת המחדל opens the system's default
apps; choosing העוזר as the digital assistant app makes a long press on home
open the chat (`ACTION_ASSIST`). 🎤 then works by taps: one starts the recording,
the next sends it. The activity is exported, so nothing records before that tap.

**The widget.** The newest reminder the phone already has, its time, and two
buttons: ✏️ לכתוב (the keyboard) and 🎤 לדבר (tap-to-talk). Redrawn when a
reminder is fetched, never on a timer. A private reminder (one carrying text
someone else wrote, like a "time to leave" with a calendar title) shows only
that a reminder came. Cleared when the server unpairs the phone.

**Time to leave.** A reminder set with "תזכיר לי מתי לצאת…" arrives with a Waze
card to the event's place, if it has one. The card can be claimed for two hours.

## Smart or local (0.12)

＋ asks which conversation to open: **✨ שיחה חכמה** (Gemini's free tier on the
server, PLAN §6.19) or **שיחה רגילה** (the assistant as before, on Groq's servers; labelled "local" before 0.13.5, still `mode: 'local'` on the wire). The choice
says that Google may train on a smart conversation's content and human
reviewers may read it, and that personal data reaches the model only after a
consent card. The mode is fixed for the conversation's life and shown as a
badge in its title. Shared text, the default assistant and the widget always
open local conversations.

**On the wire.** A text message carries `mode` (`smart` or `local`) in its
body, only with a real `conversationId` and never with `shared`
(`Protocol.wireMode`). A voice note carries it as a path segment after the
conversation: `/app/voice/<id>[/<conversation>[/<mode>]][/@lat,lon]`
(`Protocol.voicePath`). Buttons carry none. A missing mode is `local` on the
server. `GET /app/outbox` answers with `smart`: false (or absent, from an older
server) greys out the smart choice. A **422 `mode_mismatch`** means the server
recorded the other mode for that conversation: the app shows a notice and never
resends it (`Protocol.stepFor`: only a 409 is signed again). Consent cards are
ordinary button cards (`cs:…`), and `/consents` lists what a smart conversation
allowed. `ProtocolTest` pins both shapes against the server.

The chat database is version 4: the `mode` column, with every existing
conversation `local`. Needs the server from 2026-10-08 (migration 0027) or
later — **deploy the server first**: an older one refuses the `mode` field.

## Routines (0.13, PLAN §6.27)

☰ → **⚙️ שגרות** builds a routine: a name, one app, and up to 10 steps —
wait for a text, tap a text, tap a view id, type a fixed text into a field,
press the keyboard's Enter, check that a text appeared or that a button
switched off, pause. **🔍 מה רואים** lists what the service can read
in the app (on the phone only).
Typing (0.13.1) sets only the text written into the routine, never into a
password field. No scrolling or gestures. Saved in private preferences, excluded from
backup. **בדיקה יבשה** opens the app and finds everything up to the first
action (tap or typing), then stops without acting; **הפעלה** runs it now, phone unlocked.

`RoutineAccessibilityService` runs the steps. The user turns on "שגרות של
העוזר" in the accessibility settings (a sideloaded app may first need **App
info → ⋮ → Allow restricted settings**). Before every step it checks that the
phone is unlocked and that the routine's own app is in front; a tap is
`ACTION_CLICK` on exactly one visible, enabled element, matched on its whole
text. Screen content is never stored or sent.

**Scheduled from the chat** ("בעוד רבע שעה תפעיל את יציאה מהעבודה"). The app
syncs each routine's id, name, app label and step hash (`POST /app/routines`,
never a step) after every change and once per process. The server confirms the
request in the chat, sends a notice with a cancel button two minutes before,
and at the time a data push `{kind: routine, run_id}`. `RoutineRunner`:
behind the lock screen, `RoutineRunActivity` turns the screen on and asks
Android to dismiss the lock (by itself under Extend Unlock, or one fingerprint
touch); then one signed claim (`/app/routine/claim`) returns the routine's id
and step hash, the local routine must match it, the steps run, and the outcome
goes back as codes (`/app/routine/result`). A claimed run is never retried.
Locked for two minutes, or more than ten minutes late: nothing runs.

**Unlocking with a stored PIN (0.17).** In ⚙️ שגרות → פתיחת נעילה לבד the
user saves the phone's numeric PIN (`UnlockStore`: AES-GCM under a Keystore
key, private prefs, never sent) and switches it on per routine (kept with the
routine's step hash, so an edit turns it off). With the phone locked,
`RoutineRunner.claimFirst` claims, then `RoutineAccessibilityService.unlockAndRun`
matches every digit to one keypad key (`UnlockLogic`), types it, runs the
steps and locks the phone again. One attempt: a PIN that does not open turns
the feature off until it is saved again (`Notifier.unlockFailed`). Routines
only; screen tasks still ask for the unlock.
**Deploy the server first**: an older one answers the sync with 404.

## Screen agent (0.14.0)

"תחפש בפיד סטימצקי": after the user confirms a card in the chat, the bot works
inside one app on the phone, step by step (spec and plan:
`docs/plans/screen-agent.md`). The loop and the model are on the server; the
phone is its eyes and hands and has the last word on every action.

- **The allowlist** (☰ → ⚙️ סוכן מסך, `ScreenAllowActivity`): at most 20 apps,
  each with "לשאול לפני כל לחיצה" (off by default), and the disclosure that
  the app's text goes to the bot's server and, scrubbed, to Groq in a regular
  conversation or to Gemini (which may train on it) in a smart one (0.14.2). Settings, the
  system UI, launchers, messaging, mail, banks, payments and stores can never
  be added (`ScreenLogic.blocked`). Every change is synced
  (`POST /app/screen/allow`) and once per process; removing an app stops a
  task in it at once.
- **A task** (`ScreenAgentRunner`, `ScreenRun`): FCM `{kind: screen, task_id}` →
  unlock if needed (`RoutineRunActivity`) → one signed claim (the app, the
  approved inputs, kept in memory only) → the app is brought to the front as it
  was (no `CLEAR_TASK`; routines keep it) → up to 12 steps of: the screen as at
  most 80 elements (`ScreenLogic.elements`) → `POST /app/screen/step` → one
  action. It runs on the accessibility service's one worker, so a routine and a
  task never act at once; a routine push stops the task.
- **Every action** names its node by the phone's own binding
  (`ScreenLogic.binding`), and acts only when a fresh snapshot holds exactly
  one node with it. The phone classes each tap, Enter and typing with its own
  copy of the risk policy (`ScreenLogic.riskClass`, checked against
  `test/fixtures/screen-policy.json`); a higher class than the server's is held
  and asked about. Approvals come as a private, high-priority notification
  ("אשר" / "דחה" need the phone unlocked) or as the chat card.
- **At most once**: a journal in private preferences (`ScreenJournal`: task id,
  action id, status — never screen text), one `commit()` per move, and one gate
  around stop-check → journal → act → journal. After a crash, an action left
  `started` is reported `uncertain` and never repeated; one left `held` is
  refused (`CompanionApp` at process start).
- **Stop**: "עצור" on the ongoing notification, a routine push, FCM
  `screen_stop`, or removing the app. A request in flight is aborted.

Nothing here logs screen text. **Deploy the server first**: an older one
answers the new routes with 404 and never sends a `screen` push.

## Watches (0.15, PLAN §6.30)

"כשתגיע הודעת SMS עם המילה חבילה, תזכיר לי לאסוף אותה": the server keeps
the watch; the phone matches it.

- `Watches.kt` fetches the list signed (`GET /app/watches`: id, source,
  normalized keywords, end) at start and on an FCM `kind: watches` push.
- `NotificationCollector` hands each notification to it after the hidden-app
  check. From the default SMS app, the newest SMS (`_id` and body, the existing
  `READ_SMS` grant) is matched against `sms` watches; anything else, its title
  and text against `notification` watches. One SMS never fires both kinds.
- `WatchMatcher.kt` is the server's `core/watch-match.ts` in Kotlin, both
  checked against `test/fixtures/watch-normalize.json`.
- A match posts `POST /app/watch/fired {watchId, matchedAt}`: no text. It is
  handled only after a 2xx; until then it waits in a queue of 20 in
  `SharedPreferences` (ids and times), sent again on the next network or start
  with a fresh nonce, and dropped after 10 minutes (the server would refuse
  it). The last 100 handled events are kept so a re-posted notification never
  fires again; an SMS is known by its `_id`, a notification by its key and a
  local hash of its text.
- New: `ACCESS_NETWORK_STATE` (install-time, no prompt), for that retry.

**Deploy the server first**: an older one answers both routes with 404.

## Spoken replies (0.16, block J)

A switch in the settings screen, **off** by default: the answer to a voice
note is read aloud with the phone's own `TextToSpeech` in `he-IL`. Only the
direct answer to an outgoing `voice` message (never one that arrives by push),
only when the ringer is normal (not silent or vibrate); a tap on the chat
stops it. `SpeechLogic.kt` holds the rules, tested; `Speech.kt` follows one
order — engine ready, Hebrew voice available, the reply's id committed (the
last 50 in `SharedPreferences`), then `speak()` — so a reply is spoken at most
once. No Hebrew voice: nothing is spoken and the settings screen says why. No
server or wire change.

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
4. **Pair**: run `scripts/set-staging-secrets.ps1 -PairCode` (in the repository root). It shows a
   20-character code once. Type it into the app, preferably over mobile data
   rather than the home Wi-Fi. The code itself is never sent: the app sends its
   public key and an HMAC, keyed by the code, over that key. Each code works
   once. Pairing a new phone unpairs the old one.
5. In the app's settings screen: allow notifications, set the battery to
   "unrestricted", and allow the microphone (and contacts and phone for calls).
   For ringer and do-not-disturb cards, Android asks once for notification-policy
   access; the first such card opens that screen.
6. Phone reads, each optional: SMS, the call log, and notification access. On Android 13+ a
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
- **Contacts:** numbers and addresses never leave the phone. A name leaves only
  as the answer to a phone read the user asked for (PLAN §6.21), or in the
  missed-calls report the digest asks for.
- **Call log:** read when asked, never copied. Numbers never leave.
- **Notifications:** the last day, in `notifications.db`, private and excluded
  from backup, until a phone read asks for some of them.
- **The lock PIN (0.17):** Keystore-encrypted in private prefs, excluded from
  backup; never sent, logged or shown.
- **Watches (0.15):** notifications and SMS are matched here; only a watch's id
  and a time leave the phone. The queue and the handled list hold ids, hashes
  and times only.

The only dependency is Firebase Messaging. HTTP, JSON, SQLite, crypto and the
recorder all come from the platform.

## Tests

`gradlew testDebugUnitTest` runs on the JVM.

- **The chat's rules** (`ChatLogicTest`): what `/` offers, conversation
  titles, where a row goes, and that only a real conversation id is sent.
- **Matching rules**, for calls (`ContactMatcherTest`), cards (`CardLogicTest`)
  routines (`RoutineLogicTest`: validation, the step hash, one exact target),
  the screen agent (`ScreenLogicTest`: elements and caps, the binding, the
  journal's every move; `ScreenPolicyFixtureTest`: the word lists and vectors
  shared with the server),
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
