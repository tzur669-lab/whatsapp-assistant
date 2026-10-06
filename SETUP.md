# SETUP — from zero to a working assistant

Every step, in order, for someone who has never run this project. It covers
the accounts, the API keys, which models to use, the values that belong to
the original owner and must be replaced, the deploy, the Android app, and how
to have an AI agent work on the code.

> **For AI agents helping someone set this up:** walk the human through the
> steps in order and check each one before moving on. Steps marked
> **[human]** involve accounts, keys or secrets: the human does them, you
> never see or handle the values (CLAUDE.md, "Secrets and privacy"). Never
> read `.dev.vars`, never run `wrangler secret put`, never deploy to
> production.

Time needed: about 2–3 hours the first time, most of it in web consoles.
Cost: $0. Every service below is used on its free tier, with no payment method.

---

## Step 0 — Tools on the computer

| Tool | Version | Check |
|---|---|---|
| Git | any recent | `git --version` |
| Node.js | 20 or newer (CI uses 22) | `node --version` |
| pnpm | 10 (pinned in `package.json`) | `corepack enable`, then `pnpm --version` |
| Android Studio | recent, with Android SDK 35 and its bundled JDK 17 | only for the app (Step 7) |
| A text editor + an AI coding agent | e.g. VS Code with Claude Code | Step 10 |

Windows is the tested platform: the secrets helper is a PowerShell script.
On macOS/Linux everything works except that script; Step 5 gives the manual
alternative.

## Step 1 — Get the code and check it runs (no accounts needed)

```bash
git clone <repo url> bot
cd bot
pnpm install
pnpm typecheck && pnpm lint && pnpm test
```

All three must pass before anything else. Unit tests use fakes and need no
keys and no network. If they fail on a fresh clone, stop and fix that first.

## Step 2 — Accounts and keys [human]

### 2.1 Cloudflare (hosting)

1. Sign up at <https://dash.cloudflare.com> (free plan, no card).
2. Workers & Pages → pick a **workers.dev subdomain** (e.g. `yourname`).
   Your staging URL will be `https://wa-assistant-staging.<subdomain>.workers.dev`.
3. On the computer: `npx wrangler login` (opens a browser).

Durable Objects with SQLite are included in Workers Free.

### 2.2 Groq (the LLM — this is where the API key comes from)

1. Sign up at <https://console.groq.com> (free tier, no card).
2. **Settings → Data Controls → turn on Zero Data Retention (ZDR).**
   Required before the agent is switched on (`AGENT=on`): the agent sends
   calendar titles and conversation history to Groq (PLAN §7, §13).
3. **API Keys → Create API Key.** Copy it once into a password manager. It
   becomes the `GROQ_API_KEY` secret (Step 5) and, for evals, a line in
   `.dev.vars` (Step 6). Never paste it into chat, code, docs or a commit.
4. **Models / Limits page:** confirm the three models in Step 3 are listed
   for your account, and note their limits.

### 2.3 Google Cloud (Calendar, Tasks, Gmail, Drive, Contacts)

1. <https://console.cloud.google.com> → create a project (one project serves
   both Google sign-in and Firebase; Step 7 adds Firebase to it).
2. **APIs & Services → Library → enable:** Google Calendar API, Google Tasks
   API, Gmail API, Google Drive API, People API.
3. **OAuth consent screen:** type *External*, app name of your choice, your
   email as support and developer contact. Add yourself as a test user.
   Then **Publish app** ("In production"). Without publishing, Google expires
   refresh tokens after 7 days and the calendar disconnects every week. For
   personal use you do not need Google's verification: you will see an
   "unverified app" warning once per connect — click *Advanced → Continue*.
4. **Credentials → Create credentials → OAuth client ID → Web application.**
   - Authorized redirect URI, exactly:
     `https://wa-assistant-staging.<subdomain>.workers.dev/oauth/google/callback`
   - The **client ID** is not secret: it goes in `wrangler.jsonc` (Step 4).
   - The **client secret** is: it becomes `GOOGLE_CLIENT_SECRET` (Step 5).

Scopes the code asks for (`src/google/grants.ts`), one grant per command:

| `/connect …` | Scopes | What it allows |
|---|---|---|
| `google` | `calendar.events.owned`, `calendar.app.created`, `calendar.readonly` | read all calendars, write own events |
| `gmail` | `gmail.readonly`, `gmail.compose` | read mail, write drafts (never send) |
| `tasks` | `tasks` | Google Tasks |
| `drive` | `drive.metadata.readonly` | file names and dates, never contents |
| `contacts` | `contacts.readonly` | names and birthdays only |

Adding a new scope is a design decision: stop and ask the owner (CLAUDE.md).

### 2.4 WhatsApp (skip)

The WhatsApp channel is frozen (`CHANNEL=app`). No Meta account is needed.

