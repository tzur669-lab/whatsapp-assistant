/**
 * The single Durable Object. Every state change in the system is serialized
 * through this one instance, which is what rules out double-executed
 * confirmations and racing webhook retries (PLAN §3.3).
 *
 * It owns three things the portable core deliberately does not: the clock, the
 * storage handle, and the alarm. Everything else is plain TypeScript underneath
 * (CLAUDE.md invariant 11).
 */
import { Repository } from '../core/repo.js';
import { handleInbound } from '../core/pipeline.js';
import type { PipelineOutcome, Services } from '../core/pipeline.js';
import { snoozeButtons, SNOOZE_TOOL } from '../core/orchestrator.js';
import { SNOOZE_EXPIRY_MS } from '../confirm/undo.js';
import { createLogger, hashPrincipal } from '../security/redact.js';
import { SendError, WhatsAppSender } from '../channels/whatsapp/send.js';
import { classifyMetaError } from '../channels/whatsapp/errors.js';
import type { WaFailure } from '../channels/whatsapp/errors.js';
import { createVoiceTranscriber } from '../channels/whatsapp/voice.js';
import { createGroqWhisperProvider, WHISPER_MODEL } from '../voice/groq-whisper.js';
import { buildNluChain } from '../nlu/index.js';
import { ReminderStore } from '../tools/reminder-store.js';
import type { ClaimedReminder } from '../tools/reminder-store.js';
import { PendingActions } from '../confirm/pending.js';
import { OpenQuestions } from '../confirm/questions.js';
import { IcalStore } from '../ical/store.js';
import { BirthdayStore } from '../core/birthdays.js';
import { refreshFeed } from '../ical/refresh.js';
import { UndoActions } from '../confirm/undo.js';
import { GoogleStore } from '../google/store.js';
import { CalendarClient } from '../google/calendar.js';
import { buildAuthUrl, createPkce, exchangeCode, GOOGLE_SCOPES } from '../google/oauth.js';
import { parseKeyring } from '../security/crypto.js';
import { eventText } from '../render/events.js';
import { budgetState, isWindowOpen, RECHECK_BEFORE_MS } from '../policy/window.js';
import { reminderText } from '../render/reminders.js';
import { statusText } from '../render/status.js';
import { localPartsOf, ZONE } from '../time/tz.js';
import { buildDigest } from '../core/digest.js';
import { restPeriodAt } from '../time/shabbat.js';
import type { InboundEvent, OutboundButton, OutboundMessage } from '../channels/types.js';
import type { AppEnv, ChannelMode } from '../core/env.js';
import { channelOf } from '../core/env.js';
import { AppOutbox } from '../channels/app/outbox.js';
import type { OutboxKind, OutboxRow } from '../channels/app/outbox.js';
import {
  canonicalRequest,
  importDeviceKey,
  NONCE_TTL_MS,
  parseSignedHeaders,
  sha256Hex,
  verifyRequestSignature,
  withinClockSkew,
} from '../channels/app/verify.js';
import type { SignedHeaders } from '../channels/app/verify.js';
import { MESSAGE_ID, parseAck, parseMessage, parsePair, parsePushToken, parseReport } from '../channels/app/parse.js';
import { he } from '../render/he.js';
import { DeviceStore } from '../device/store.js';
import type { SigningDevice } from '../device/store.js';
import { FcmClient } from '../device/fcm.js';
import { createCallDispatcher } from '../device/calls.js';
import type { CallDispatcher } from '../device/calls.js';
import { callText } from '../render/calls.js';
import { DurableObjectSqlDriver } from './sql-repo.js';
import { MIGRATIONS } from './migrations.js';

const RETENTION_INBOUND_MS = 30 * 24 * 60 * 60 * 1000;

/** Late enough to be worth mentioning. Below this, nobody would notice. */
const LATE_THRESHOLD_MS = 60_000;

/** A floor on alarm scheduling, so a due-now reminder does not spin. */
const MIN_ALARM_DELAY_MS = 1_000;

/** Client message ids are namespaced, so they can never collide with a wamid. */
const APP_INBOUND_PREFIX = 'app:in:';

/**
 * A message recorded this long ago with no answer and no decision did not
 * finish. Nobody knows whether its tool ran, so the app is told exactly that —
 * and the message is never run a second time (§6.18).
 */
const UNKNOWN_AFTER_MS = 2 * 60 * 1000;

/** Recordings per hour the app may send, checked before Whisper is paid for. */
const VOICE_PER_HOUR = 60;

/** What the app records — AAC in an MP4 container — and the few types alike. */
const AUDIO_TYPES: ReadonlySet<string> = new Set(['audio/mp4', 'audio/aac', 'audio/ogg', 'audio/webm']);

const HOUR_MS = 60 * 60 * 1000;

/** What `send` knows afterwards: the id, or why it did not go (PLAN §6.8). */
type SendOutcome = { ok: true; wamid: string } | { ok: false; failure: WaFailure };

export class AssistantDO implements DurableObject {
  private readonly repo: Repository;
  private readonly sql: DurableObjectSqlDriver;
  private readonly reminders: ReminderStore;
  private readonly pending: PendingActions;
  private readonly questions: OpenQuestions;
  private readonly ical: IcalStore;
  private readonly birthdays: BirthdayStore;
  private readonly deferred: UndoActions;
  private readonly google: GoogleStore;
  private readonly devices: DeviceStore;
  private readonly outbox: AppOutbox;
  private readonly log = createLogger({ component: 'assistant_do' });

  /** Imported device keys, by device id. Public keys, so nothing secret is cached. */
  private readonly deviceKeys = new Map<string, CryptoKey>();

  /**
   * Held for the life of the object, so one refreshed access token serves many
   * requests. It is memory only — nothing about it is written down (§6.6).
   */
  private calendar: CalendarClient | null = null;

