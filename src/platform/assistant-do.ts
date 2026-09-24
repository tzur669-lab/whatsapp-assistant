/**
 * The single Durable Object. Every state change in the system is serialized
 * through this one instance, which is what rules out double-executed
 * confirmations and racing webhook retries (PLAN §3.3).
 */
import { Repository } from '../core/repo.js';
import { handleInbound } from '../core/pipeline.js';
import { createLogger, hashPrincipal } from '../security/redact.js';
import { WhatsAppSender } from '../channels/whatsapp/send.js';
import { createVoiceTranscriber } from '../channels/whatsapp/voice.js';
import { createGroqWhisperProvider, WHISPER_MODEL } from '../voice/groq-whisper.js';
import type { InboundEvent } from '../channels/types.js';
import type { AppEnv } from '../core/env.js';
import { DurableObjectSqlDriver } from './sql-repo.js';
import { MIGRATIONS } from './migrations.js';

const RETENTION_INBOUND_MS = 30 * 24 * 60 * 60 * 1000;

export class AssistantDO implements DurableObject {
  private readonly repo: Repository;
  private readonly log = createLogger({ component: 'assistant_do' });

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: AppEnv,
  ) {
    this.repo = new Repository(new DurableObjectSqlDriver(ctx.storage));
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

    if (url.pathname === '/do/maintenance' && request.method === 'POST') {
      this.runMaintenance();
      return new Response(null, { status: 204 });
    }

    return new Response('not found', { status: 404 });
  }

  /** Daily cron entry point (PLAN §6.7). */
  runMaintenance(): void {
    const cutoff = Date.now() - RETENTION_INBOUND_MS;
    this.repo.purgeInboundBefore(cutoff);
    this.log.info('maintenance_done', {});
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
      }),
      log: this.log,
    });
  }

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
      ...(this.env.GROQ_API_KEY ? { transcribe: this.voiceTranscriber() } : {}),
    });

    if (outcome.action !== 'reply' || event.kind === 'status') return;

    const sender = new WhatsAppSender({
      phoneNumberId: this.env.WA_PHONE_NUMBER_ID,
      accessToken: this.env.WA_ACCESS_TOKEN,
    });

    try {
      const { wamid } = await sender.send({ to: event.from, text: outcome.text });
      this.log.info('reply_sent', { inReplyTo: event.wamid, wamid });
    } catch (error) {
      this.log.error('reply_failed', {
        inReplyTo: event.wamid,
        errorCode: error instanceof Error ? error.message : 'E_UNKNOWN',
      });
    }
  }
}