## Step 3 — The models (what to choose and why)

All run on Groq with the one `GROQ_API_KEY`. They are pinned in code; the bot
never picks a model at runtime.

| Model id | Role | Where it is set | Notes |
|---|---|---|---|
| `qwen/qwen3.8-27b` | **Primary.** Runs the agent and the parser; may write | `src/agent/models.ts`, `src/nlu/index.ts` | Passed the eval gate (100% on "no invented slots") |
| `openai/gpt-oss-120b` | **Backup**, read-only (`canWrite: false`) | same | Used on rate limits/failures; its writes always confirm |
| `whisper-large-v3` | Voice notes → text | `src/voice/groq-whisper.ts` | Not the turbo variant, on purpose |

Free-tier budget to keep in mind: about **8K tokens/minute and 200K
tokens/day per model**. A full `pnpm eval:agent` run can use up a model's
whole day — always run evals with `--filter` first.

**If a model is missing from your Groq account** (Groq retires models): do
not just swap the id. Pick a candidate, run `pnpm eval:agent --model <id>
--select-tools`, compare against PLAN §11.2 thresholds, and only then change
`src/agent/models.ts` (and `canWrite` only after a human reads the report).
See HANDOFF §4 and PLAN §6.19.

## Step 4 — Replace the owner's values with yours

These files carry the original owner's project. Change them in your copy:

| File | Field | Set to |
|---|---|---|
| `wrangler.jsonc` → `env.staging.vars` | `GOOGLE_CLIENT_ID` | your OAuth client ID (Step 2.3) |
| `wrangler.jsonc` → `env.staging.vars` | `PUBLIC_BASE_URL` | `https://wa-assistant-staging.<subdomain>.workers.dev` — no trailing slash, must match the Google redirect URI exactly |
| `apps/call-companion/gradle.properties` | `companionServerUrl` | the same URL |
| `apps/call-companion/app/build.gradle.kts` | `applicationId` | optional; if changed, use the same id in Firebase (Step 7) |
| `.claude/settings.json` | the `curl … /health` allow rule | your URL (cosmetic) |
| git | `origin` | your own private repo |

Leave `CHANNEL: "app"` and `AGENT: "on"` for staging (`AGENT: "on"` only with
Groq ZDR on). Leave the `production` block alone until staging has run for
a while.

## Step 5 — Secrets in Cloudflare [human]

Secrets live only in Cloudflare (PLAN §7.2), never in the repo or a file.

**Windows — the helper script** (staging only, writes nothing to disk):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\set-staging-secrets.ps1
```

- "Generate the internal keys?" → **y**, on the first run only. Running it
  again later makes every stored Google connection unreadable.
- `GROQ_API_KEY` → the key from Step 2.2 (hidden input).
- `GOOGLE_CLIENT_SECRET` → from Step 2.3.
- `ALLOWLIST_WA_IDS` → your own phone number, digits only (`9725XXXXXXXX`).
  **Set it once and never change it:** the identity every record belongs to is
  derived from it, on the app channel too.
- Firebase key file → leave empty for now; come back after Step 7.

**macOS/Linux — by hand**, one at a time, for each name:

```bash
openssl rand -base64 32 | npx wrangler secret put TOKEN_ENC_KEY_V1 --env staging
openssl rand -base64 32 | npx wrangler secret put LOG_HASH_KEY --env staging
openssl rand -base64 32 | npx wrangler secret put DEVICE_TOKEN_PEPPER --env staging
npx wrangler secret put GROQ_API_KEY --env staging          # paste when asked
npx wrangler secret put GOOGLE_CLIENT_SECRET --env staging
npx wrangler secret put ALLOWLIST_WA_IDS --env staging
```

The full inventory, with what each one does, is PLAN §7.2.

## Step 6 — Local `.dev.vars` (only for evals) [human]

Create `.dev.vars` in the repo root (it is gitignored) with one line:

```
GROQ_API_KEY=<your key>
```

Needed only by `pnpm eval` / `pnpm eval:agent`, which call the real Groq API.
Tests (`pnpm test`) never need it. AI agents are blocked from reading it.

## Step 7 — Deploy staging and build the Android app

### 7.1 Deploy the server

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm deploy:staging
curl https://wa-assistant-staging.<subdomain>.workers.dev/health   # → ok
```

If `wrangler` says `fetch failed` on a phone hotspot, it is IPv6: prefix the
command with `NODE_OPTIONS=--dns-result-order=ipv4first`.

### 7.2 Firebase (push notifications) [human]

1. <https://console.firebase.google.com> → **Add project** → choose the
   Google Cloud project from Step 2.3.
2. Add an **Android app** with the package name from `applicationId`
   (`com.tzur.callcompanion` unless you changed it).