  /** Holds FCM's access token between pushes, in memory only, like the calendar's. */
  private fcm: FcmClient | null = null;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: AppEnv,
    /**
     * The platform always constructs this with exactly (state, env); the third
     * parameter exists so tests can drive the whole object — alarm, delivery,
     * retries — without workerd and without the network.
     */
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.sql = new DurableObjectSqlDriver(ctx.storage);
    this.repo = new Repository(this.sql);
    const now = () => Date.now();
    this.reminders = new ReminderStore(this.sql, now);
    this.pending = new PendingActions(this.sql, now);
    this.questions = new OpenQuestions(this.sql, now);
    this.ical = new IcalStore(this.sql, now);
    this.birthdays = new BirthdayStore(this.sql, now);
    this.deferred = new UndoActions(this.sql, now);
    this.google = new GoogleStore(this.sql, now, () =>
      parseKeyring(this.env as unknown as Record<string, string | undefined>),
    );
    this.devices = new DeviceStore(
      this.sql,
      now,
      () => this.env.DEVICE_TOKEN_PEPPER ?? '',
      () => parseKeyring(this.env as unknown as Record<string, string | undefined>),
    );

    this.outbox = new AppOutbox(this.sql, this.repo, now);

    // blockConcurrencyWhile keeps requests queued until the schema is ready.
    void this.ctx.blockConcurrencyWhile(async () => {
      const version = this.repo.migrate(MIGRATIONS);
      this.log.info('schema_ready', { version });
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/do/inbound' && request.method === 'POST') {
      const event = (await request.json()) as InboundEvent;
      await this.processEvent(event);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === '/do/oauth/start' && request.method === 'POST') {
      const { linkId } = (await request.json()) as { linkId: string };
      return json(await this.startOAuth(linkId));
    }

    if (url.pathname === '/do/oauth/callback' && request.method === 'POST') {
      const { code, state } = (await request.json()) as { code: string; state: string };
      return json(await this.finishOAuth(code, state));
    }

    if (url.pathname === '/do/app' && request.method === 'POST') {
      return this.appRequest(request);
    }

    if (url.pathname === '/do/maintenance' && request.method === 'POST') {
      await this.runMaintenance();
      return new Response(null, { status: 204 });
    }

    if (url.pathname === '/do/tick' && request.method === 'POST') {
      await this.maybeSendDigest();
      return new Response(null, { status: 204 });
    }

    return new Response('not found', { status: 404 });
  }

  /**
   * Deliver everything that is due (PLAN §6.7).
   *
   * The claim/lease protocol is what makes this safe to re-enter: a row is
   * claimed before it is sent and marked sent afterwards, so a crash in between
   * leaves a lease that expires rather than a reminder that vanishes or fires
   * twice.
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    const principal = await this.selfPrincipal();

    // Before any of the holds below: a call that went unanswered is reported
    // now, because it was asked for now. Shabbat does not hold a call (§6.17),
    // and the user wrote in seconds ago, so the window is open.
    await this.expireDispatches();

    // Also before the holds: an unacked row is re-pushed and an expired one
    // retired on its own schedule, Shabbat or not — it is already on the phone's
    // side of the line (§6.18).
    await this.serviceOutbox();

    // Outside the 24-hour window nothing but a paid template gets through, so a
    // send here is not a send that fails — it is one that must not be attempted.
    // The reminder is held and looked at again, and arrives late with a note.
    if (!this.canDeliver(principal, now)) {
      this.log.info('delivery_deferred', { reason: 'window_or_budget' });
      await this.armAlarm(now + RECHECK_BEFORE_MS);
      return;
    }

    // Shabbat and chagim, when the user asked for it (PLAN §6.13). Held rather
    // than dropped, and the alarm is re-armed for the end of the period, so the
    // whole run is skipped in one decision instead of once per reminder.
    if (this.repo.restHoldEnabled()) {
      const rest = restPeriodAt(now);
      if (rest) {
        this.log.info('delivery_deferred', { reason: 'rest_period', kind: rest.kind });
        await this.armAlarm(rest.endUtc + 1_000);
        return;
      }
    }

    const due = this.reminders.claimDue();
    this.log.info('alarm_fired', { claimed: due.length });

    for (const reminder of due) {
      await this.deliver(reminder, now);
    }

    // Reminders that ran out of attempts are reported once, then closed.
    for (const abandoned of this.reminders.takeFailed()) {
      await this.send({
        to: this.selfWaId(),
        text: reminderText.deliveryGaveUp(
          {
            id: abandoned.id,
            text: abandoned.text,
            local: localPartsOf(abandoned.dueAtUtc, abandoned.tz),
          },
          'he',
        ),
      });
    }

    await this.armAlarm();
  }

  // -- OAuth -----------------------------------------------------------------

  /**
   * Turn a one-time link into a redirect to Google.
   *
   * The link is consumed here, not at the callback: a link that has sent
   * someone to Google's consent screen has been used, whether or not they
   * finished. The PKCE verifier is generated now and stored with the `state`,
   * so the code that comes back can only be exchanged by this attempt.
   */
  private async startOAuth(linkId: string): Promise<{ redirectUrl: string } | { error: string }> {
    const link = this.google.useLink(linkId);
    if (!link.ok) {
      this.log.warn('oauth_link_rejected', { reason: link.reason });
      return { error: link.reason };
    }

    const pkce = await createPkce();
    const { state } = this.google.createState(link.value.principal, pkce.verifier);

    return {
      redirectUrl: buildAuthUrl({
        clientId: this.env.GOOGLE_CLIENT_ID,
        redirectUri: this.redirectUri(),
        state,
        challenge: pkce.challenge,
        scopes: GOOGLE_SCOPES,
      }),
    };
  }

