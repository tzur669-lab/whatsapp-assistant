# Image input — "an image is shared text, one step earlier" (PLAN §6.32)

Status: plan, 2026-10-14, reviewed (plan-review, 2 rounds; the last gap — one byte constant — fixed as the reviewer specified). The user's
decisions, 2026-10-14:

- **D1, revised 2026-10-14 (the user's decision): Gemini reads every image,
  in every conversation.** The user's Groq key has no vision model. Only the
  image goes to Gemini, never the request or the turn; the first answer says
  once that Gemini may train on it (`he.imageNotice`, setting
  `image_notice_at`). The code has one list, `VISION_MODELS` =
  [Gemini 3.5 Flash-Lite]; without the Gemini key images are "not available".
  The text below describes the first version of D1 where it differs.
- **D1 (first version) — who sees the image:** by the conversation's family, like the screen
  agent (§6.28): a regular conversation → a Groq vision model only
  (`VISION_MODELS`); a smart conversation → Gemini Flash-Lite only
  (`VISION_SMART_MODELS`). Never crossing. This **amends CLAUDE.md invariant
  2** ("shared text never reaches Gemini"): in a smart conversation the image —
  someone else's content, unscrubbed — reaches Gemini, which may train on it,
  for one read call with no tools, with no consent card. The user chose it
  (the option said so); the precedent is the screen (invariant 2, 2026-10-12).
  The text Gemini read then runs on the **local** models, as shared text does.
- **D2 — taint:** what the image says is someone else's text: the turn is
  forwarded, so tainted, so every write it leads to is CONFIRM.
- **D3 — scope:** every existing tool a tainted turn may use. Out of scope:
  "make it a routine" (waits for "the bot builds a routine", §6.27), and
  `routine.run` / `screen.task`, which already refuse tainted turns
  (`registry.ts` `refusesTainted`).

## The one idea

```
app ─signed POST /app/image (JSON: id, text, image base64, mimeType, conv?, mode?, location?)
  Worker: route, byte-counted cap 1 MB, bytes forwarded untouched
  DO: signature/device/nonce (existing) → strict Zod → magic bytes → hourly cap
  pipeline route(): recordInbound(kind 'image', mode) — before any await
     → handleImage: readImage(mode, mimeType, data)
         ONE vision call of the family (fixed prompt, no tools, 20 s per call,
         30 s in all) → the text it read: capped, control chars stripped
     → a synthetic event { kind:'text', forwarded:true, text: composeImage(userText, read) }
     → respondToText(…, { kind: 'text' })   ← the shared-text path, unchanged
```

`handleImage` builds the synthetic text event (the reviewer's choice): no
signature in `respondToText` / `smartWanted` / `respondWithModels` / `turnOf`
changes, and `data` (base64) never travels past `handleImage`.

From `respondToText` on, the shared-text rules hold unchanged, **including
storage** (option (a) of the review): in a local conversation the composed
text is kept in the encrypted history and in a suspended turn's `state.text`,
exactly like shared text (`pipeline.ts:1145`, `1138`); in a smart one the
history keeps `sharedPlaceholder` (`pipeline.ts:1236`, `1262`). The exchange
log already keeps `privatePlaceholder` for tainted turns (`pipeline.ts:753`).
Why: a follow-up ("now put the second date in too") needs the text, and the
history is code-encrypted, Groq-only, as for shared text. The **image bytes**
are never stored or logged anywhere.

## Why not give the image to the agent

qwen and gpt-oss have no vision. Multimodal agent messages would change
`AgentMessage`, the budget, history, suspended turns and both providers.
Extraction keeps the agent text-only and reuses reviewed rules.

## Server

1. `src/channels/app/parse.ts`: `parseImage` — strict `{ id, text
   (1..2000, not a command), image (string ≤ `MAX_IMAGE_B64_CHARS` = `4 * ceil(MAX_IMAGE_BYTES / 3)`,
   `MAX_IMAGE_BYTES = 700_000` — one byte constant, the same number in
   `ImageLogic.kt`, `Protocol.kt` and its test vector), mimeType ('image/jpeg'|'image/png'|'image/webp'),
   conversationId?, location?, mode? }`. Base64 check by
   `/[^A-Za-z0-9+/=]/` (negated class: ~1 ms on 1.4 M chars; the anchored
   alphabet regex took ~9 ms, measured 2026-10-14) plus length % 4 and `=` only
   at the end.
2. `src/channels/app/ingress.ts`: route `POST /app/image`, `maxBytes`
   1,048,576, JSON.
3. `src/channels/types.ts`: `InboundImage { kind:'image', wamid, from,
   sentAtMs, text, mimeType, data, forwarded, conversationId?, location?,
   mode? }`. Every `switch`/narrowing on `InboundEvent.kind` is updated
   (typecheck finds them); `recordInbound` records the mode for `image`.
4. `src/vision/read-image.ts` (new, plain Node): `createImageReader({
   local: VisionModel[], smart: VisionModel[], budget, fetch, now })`;
   `read({ mode, mimeType, data })` → `{ status:'ok', text } | { status:
   'unreadable'|'busy'|'quota'|'failed'|'not_configured' }`. One
   OpenAI-compatible chat call, content parts `[text, image_url data URI]`;
   the family's models in order, next on 429/503/network/timeout, never the
   other family. Per call `AbortSignal.timeout(20_000)`, whole read 30 s.
   Budget: reserve `VISION_RESERVE_TOKENS` (3,000) on that model id in
   `TokenBudget`, settle with the reported usage, `refused` on 429 (the
   existing ladder). Output: trimmed, control chars removed, capped to
   `MAX_SHARED_CHARS` (1,200); empty or the fixed `NO_TEXT` marker →
   `unreadable`. Model text is never parsed into an action. `fetch` through a
   closure; placed in `test/security/turn-signal-fetch.test.ts`.
5. `src/agent/models.ts`: `VISION_ONLY_MODELS` — a `ModelEntry` for the Groq
   vision model (`meta-llama/llama-4-scout-17b-16e-instruct`, **the id is
   confirmed by the human in the Groq console**, PLAN §13; minute tokens are a
   placeholder until then), found by `modelEntry`. `VISION_MODELS = [that id]`,
   `VISION_SMART_MODELS = [GEMINI_FLASH_LITE]` — **not** Gemini Flash, whose
   20-a-day cap belongs to the screen agent (`models.ts:143`). Tests: no
   vision model in `MODELS`; local and smart vision lists never share an id;
   `VISION_ONLY_MODELS` never in `MODELS`/`SMART_MODELS`.
6. `src/core/pipeline.ts`: `handleImage` (above); `PipelineDeps.readImage`
   optional — absent → `imageNotConfigured`. A read failure marks the inbound
   outcome `CLARIFY` with `E_IMAGE_<STATUS>`, like voice.
7. `src/platform/assistant-do.ts`: route; magic bytes on the first 16 base64
   chars decoded (JPEG `FF D8 FF`, PNG `89 50 4E 47`, WebP `RIFF….WEBP`),
   mismatch → 415; `IMAGES_PER_HOUR` 20 by `inboundCountSince('image')`, a
   retry of a recorded id is not new (as voice); the reader wired with the Groq
   key (local family) and the Gemini key (smart family; absent → the smart
   family is empty → `not_configured` in a smart conversation, never Groq).
8. `src/core/quota.ts` + `/app/quota`: role `'vision'` (one line per vision
   model, `dayTokens` true for Groq) and `images: { used, limit }` (optional
   field). The app labels `vision`; it does not show `images` yet (built
   2026-10-14: left for later).
9. `src/render/he.ts`: `imageHeader`, `imageUnreadable`, `imageBusy`,
   `imageQuota`, `imageFailed`, `imageTooMany`, `imageNotConfigured` — written
   with the `hebrew-content-writer` / `hebrew-i18n` skills.

No migration (inbound `kind` is free TEXT, `0001`). No new tool, catalog or
prompt change → Groq fingerprint unchanged; `pnpm eval:agent` not owed.

## App (0.19.0, versionCode 36)

- 📎 button next to the mic: `MediaStore.ACTION_PICK_IMAGES` when available,
  else `ACTION_GET_CONTENT image/*`. No storage permission.
- Share target for `image/*` (`ACTION_SEND`, `EXTRA_STREAM`): the image is
  read and prepared **at once** in `openFrom`, while the URI grant holds; only
  the prepared bytes are kept as `pendingImage`.
- Pending-image banner like pending text; a tap drops it; the mic is disabled
  while an image waits; a request with an image may not be a command
  (`ChatLogic.canSendWithShared`). Shared text and an image together: the
  image wins, the text becomes the request's prefill.
- `ImageLogic.kt` (pure, tested): long edge ≤ 1,600 px, JPEG quality 85→40 in
  steps until ≤ `MAX_IMAGE_BYTES` (700,000 bytes, not KiB), else refuse with a notice. `ImagePrep.kt`: decode
  with `inSampleSize`, EXIF rotation (`android.media.ExifInterface`),
  re-encode (drops EXIF, GPS included).
- `Api.sendImage` → `POST /app/image`; `Turns.sendImage` (`cheapResend =
  false`, like voice); outgoing kind `"image"`, shown as "📷 תמונה" + the
  request (`ChatLogic` next to `kind == "voice"`). The image is not kept.
- `Protocol.kt`: `MAX_IMAGE_BYTES = 700_000` (equal to the server's), the route; test vectors.
- Strings in `res/values/strings.xml` with the Hebrew skills.

**Server first**: an older server answers 404 for `/app/image`.

## Tests

Built as (2026-10-14): `test/unit/security/app-image-parse.test.ts`,
`test/unit/vision/read-image.test.ts`, the "an image" block in
`test/unit/agent/smart-turns.test.ts` (pipeline) and in
`test/unit/app/app-channel.test.ts` (DO), `test/unit/agent/vision-models.test.ts`,
plus the canary, device-routes and fetch-inventory additions below.

- parse: strict shape, caps, base64 check, command
  text, unknown field, mode.
- route cap: `test/security/device-routes.test.ts` (413 over 1 MB, 404 on WhatsApp).
- `/app/image` unsigned and unpaired → 401 (`app-channel.test.ts`).
- read-image (test first): family never crosses;
  429 → next; all out → `quota`; timeout → next; `NO_TEXT` → unreadable; cap and
  control chars; budget reserved/settled/refused; the request body has the
  data URI and the fixed prompt only (fake fetch, no network).
- pipeline: the turn is forwarded+tainted, a
  write → CONFIRM; smart conversation → reader called with `smart`, the turn on
  local providers; no reader → `imageNotConfigured`; failure statuses.
- `test/security/app-log-canary.test.ts`: neither base64 nor the read text in
  any log line.
- the vision table rules (item 5).
- DO: magic bytes → 415, hourly cap, wrong mime.
- `turn-signal-fetch.test.ts`: the new call site.
- App: `ImageLogicTest`, `ProtocolTest`, `QuotaLogicTest` (`vision` label), `ChatLogicTest`.

## Docs (same commits)

PLAN §6.32 (new), §13 (owed items), §14 (D1–D3, dated); CLAUDE.md invariant 2
(the image sentence) and invariant 13's neighbour line "an image is shared
text, one step earlier; the image is never stored or logged"; HANDOFF §1, §4
row, §6, §8; ARCHITECTURE (`src/vision/`, route); `ops/runbook.md` routes;
`apps/call-companion/README.md` (route, share target, 0.19.0).

## Owed after the build (PLAN §13)

- The human confirms the Groq vision model id and its limits in the console;
  a phone check with a real invitation, receipt and screenshot, Hebrew
  included.
- CPU of a 700 KB image in `wrangler dev` (Node estimate ~6 ms, 2026-10-14).
- Gemini's and Groq's real image token cost (the 3,000 reserve is a guess).

## Rejected objections

- "Two images in parallel both pay for a read before the agent lock"
  (concurrency NIT): accepted as-is — voice does the same (`pipeline.ts:480`),
  `Turns` sends one message at a time (`Turns.kt:29`), and the hourly cap bounds it.