3. Download `google-services.json` into `apps/call-companion/app/` (gitignored).
4. Project settings → **Service accounts → Generate new private key.** Run the
   Step 5 script again (answer **N** to "generate internal keys", Enter to skip
   the others), drag the downloaded `.json` file into the window when asked,
   then **delete the file**. It becomes `FCM_SA_KEY`. On macOS/Linux:
   `npx wrangler secret put FCM_SA_KEY --env staging < key.json`, then delete it.

### 7.3 Build and install the app

```powershell
cd apps/call-companion
.\gradlew.bat testDebugUnitTest assembleDebug      # ./gradlew on macOS/Linux
```

Install `app/build/outputs/apk/debug/app-debug.apk` on the phone (USB with
`adb install`, or copy the file). Always deploy the server **before**
installing a new APK.

### 7.4 Pair the phone [human]

```powershell
powershell -ExecutionPolicy Bypass -File scripts\set-staging-secrets.ps1 -PairCode
```

It shows a 20-character code once. Type it into the app's pairing screen,
preferably over mobile data. Then, in the app's settings: allow notifications,
battery "unrestricted", microphone; optionally contacts, phone, SMS, call log
and notification access. Details: `apps/call-companion/README.md` → Setup.

## Step 8 — Connect Google, inside the app

Send each command in the app chat, open the link within 10 minutes (it works
once), and approve:

```
/connect google
/connect tasks
/connect gmail
/connect drive
/connect contacts
```

`/status` then lists what is connected.

## Step 9 — Smoke test

In the app chat:

1. `/status` → a status report, no errors.
2. `תזכיר לי בעוד 2 דקות לבדוק` → a reminder is set, and the push arrives
   in two minutes even with the app closed.
3. `מה יש לי מחר ביומן?` → a list from your calendar.
4. A voice note → the reply starts with what it heard.
5. `/city ירושלים`, then `מה מזג האוויר?` → a weather answer.

If something fails: `ops/runbook.md` → *Diagnosing* has a symptom table.

## Step 10 — Working on the code with an AI agent

1. Open the `bot/` folder (not the parent folder) in your editor and start the
   agent there. Claude Code loads `CLAUDE.md` automatically, which imports
   `HANDOFF.md`; other agents should be told: *"Read CLAUDE.md and HANDOFF.md
   first and follow them."*
2. Model choice for the coding agent: the strongest available model (e.g.
   Claude Opus) for planning, security-sensitive code and anything in
   `src/agent/`, `src/policy/`, `src/confirm/`, `src/security/`; a mid-tier
   model (e.g. Claude Sonnet) is fine for routine, well-scoped changes.
3. What is already wired for Claude Code in `.claude/`:
   - `settings.json` — denies reading `.dev.vars`/`.env`, setting secrets,
     production deploys and rollbacks; asks before installs, commits, pushes
     and staging deploys.
   - `hooks/docs-guard.mjs` — at session end, asks to update `HANDOFF.md` /
     `ARCHITECTURE.md` if code changed and they did not (needs `node`).
   - `skills/add-tool/` — the checklist for adding or changing a tool.
4. A good first prompt:
   *"Read HANDOFF.md. Run typecheck, lint and test. Then open ROADMAP.md and
   tell me the first unchecked block and a plan for it — don't write code
   yet."*
5. The loop for every change: small change → `pnpm typecheck && pnpm lint &&
   pnpm test` → `pnpm eval` if `src/nlu/` changed, `pnpm eval:agent --filter …`
   if `src/agent/` changed → update `PLAN.md` §14 / `HANDOFF.md` when behavior
   or architecture changed → commit → `pnpm deploy:staging` → smoke test.
6. CI (`.github/workflows/ci.yml`) runs gitleaks, typecheck, lint, test and
   `pnpm audit` on every push. Optionally install
   [gitleaks](https://github.com/gitleaks/gitleaks) locally as a pre-commit
   hook, using the repo's `.gitleaks.toml`.

## Step 11 — Production (later, human only)

Production (`--env production`) is configured for the frozen WhatsApp channel
and is deployed, configured and rolled back by the owner only, by hand, never
from a script (PLAN §7.2, §9). Moving production to the app follows the same
steps as staging with its own secrets set one at a time; do not start it until
staging has run without problems for about two weeks (PLAN §6.18).

## Where to read next

| Need | Doc |
|---|---|
| What the system is, what breaks easily | [HANDOFF.md](HANDOFF.md) |
| Rules and the 13 invariants | [CLAUDE.md](CLAUDE.md) |
| Where code lives | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Next features | [ROADMAP.md](ROADMAP.md) (Hebrew) |
| Routes, commands, diagnosis | [ops/runbook.md](ops/runbook.md) |
| Rotating secrets, revoking tokens, restore | `ops/rotate-secrets.md`, `ops/revoke-tokens.md`, `ops/restore.md` |