  /** Exchange the code and store the grant. The `state` is single use. */
  private async finishOAuth(code: string, state: string): Promise<{ ok: true } | { error: string }> {
    const attempt = this.google.useState(state);
    if (!attempt.ok) {
      this.log.warn('oauth_state_rejected', { reason: attempt.reason });
      return { error: attempt.reason };
    }

    const result = await exchangeCode(
      {
        code,
        codeVerifier: attempt.value.codeVerifier,
        clientId: this.env.GOOGLE_CLIENT_ID,
        clientSecret: this.env.GOOGLE_CLIENT_SECRET,
        redirectUri: this.redirectUri(),
      },
      this.fetchImpl,
    );

    if (!result.ok) {
      this.log.warn('oauth_exchange_failed', { errorCode: result.error.code });
      return { error: result.error.code };
    }
    if (!result.grant.refreshToken) {
      // Without one there is no standing access, only an hour of it. Better to
      // fail the connect than to look connected and stop working silently.
      this.log.warn('oauth_no_refresh_token', {});
      return { error: 'no_refresh_token' };
    }

    await this.google.connect({
      refreshToken: result.grant.refreshToken,
      scopes: result.grant.scopes,
    });
    this.calendar = null;

    this.log.info('google_connected', { scopes: result.grant.scopes.length });
    await this.send({ to: this.selfWaId(), text: eventText.connected('he') });
    return { ok: true };
  }

  private redirectUri(): string {
    return `${(this.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '')}/oauth/google/callback`;
  }

  /** Daily cron entry point (PLAN §6.7). */
  async runMaintenance(): Promise<void> {
    this.repo.purgeInboundBefore(Date.now() - RETENTION_INBOUND_MS);
    this.repo.purgeOutboundBefore(Date.now() - RETENTION_INBOUND_MS);
    this.pending.expireStale();
    this.questions.purgeExpired();
    this.deferred.expireStale();
    this.google.purgeExpired();
    this.devices.purge();
    await this.refreshFeeds();
    await this.armAlarm();
    this.log.info('maintenance_done', {});
  }

  /**
   * Refresh every subscribed feed, once a day (PLAN §6.15).
   *
   * One at a time and never fatal: a feed that is down is a feed whose cached
   * events stay exactly where they are, and it must not stop the rest of
   * maintenance from running.
   */
  private async refreshFeeds(): Promise<void> {
    const now = Date.now();
    for (const feed of this.ical.all()) {
      try {
        await refreshFeed({
          store: this.ical,
          feed,
          nowMs: now,
          log: this.log,
          fetchImpl: this.fetchImpl,
        });
      } catch {
        this.ical.markFailed(feed.id, 'E_ICAL_UNKNOWN');
      }
    }
  }

  // -- the daily digest ------------------------------------------------------

  /**
   * Hourly cron entry point (PLAN §6.12).
   *
   * Hourly rather than at a fixed time because the digest hour is a setting, and
   * a cron expression cannot be changed by a chat message — nor should it be
   * (invariant 8). So the schedule is dumb and the decision is here: is it that
   * hour locally, and has today's digest been dealt with?
   *
   * "Dealt with" rather than "sent": a day with nothing to say is marked done
   * without a message. Otherwise every quiet day would retry for an hour and
   * then give up, having decided nothing.
   */
  async maybeSendDigest(): Promise<void> {
    const now = Date.now();
    const hour = this.repo.digestHour();
    if (hour === null) return;

    const local = localPartsOf(now, ZONE);
    if (local.hour !== hour) return;

    const dayKey = Repository.dayKey(now);
    if (this.repo.digestDoneOn() === dayKey) return;

    const principal = await this.selfPrincipal();

    // The same gate a reminder passes. A digest outside the 24-hour window is
    // not a message that fails — it is one that must not be attempted (§5).
    if (!this.canDeliver(principal, now)) {
      this.log.info('digest_skipped', { reason: 'window_or_budget' });
      // Deliberately not marked done: if the user writes in during this hour the
      // window opens and the next tick can still send it.
      return;
    }

    // Shabbat and chagim hold the digest too (§6.13). A brief that arrives at
    // seven on Saturday morning is the exact thing that setting is for.
    if (this.repo.restHoldEnabled() && restPeriodAt(now)) {
      this.log.info('digest_skipped', { reason: 'rest_period' });
      // Not marked done: a digest held on Saturday morning is simply not sent,
      // and tomorrow's is a different day's message.
      return;
    }

    // Marked before the send, not after. A digest is worth exactly one attempt:
    // it is about today, and a retry an hour later is a different message.
    this.repo.markDigestDone(dayKey);

    const text = await buildDigest({
      nowMs: now,
      principal,
      lang: 'he',
      reminders: this.reminders,
      ical: this.ical,
      birthdays: this.birthdays,
      log: this.log,
      ...(this.calendarClient() ? { calendar: this.calendarClient()! } : {}),
    });
    if (text === null) return;

    await this.send({ to: this.selfWaId(), text }, { kind: 'digest', principal });
  }

  // -- inbound ---------------------------------------------------------------

  private async processEvent(event: InboundEvent): Promise<void> {
    const principal =
      event.kind === 'status'
        ? 'p_system'
        : await hashPrincipal(event.from, this.env.LOG_HASH_KEY);

    const outcome = await handleInbound(event, {
      repo: this.repo,
      log: this.log,
      now: () => Date.now(),
      principal,
      services: this.services(),
      ...(this.env.GROQ_API_KEY ? { transcribe: this.voiceTranscriber() } : {}),
    });

    if (outcome.action === 'reply' && event.kind !== 'status') {
      await this.reply(event.from, outcome);
    }

    // A new or cancelled reminder moves when the next alarm should fire, and so
    // does a call dispatch, which has to be answered for if the phone is silent.
    if (outcome.rescheduleAlarm || (outcome.action === 'none' && outcome.reason === 'reply_deferred')) {
      await this.armAlarm();
    }
  }

