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
import type { InboundEvent, OutboundMessage } from '../channels/types.js';
import type { AppEnv } from '../core/env.js';
import { DurableObjectSqlDriver } from './sql-repo.js';
import { MIGRATIONS } from './migrations.js';

const RETENTION_INBOUND_MS = 30 * 24 * 60 * 60 * 1000;

/** Late enough to be worth mentioning. Below this, nobody would notice. */
const LATE_THRESHOLD_MS = 60_000;

/** A floor on alarm scheduling, so a due-now reminder does not spin. */
const MIN_ALARM_DELAY_MS = 1_000;

/** What `send` knows afterwards: the id, or why it did not go (PLAN §6.8). */
type SendOutcome = { ok: true; wamid: string } | { ok: false; failure: WaFailure };

export class AssistantDO implements DurableObject {
  private readonly repo: Repository;
  private readonly sql: DurableObjectSqlDriver;
  private readonly reminders: ReminderStore;
  private readonly pending: PendingActions;
  private readonly questions: OpenQuestions;
  private readonly deferred: UndoActions;
  private readonly google: GoogleStore;
  private readonly log = createLogger({ component: 'assistant_do' });

  /**
   * Held for the life of the object, so one refreshed access token serves many
   * requests. It is memory only — nothing about it is written down (§6.6).
   */
  private calendar: CalendarClient | null = null;

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
    this.deferred = new UndoActions(this.sql, now);
    this.google = new GoogleStore(this.sql, now, () =>
      parseKeyring(this.env as unknown as Record<string, string | undefined>),
    );

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
    await this.armAlarm();
    this.log.info('maintenance_done', {});
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

    // A new or cancelled reminder moves when the next alarm should fire.
    if (outcome.rescheduleAlarm) {
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

  private async dropBackupEvent(reminder: ClaimedReminder): Promise<void> {
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
    const sent = this.repo.counters(Repository.monthKey(now)).waSent;
    if (budgetState(sent).level === 'exhausted') return false;
    return isWindowOpen(this.repo.lastInboundAt(principal), now);
  }

  // -- outbound --------------------------------------------------------------

  /** The one place a message leaves the system, and the one place it is counted. */
  private async send(
    message: OutboundMessage,
    /** What this message is, and which reminder it carries (PLAN §6.8). */
    track: { kind: string; principal?: string; reminderId?: string } = { kind: 'reply' },
  ): Promise<SendOutcome> {
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
      deferred: this.deferred,
      nlu: buildNluChain({ groqApiKey: this.env.GROQ_API_KEY, fetchImpl: this.fetchImpl }),
      google: this.google,
      publicBaseUrl: this.env.PUBLIC_BASE_URL,
      ...(this.calendarClient() ? { calendar: this.calendarClient()! } : {}),
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
    const next = this.reminders.nextDueAt();

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

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
