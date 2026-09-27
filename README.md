# Call Companion

The phone half of "תתקשר לדוד דני" for the WhatsApp assistant
(`bot/`, PLAN §6.17). The assistant runs in a datacenter and cannot place a
call; this app, paired with it, can — from this SIM, to a contact already on
this phone, after a tap on this phone's screen.

## How a call goes

1. The assistant parses "call X" and pushes an **opaque dispatch id** through FCM.
2. The app fetches the dispatch over HTTPS with its own device token and gets
   the words to match.
3. It matches them against the phone's contacts, **by name only**
   (`ContactMatcher`). A number in the words matches nobody.
4. A full-screen notification shows the name and the **resolved number**:
   `חיוג` or `ביטול`. With several matches, the screen lists them.
5. The app reports `{ matched: none|one|many, outcome }` — never a name or a
   number — and the assistant sends its one WhatsApp reply.

A request expires after two minutes, and the app re-checks that before showing
or dialling anything.

## Setup

1. **Firebase project**: `tzur-call-companion`, with the Android app
   `com.tzur.callcompanion` registered (created 2026-09-27). Its config goes in
   `app/google-services.json`, which is gitignored:
   `firebase apps:sdkconfig ANDROID <app id> --project tzur-call-companion -o app/google-services.json`
2. **Service account for the server**: Project settings → Service accounts →
   Generate new private key. Give the file to `bot/scripts/set-staging-secrets.ps1`
   (it becomes `FCM_SA_KEY`), then delete it.
3. **Build**: `gradlew assembleDebug`, install `app/build/outputs/apk/debug/app-debug.apk`.
   The server URL is `companionServerUrl` in `gradle.properties`.
4. **Pair**: send `/pair` to the assistant, paste the code into the app, grant
   the four permissions it lists.

`/pair off` in the chat revokes the phone on the server.

## What stays on the phone

Contact names and numbers, the words of each request, and the device token —
the last encrypted with an Android Keystore key and excluded from backup. The
only dependency is Firebase Messaging; HTTP, JSON and crypto are the platform's.

## Tests

`gradlew testDebugUnitTest` — the matching rules, on the JVM.