  private async reply(to: string, outcome: Extract<PipelineOutcome, { action: 'reply' }>): Promise<void> {
    await this.send({
      to,
      text: outcome.text,
      ...(outcome.buttons ? { buttons: outcome.buttons } : {}),
    });
  }

  // -- the app channel (PLAN §6.17, §6.18) ------------------------------------

  /**
   * One request from the phone, forwarded by the Worker with its body untouched —
   * the signature covers those exact bytes.
   *
   * The order is fixed, like the webhook's (invariant 9): the device's key
   * (synchronous) → the signature (awaited, no state touched) → one synchronous
   * block: device still active, nonce spent → the body parsed → the handler,
   * whose first act is to record the message, which is the one dedupe. Nothing
   * awaits between the block and that record.
   */
  private async appRequest(request: Request): Promise<Response> {
    const method = (request.headers.get('x-app-method') ?? '').toUpperCase();
    const path = request.headers.get('x-app-path') ?? '';
    const contentType = request.headers.get('x-app-content-type') ?? '';
    const body = new Uint8Array(await request.arrayBuffer());
    if (!this.env.DEVICE_TOKEN_PEPPER) return appError(503, 'not_configured');

    const principal = await this.selfPrincipal();

    if (method === 'POST' && path === '/app/pair') return this.appPair(body, principal);

    const signed = parseSignedHeaders((name) => request.headers.get(name));
    if (!signed) return appError(401, 'unauthorized');

    const verified = await this.verifySigned(method, path, signed, body, principal);
    if (verified instanceof Response) return verified;
    const device = verified;

    const gate = this.sql.transaction(() => {
      if (!this.devices.isActive(device.id)) return 'unpaired' as const;
      if (!this.devices.claimNonce(device.id, signed.nonce, signed.timestamp + NONCE_TTL_MS)) return 'replay' as const;
      return 'ok' as const;
    });
    if (gate === 'unpaired') return appError(401, 'unpaired');
    if (gate === 'replay') {
      this.log.warn('app_replay_refused', { deviceId: device.id });
      return appError(409, 'replay');
    }

    return this.routeSigned({ method, path, contentType, body, signed, device, principal });
  }

  /** The device's key, and the signature over the canonical string. Touches no state. */
  private async verifySigned(
    method: string,
    path: string,
    signed: SignedHeaders,
    body: Uint8Array,
    principal: string,
  ): Promise<SigningDevice | Response> {
    const device = this.devices.signingDevice(signed.deviceId);
    // A device of another principal is a device of a different configuration —
    // `ALLOWLIST_WA_IDS` or `LOG_HASH_KEY` changed. It pairs again.
    if (!device || device.principal !== principal) return appError(401, 'unpaired');
    if (!withinClockSkew(signed.timestamp, Date.now())) return appError(401, 'clock');

    let key = this.deviceKeys.get(device.id) ?? null;
    if (!key) {
      key = await importDeviceKey(device.publicKey);
      if (!key) return appError(401, 'unpaired');
      this.deviceKeys.set(device.id, key);
    }

    const canonical = canonicalRequest({
      method,
      path,
      deviceId: device.id,
      timestamp: signed.timestamp,
      nonce: signed.nonce,
      bodySha256Hex: await sha256Hex(body),
    });
    if (!(await verifyRequestSignature(key, canonical, signed.signature))) {
      this.log.warn('app_signature_refused', { deviceId: device.id });
      return appError(401, 'unauthorized');
    }
    return device;
  }

  private routeSigned(request: {
    method: string;
    path: string;
    contentType: string;
    body: Uint8Array;
    signed: SignedHeaders;
    device: SigningDevice;
    principal: string;
  }): Response | Promise<Response> {
    const { method, path, body, signed, device, principal } = request;
    const app = this.channel() === 'app';

    if (app && method === 'POST' && path === '/app/message') return this.appMessage(body, signed, device, principal);

    const voice = /^\/app\/voice\/([0-9a-f-]{36})$/.exec(path);
    if (app && method === 'POST' && voice) {
      return this.appVoice(voice[1]!, body, request.contentType, signed, device, principal);
    }

    if (app && method === 'GET' && path === '/app/outbox') return json(this.outbox.list());
    if (app && method === 'POST' && path === '/app/outbox/ack') return this.appAck(body);
    if (method === 'POST' && path === '/app/push-token') return this.appPushToken(body, device);

    const dispatch = /^\/device\/dispatch\/([0-9a-f]{32})$/.exec(path);
    if (method === 'GET' && dispatch) {
      const fetched = this.devices.fetchDispatch(dispatch[1]!, device.id);
      return fetched.ok ? json(fetched.value) : appError(404, fetched.reason);
    }
    if (method === 'POST' && path === '/device/report') return this.appReport(body, device);

    return appError(404, 'not_found');
  }

  /** Pairing: the phone proves it knows a live code without sending it (§6.18). */
  private async appPair(body: Uint8Array, principal: string): Promise<Response> {
    const request = parsePair(body);
    if (!request) return appError(400, 'bad_request');

    const paired = await this.devices.pair(request, {
      principal,
      bootstrapCode: this.env.PAIR_BOOTSTRAP_CODE ?? null,
    });
    if (!paired.ok) {
      this.log.warn('device_pair_rejected', { errorCode: paired.reason });
      return appError(400, 'invalid_code');
    }

    this.deviceKeys.clear();
    this.log.info('device_paired', { deviceId: paired.value.deviceId, reused: paired.value.reused });
    // Reminders held while no phone was paired can go now.
    await this.armAlarm();
    return json({ deviceId: paired.value.deviceId });
  }

  private appMessage(
    body: Uint8Array,
    signed: SignedHeaders,
    device: SigningDevice,
    principal: string,
  ): Response | Promise<Response> {
    const message = parseMessage(body);
    if (!message) return appError(400, 'bad_request');

    const base = {
      wamid: `${APP_INBOUND_PREFIX}${message.id}`,
      from: this.selfWaId(),
      // The signed timestamp, already within five minutes of ours: one clock.
      sentAtMs: signed.timestamp,
      forwarded: false,
    };
    const event: InboundEvent =
      message.kind === 'text'
        ? { kind: 'text', ...base, text: message.text }
        : { kind: 'button', ...base, buttonId: message.buttonId };
    return this.runAppTurn(event, message.id, device.id, principal);
  }

  private appVoice(
    messageId: string,
    body: Uint8Array,
    contentType: string,
    signed: SignedHeaders,
    device: SigningDevice,
    principal: string,
  ): Response | Promise<Response> {
    if (!MESSAGE_ID.test(messageId)) return appError(400, 'bad_request');
    const mimeType = contentType.split(';')[0]!.trim().toLowerCase();
    if (!AUDIO_TYPES.has(mimeType)) return appError(415, 'unsupported_type');
    if (body.length === 0) return appError(400, 'bad_request');

    const wamid = `${APP_INBOUND_PREFIX}${messageId}`;

    // Whisper is paid for in free-tier quota, so an hour's recordings are
    // capped before it is called. A retry of one already recorded is not new.
    if (!this.repo.getInbound(wamid) && this.repo.inboundCountSince('audio', Date.now() - HOUR_MS) >= VOICE_PER_HOUR) {
      this.log.warn('voice_rate_limited', {});
      return json({ status: 'reply', row: this.acceptReply(messageId, principal, he.voiceTooMany, he.voiceTooMany, []) });
    }

    const event: InboundEvent = {
      kind: 'audio',
      wamid,
      from: this.selfWaId(),
      sentAtMs: signed.timestamp,
      mediaId: '',
      mimeType,
      bytes: body,
      voiceNote: true,
      forwarded: false,
    };
    return this.runAppTurn(event, messageId, device.id, principal);
  }

  /**
   * One turn, and its one answer — in the HTTP response and in the outbox, so
   * a response lost on the way is still delivered (§6.18).
   */
  private async runAppTurn(
    event: InboundEvent,
    messageId: string,
    deviceId: string,
    principal: string,
  ): Promise<Response> {
    const startedAt = Date.now();
    let outcome: PipelineOutcome;
    try {
      outcome = await handleInbound(event, {
        repo: this.repo,
        log: this.log,
        now: () => Date.now(),
        principal,
        channel: 'app',
        services: this.services(),
        ...(this.env.GROQ_API_KEY ? { transcribe: this.voiceTranscriber() } : {}),
      });
    } catch (error) {
      // The message is recorded, so a retry will not run it again — and a tool
      // may already have run. Say so, rather than "nothing happened".
      this.log.error('app_turn_failed', { errorCode: error instanceof Error ? error.name : 'E_UNKNOWN' });
      this.repo.markInboundOutcome(event.wamid, { decision: 'ERROR', errorCode: 'E_TURN_FAILED' });
      const row = this.acceptReply(messageId, principal, he.unknownOutcome, he.unknownOutcome, []);
      await this.armAlarm();
      return json({ status: 'reply', row });
    }

    if (outcome.action === 'none' && outcome.reason === 'duplicate') {
      return json(this.duplicateAnswer(messageId));
    }

    // The turn unpaired this phone (`/pair off`). Its answer goes back in the
    // response only: stored, it would wait for a phone that can no longer
    // fetch it, and greet whichever phone pairs next.
    if (!this.devices.isActive(deviceId)) {
      await this.armAlarm();
      if (outcome.action !== 'reply') return json({ status: 'done' });
      return json({
        status: 'reply',
        row: { seq: 0, kind: 'reply', inReplyTo: messageId, text: outcome.text, buttons: [], createdAt: Date.now() },
      });
    }

    let row: OutboxRow | null = null;
    if (outcome.action === 'reply') {
      // The stored copy never carries the transcript (§6.10).
      const stored =
        outcome.withoutEcho === undefined ? outcome.text : `${outcome.withoutEcho}\n\n${he.heardNotKept}`;
      row = this.acceptReply(messageId, principal, outcome.text, stored, outcome.buttons ?? []);
    } else if (outcome.reason === 'reply_deferred') {
      // A call: its outcome comes later, as an answer to this same message.
      this.devices.linkLatestDispatch(messageId, startedAt);
      const text = callText.sentToPhone('he');
      row = this.acceptReply(messageId, principal, text, text, []);
    }

    await this.armAlarm();
    return json(row ? { status: 'reply', row } : { status: 'done' });
  }

  /** Write the answer to one message. The HTTP copy may carry what the stored one must not. */
  private acceptReply(
    messageId: string,
    principal: string,
    httpText: string,
    storedText: string,
    buttons: readonly OutboundButton[],
  ): OutboxRow {
    const accepted = this.sql.transaction(() =>
      this.outbox.accept({ kind: 'reply', text: storedText, buttons, inReplyTo: messageId, principal }),
    );
    const row = this.outbox.get(accepted.seq);
    return { ...(row ?? { seq: accepted.seq, kind: 'reply', inReplyTo: messageId, buttons: [...buttons], createdAt: Date.now() }), text: httpText };
  }

  /**
   * The same message again — a retry after a timeout. Its answer if there is
   * one; otherwise whether it is still running, finished without an answer, or
   * lost part-way. Never run a second time.
   */
  private duplicateAnswer(messageId: string): Record<string, unknown> {
    const row = this.outbox.replyTo(messageId);
    if (row) return { status: 'reply', row };

    const inbound = this.repo.getInbound(`${APP_INBOUND_PREFIX}${messageId}`);
    if (inbound && inbound['decision'] !== null && inbound['decision'] !== undefined) return { status: 'done' };
    if (inbound && Date.now() - Number(inbound['received_at']) > UNKNOWN_AFTER_MS) return { status: 'unknown' };
    return { status: 'pending' };
  }

  /** The phone has these rows. Only these — never "everything up to". */
  private async appAck(body: Uint8Array): Promise<Response> {
    const ack = parseAck(body);
    if (!ack) return appError(400, 'bad_request');

    const { reminderIds } = this.sql.transaction(() => this.outbox.ack(ack.seqs));

    // Delivered, so a calendar stand-in written back on WhatsApp would be a
    // second copy. Its removal is separate from the ack: a leftover popup is
    // harmless, a lost ack is not.
    for (const id of reminderIds) {
      const reminder = this.reminders.byId(id);
      if (reminder?.backupEventId) {
        try {
          await this.dropBackupEvent(reminder);
        } catch {
          this.log.warn('backup_event_drop_failed', { reminderId: id });
        }
      }
    }
    return json({ ok: true });
  }

  private async appPushToken(body: Uint8Array, device: SigningDevice): Promise<Response> {
    const parsed = parsePushToken(body);
    if (!parsed) return appError(400, 'bad_request');
    await this.devices.setPushToken(device.id, parsed.pushToken);
    await this.armAlarm();
    return json({ ok: true });
  }

  private async appReport(body: Uint8Array, device: SigningDevice): Promise<Response> {
    const parsed = parseReport(body);
    if (!parsed) return appError(400, 'bad_request');

    const reported = this.devices.report(parsed.dispatchId, device.id, {
      matched: parsed.matched,
      outcome: parsed.outcome,
    });
    if (!reported.ok) return appError(404, reported.reason);

    // Outcome and count only. What the phone matched never arrives here.
    this.log.info('call_settled', { dispatchId: parsed.dispatchId, outcome: reported.value.outcome });
    const inReplyTo = this.devices.inReplyToOf(parsed.dispatchId);
    await this.send(
      { to: this.selfWaId(), text: callText.outcome(reported.value.outcome, 'he') },
      { kind: 'call', principal: reported.value.principal, ...(inReplyTo ? { inReplyTo } : {}) },
    );
    await this.armAlarm();
    return json({ ok: true });
  }

  /**
   * Retire what nobody fetched in time, and push what is due (§6.18). Pushes go
   * out only on the app channel; expiry runs on every channel, because rows
   * hold message text and must not outlive their time even with the app off.
   */
  private async serviceOutbox(): Promise<void> {
    this.devices.purgeNonces(Date.now());

    const expired = this.sql.transaction(() => {
      const result = this.outbox.expireDue();
      for (const id of result.reminderIds) this.reminders.retireSent(id);
      return result;
    });
    if (expired.expired > 0) {
      this.log.warn('outbox_expired', { rows: expired.expired, reminders: expired.reminderIds.length });
    }

    if (this.channel() === 'app') await this.pushOutbox();
  }

  /**
   * One push for everything due, carrying only "there is something". Whether it
   * went or not, each row's schedule moves on: a failed push waits for the next
   * slot rather than spinning the alarm.
   */
  private async pushOutbox(): Promise<void> {
    const due = this.outbox.duePushes();
    if (due.length === 0) return;

    const device = this.devices.activeDevice(await this.selfPrincipal());
    const token = device ? await this.devices.pushTokenOf(device.id) : null;
    const fcm = this.fcmClient();

    if (device && token && fcm) {
      const pushed = await fcm.signal(token);
      if (!pushed.ok) {
        this.log.warn('outbox_push_failed', {
          errorCode: `E_PUSH_${pushed.reason.toUpperCase()}`,
          ...(pushed.status === undefined ? {} : { status: pushed.status }),
        });
        if (pushed.reason === 'unregistered') {
          this.devices.forgetPushToken(device.id);
          this.repo.setLastErrorCode('E_PUSH_UNREGISTERED');
        }
      }
    } else {
      this.log.info('outbox_push_skipped', { device: device !== null, token: token !== null, fcm: fcm !== null });
    }

    this.outbox.markPushed(due);
  }

  private channel(): ChannelMode {
    return channelOf(this.env);
  }

  /** Report every dispatch the phone never answered. Once each: the sweep settles it. */
  private async expireDispatches(): Promise<void> {
    for (const expired of this.devices.expireDue()) {
      this.log.info('call_settled', { dispatchId: expired.id, outcome: 'expired' });
      const inReplyTo = this.devices.inReplyToOf(expired.id);
      await this.send(
        { to: this.selfWaId(), text: callText.outcome('expired', 'he') },
        { kind: 'call', principal: expired.principal, ...(inReplyTo ? { inReplyTo } : {}) },
      );
    }
  }

  /** Present only when both the device pepper and the push key are configured. */
  private callDispatcher(): CallDispatcher | null {
    const fcm = this.fcmClient();
    if (!this.env.DEVICE_TOKEN_PEPPER || !fcm) return null;
    return createCallDispatcher({ store: this.devices, push: fcm, log: this.log });
  }

  /** Present when the push key is configured. Holds its access token in memory only. */
  private fcmClient(): FcmClient | null {
    if (!this.env.FCM_SA_KEY) return null;
    this.fcm ??= new FcmClient({
      serviceAccountJson: this.env.FCM_SA_KEY,
      ...(this.env.FCM_PROJECT_ID ? { projectId: this.env.FCM_PROJECT_ID } : {}),
      fetchImpl: this.fetchImpl,
    });
    return this.fcm;
  }

  // -- delivery --------------------------------------------------------------

  private async deliver(reminder: ClaimedReminder, now: number): Promise<void> {
    const lines = [reminderText.due(reminder.text, 'he')];

    if (reminder.lateByMs > LATE_THRESHOLD_MS) {
      lines.push(reminderText.lateNote(Math.round(reminder.lateByMs / 60_000), 'he'));
    }

    // The snooze offer is written down before the send, and is one-shot: the
    // same gates as a confirmation, for the same reason (PLAN §6.5).
    const offer = this.deferred.offer({
      tool: SNOOZE_TOOL,
      compensating: { reminderId: reminder.id, text: reminder.text, tz: reminder.tz },
      principal: reminder.principal,
      expiryMs: SNOOZE_EXPIRY_MS,
    });

    if (this.channel() === 'app') {
      // Acceptance, `markSent` and the audit row land together or not at all
      // (§6.18). The calendar stand-in, if WhatsApp wrote one, goes on ack.
      const accepted = this.sql.transaction(() => {
        const row = this.outbox.accept({
          kind: 'reminder',
          text: lines.join('\n'),
          buttons: snoozeButtons(offer.id, offer.nonce, 'he'),
          reminderId: reminder.id,
          principal: reminder.principal,
        });
        this.reminders.markSent(reminder.id, row.wamid);
        this.repo.audit({
          ts: now,
          principal: reminder.principal,
          tool: 'reminders.deliver',
          tier: 0,
          decision: 'ALLOW',
          outcome: 'ok',
          externalRef: reminder.id,
        });
        return row;
      });
      if (accepted.adopted) this.log.error('outbox_row_adopted', { reminderId: reminder.id });
      await this.pushOutbox();
      return;
    }

    const sent = await this.send(
      {
        to: this.selfWaId(),
        text: lines.join('\n'),
        buttons: snoozeButtons(offer.id, offer.nonce, 'he'),
      },
      { kind: 'reminder', principal: reminder.principal, reminderId: reminder.id },
    );

    if (sent.ok) {
      this.reminders.markSent(reminder.id, sent.wamid);
      // It arrived over WhatsApp after all, so the calendar stand-in would be a
      // second copy of the same reminder. Remove it (PLAN §6.7).
      await this.dropBackupEvent(reminder);
      this.repo.audit({
        ts: now,
        principal: reminder.principal,
        tool: 'reminders.deliver',
        tier: 0,
        decision: 'ALLOW',
        outcome: 'ok',
        externalRef: reminder.id,
      });
    } else if (sent.failure.disposition === 'retry' || sent.failure.disposition === 'back_off') {
      // The attempt was already counted by the claim, so this only releases it.
      this.reminders.markFailed(reminder.id);
    } else {
      // A shut window or an undeliverable recipient answers the same way every
      // time. Stop, report it once, and leave the calendar stand-in in place —
      // which is the whole reason it is written at creation (PLAN §6.7, §6.8).
      this.reminders.abandon(reminder.id);
    }
  }

  private async dropBackupEvent(reminder: { id: string; backupEventId: string | null }): Promise<void> {
    const calendar = this.calendarClient();
    if (!reminder.backupEventId || !calendar) return;

    const calendarId = await calendar.remindersCalendarId();
    if (!calendarId.ok) return;

    await calendar.deleteEvent({
      eventId: reminder.backupEventId,
      calendarId: calendarId.value,
    });
    this.reminders.setBackupEvent(reminder.id, null);
  }

  /**
   * Whether a WhatsApp send can be attempted at all.
   *
   * The budget is checked first: unlike a shut window it will not fix itself
   * when the user writes back (PLAN §5, §6.7).
   */
  private canDeliver(principal: string, now: number): boolean {
    const channel = this.channel();
    if (channel === 'off') return false;
    // The app has no window and no budget; it needs only a phone to go to.
    // Without one, reminders are held rather than spent (§6.18).
    if (channel === 'app') return this.devices.activeDevice(principal) !== null;

    const sent = this.repo.counters(Repository.monthKey(now)).waSent;
    if (budgetState(sent).level === 'exhausted') return false;
    return isWindowOpen(this.repo.lastInboundAt(principal), now);
  }

  // -- outbound --------------------------------------------------------------

  /** The one place a message leaves the system, and the one place it is counted. */
  private async send(
    message: OutboundMessage,
    /** What this message is, and which reminder it carries (PLAN §6.8). */
    track: { kind: string; principal?: string; reminderId?: string; inReplyTo?: string } = { kind: 'reply' },
  ): Promise<SendOutcome> {
    const channel = this.channel();
    if (channel === 'app') return this.sendToApp(message, track);
    if (channel === 'off') {
      this.log.info('send_skipped', { reason: 'channel_off', kind: track.kind });
      return { ok: false, failure: classifyMetaError(null, null) };
    }

    const sender = new WhatsAppSender({
      phoneNumberId: this.env.WA_PHONE_NUMBER_ID,
      accessToken: this.env.WA_ACCESS_TOKEN,
      fetchImpl: this.fetchImpl,
    });

    // Timed here rather than in the pipeline: the send happens after the turn
    // has returned its reply, so the pipeline does not know about it (§6.14).
    const startedAt = Date.now();

    try {
      const result = await sender.send(this.withBudgetWarning(message));
      const now = Date.now();
      this.repo.bumpCounter(Repository.monthKey(now), 'wa_sent');

      // Written down *because* the 200 is not a delivery. Until the status
      // webhook arrives this row says `accepted`, which is all we know.
      this.repo.recordOutbound({
        wamid: result.wamid,
        kind: track.kind,
        sentAt: now,
        ...(track.principal ? { principal: track.principal } : {}),
        ...(track.reminderId ? { reminderId: track.reminderId } : {}),
      });

      this.log.info('message_sent', {
        wamid: result.wamid,
        buttons: message.buttons?.length ?? 0,
        sendMs: now - startedAt,
      });
      return { ok: true, wamid: result.wamid };
    } catch (error) {
      const failure =
        error instanceof SendError
          ? error.failure
          : classifyMetaError(null, null);

      this.log.error('send_failed', {
        errorCode: failure.errorCode,
        disposition: failure.disposition,
        sendMs: Date.now() - startedAt,
      });
      this.repo.setLastErrorCode(failure.errorCode);
      return { ok: false, failure };
    }
  }

  /** The app's `send`: one outbox row and a push. No window, no budget, no count (§6.18). */
  private async sendToApp(
    message: OutboundMessage,
    track: { kind: string; principal?: string; reminderId?: string; inReplyTo?: string },
  ): Promise<SendOutcome> {
    const kind = outboxKindOf(track.kind);
    const accepted = this.sql.transaction(() =>
      this.outbox.accept({
        kind,
        text: message.text,
        ...(message.buttons ? { buttons: message.buttons } : {}),
        ...(track.principal ? { principal: track.principal } : {}),
        ...(track.reminderId ? { reminderId: track.reminderId } : {}),
        ...(track.inReplyTo ? { inReplyTo: track.inReplyTo } : {}),
      }),
    );
    this.log.info('app_message_queued', { seq: accepted.seq, kind });
    await this.pushOutbox();
    return { ok: true, wamid: accepted.wamid };
  }

  /**
   * The budget warning rides on the message that crosses the threshold rather
   * than arriving as its own. One command still produces one reply (invariant
   * 10), and a warning nobody asked for is not worth a second notification.
   */
  private withBudgetWarning(message: OutboundMessage): OutboundMessage {
    const state = budgetState(this.repo.counters(Repository.monthKey(Date.now())).waSent);
    if (!state.shouldWarn) return message;
    return { ...message, text: `${message.text}\n\n${statusText.budgetWarning(state)}` };
  }

  // -- wiring ----------------------------------------------------------------

  private services(): Services {
    return {
      reminders: this.reminders,
      pending: this.pending,
      questions: this.questions,
      ical: this.ical,
      birthdays: this.birthdays,
      fetchImpl: this.fetchImpl,
      deferred: this.deferred,
      nlu: buildNluChain({ groqApiKey: this.env.GROQ_API_KEY, fetchImpl: this.fetchImpl }),
      google: this.google,
      publicBaseUrl: this.env.PUBLIC_BASE_URL,
      ...(this.calendarClient() ? { calendar: this.calendarClient()! } : {}),
      ...(this.callDispatcher() ? { calls: this.callDispatcher()! } : {}),
      ...(this.env.DEVICE_TOKEN_PEPPER ? { devices: this.devices } : {}),
      ...(this.channel() === 'app' ? { outbox: this.outbox } : {}),
    };
  }

  /** Built once a grant exists, and reused so its access token is not re-fetched. */
  private calendarClient(): CalendarClient | null {
    if (!this.google.isConnected()) return null;
    this.calendar ??= new CalendarClient({
      store: this.google,
      clientId: this.env.GOOGLE_CLIENT_ID,
      clientSecret: this.env.GOOGLE_CLIENT_SECRET,
      log: this.log,
      now: () => Date.now(),
      fetchImpl: this.fetchImpl,
    });
    return this.calendar;
  }

  /**
   * Built per request rather than held on the instance: it closes over secrets,
   * and a long-lived Durable Object should not keep them alive between calls.
   */
  private voiceTranscriber() {
    return createVoiceTranscriber({
      accessToken: this.env.WA_ACCESS_TOKEN,
      provider: createGroqWhisperProvider({
        apiKey: this.env.GROQ_API_KEY,
        model: WHISPER_MODEL,
        fetchImpl: this.fetchImpl,
      }),
      log: this.log,
      fetchImpl: this.fetchImpl,
    });
  }

  /** Set the alarm to the next reminder, or clear it when there is nothing. */
  private async armAlarm(notBefore?: number): Promise<void> {
    // The earliest of the next reminder, the next call dispatch to expire, and
    // the outbox's next push or expiry. With the app off, pushes are not waited
    // for — only the expiry that clears message text (§6.18).
    const outboxAt = this.channel() === 'app' ? this.outbox.nextWakeAt() : this.outbox.nextExpiryAt();
    const candidates = [this.reminders.nextDueAt(), this.devices.nextExpiryAt(), outboxAt].filter(
      (at): at is number => at !== null,
    );
    const next = candidates.length === 0 ? null : Math.min(...candidates);

    if (next === null) {
      if (notBefore === undefined) {
        await this.ctx.storage.deleteAlarm();
        return;
      }
      await this.ctx.storage.setAlarm(notBefore);
      return;
    }

    const at = Math.max(notBefore ?? 0, next, Date.now() + MIN_ALARM_DELAY_MS);
    await this.ctx.storage.setAlarm(at);
  }

  // -- identity --------------------------------------------------------------
  //
  // This is a single-user assistant: reminders go back to the one allowlisted
  // number, which is configuration, never anything that arrived over chat.

  private selfPrincipal(): Promise<string> {
    return hashPrincipal(this.selfWaId(), this.env.LOG_HASH_KEY);
  }

  private selfWaId(): string {
    return (this.env.ALLOWLIST_WA_IDS ?? '').split(',')[0]?.trim() ?? '';
  }
}

function outboxKindOf(kind: string): OutboxKind {
  return kind === 'reminder' || kind === 'digest' || kind === 'call' ? kind : 'notice';
}

function appError(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
