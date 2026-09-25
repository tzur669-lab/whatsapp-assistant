/**
 * Measure a turn (PLAN §4, backlog B4).
 *
 * Workers Free allows **10 ms of CPU per request**. Exceeding it does not cost
 * money — it fails the request. PLAN has said "measure it" since the first
 * draft and it had never been measured once, which meant every claim about the
 * synchronous SHA-256, the Zod validation and the bidi rendering being
 * affordable was a guess.
 *
 * **What this is and is not.** It runs the real modules on this machine under
 * Node. It is not workerd, the V8 isolate is not the same one, and Cloudflare
 * counts CPU differently from wall time. So the numbers here are an *order of
 * magnitude and a ranking*, not the budget figure — that can only come from
 * staging, where `wrangler tail` reports the real cpuMs. What this does give,
 * and what a guess never could, is: which stage dominates, and whether anything
 * is within an order of magnitude of 10 ms at all.
 *
 *   pnpm bench
 */
import { readdirSync, readFileSync } from 'node:fs';
import { Repository } from '../src/core/repo.js';
import { handleInbound } from '../src/core/pipeline.js';
import type { PipelineDeps, Services } from '../src/core/pipeline.js';
import { ReminderStore } from '../src/tools/reminder-store.js';
import { PendingActions, sha256Hex, buttonId } from '../src/confirm/pending.js';
import { OpenQuestions } from '../src/confirm/questions.js';
import { UndoActions } from '../src/confirm/undo.js';
import { TestSqlDriver } from '../test/integration/sqlite-driver.js';
import { createFakeLogger } from '../test/integration/fake-logger.js';
import { createFakeNlu, draft, TOMORROW_AT_EIGHT } from '../test/integration/fake-nlu.js';
import { validateIntentDraft } from '../src/nlu/intent-schema.js';
import { resolveWhen } from '../src/time/resolve.js';
import { verifyWebhookSignature } from '../src/channels/whatsapp/verify.js';
import { parseWebhookPayload } from '../src/channels/whatsapp/parse.js';
import { reminderText } from '../src/render/reminders.js';
import { localPartsOf, ZONE } from '../src/time/tz.js';
import type { InboundEvent } from '../src/channels/types.js';

const MIGRATIONS = readdirSync(new URL('../migrations/', import.meta.url))
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file, i) => ({
    id: i + 1,
    sql: readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'),
  }));

const NOW = Date.parse('2026-09-24T09:00:00Z');
const PRINCIPAL = 'p_bench0000000';
const BUDGET_MS = 10;

type Sample = { name: string; iterations: number; msEach: number };

/**
 * Median of enough runs to be stable, after a warm-up.
 *
 * Median rather than mean: one GC pause in a thousand runs should not be
 * reported as the cost of the operation, and the budget question is about the
 * typical request.
 */
async function measure(name: string, iterations: number, body: () => unknown): Promise<Sample> {
  for (let i = 0; i < Math.min(iterations, 50); i++) await body();

  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const started = performance.now();
    await body();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return { name, iterations, msEach: samples[Math.floor(samples.length / 2)] ?? 0 };
}

async function main(): Promise<void> {
  const results: Sample[] = [];

  // -- the pieces PLAN worried about ------------------------------------------

  const body = JSON.stringify(webhookBody());
  const secret = 'bench-secret-not-a-real-one';
  const signature = await signatureFor(body, secret);

  results.push(
    await measure('HMAC verify (webhook ingress)', 2_000, () =>
      verifyWebhookSignature(body, signature, secret),
    ),
  );

  results.push(await measure('parse webhook', 5_000, () => parseWebhookPayload(JSON.parse(body))));

  // The hand-written synchronous SHA-256. Synchronous on purpose (the
  // confirmation checks have to be atomic inside the DO), which is exactly why
  // its cost is worth knowing.
  const small = new TextEncoder().encode('pa:abc:def:ok');
  const realistic = new TextEncoder().encode(JSON.stringify({ text: 'x'.repeat(200), dueAtUtc: NOW }));
  const large = new TextEncoder().encode('x'.repeat(8 * 1024));

  results.push(await measure('sha256 (button id, ~13 B)', 20_000, () => sha256Hex(small)));
  results.push(await measure('sha256 (stored input, ~250 B)', 20_000, () => sha256Hex(realistic)));
  results.push(await measure('sha256 (8 KB)', 2_000, () => sha256Hex(large)));

  const rawDraft = draft('reminders.create', { text: 'להתקשר לאבא', ...TOMORROW_AT_EIGHT });
  results.push(await measure('Zod validate IntentDraft', 5_000, () => validateIntentDraft(rawDraft)));

  results.push(
    await measure('resolveWhen', 20_000, () =>
      resolveWhen(
        {
          date: { kind: 'relative_days', offset: 1 },
          time: { hour: 8, minute: 0, meridiem: 'unspecified', part_of_day: 'unspecified' },
        },
        { nowMs: NOW },
      ),
    ),
  );

  results.push(
    await measure('render a reply (bidi + Intl)', 5_000, () =>
      reminderText.created(
        { id: 'r1', text: 'להתקשר לאבא', local: localPartsOf(NOW + 86_400_000, ZONE) },
        'he',
      ),
    ),
  );

  // -- a whole turn ----------------------------------------------------------

  const driver = new TestSqlDriver();
  const repo = new Repository(driver);

  results.push(
    await measure('migrate (cold start, once per DO)', 20, () => {
      const fresh = new TestSqlDriver();
      new Repository(fresh).migrate(MIGRATIONS);
      fresh.close();
    }),
  );

  repo.migrate(MIGRATIONS);
  const services: Services = {
    reminders: new ReminderStore(driver, () => NOW),
    pending: new PendingActions(driver, () => NOW),
    questions: new OpenQuestions(driver, () => NOW),
    deferred: new UndoActions(driver, () => NOW),
    nlu: [createFakeNlu([rawDraft])],
  };
  const deps: PipelineDeps = {
    repo,
    log: createFakeLogger(),
    now: () => NOW,
    principal: PRINCIPAL,
    services,
  };

  let counter = 0;
  const textEvent = (): InboundEvent => ({
    kind: 'text',
    wamid: `wamid.bench${counter++}`,
    from: '972500000000',
    sentAtMs: NOW - 1_000,
    text: 'תזכיר לי מחר ב-8 להתקשר לאבא',
    forwarded: false,
  });

  results.push(
    await measure('full turn: create a reminder (no network)', 500, () =>
      handleInbound(textEvent(), deps),
    ),
  );

  results.push(
    await measure('full turn: /status', 500, () =>
      handleInbound({ ...textEvent(), text: '/status' } as InboundEvent, deps),
    ),
  );

  const pending = services.pending.create({
    tool: 'reminders.cancel',
    input: { query_variants: ['x'] },
    summary: 's',
    tier: 2,
    principal: PRINCIPAL,
  });
  const tap = buttonId('pa', pending.id, pending.nonce, 'no');
  results.push(
    await measure('full turn: a tapped button (all the gates)', 500, () =>
      handleInbound(
        {
          kind: 'button',
          wamid: `wamid.b${counter++}`,
          from: '972500000000',
          sentAtMs: NOW - 1_000,
          buttonId: tap,
          forwarded: false,
        },
        deps,
      ),
    ),
  );

  driver.close();
  report(results);
}

function report(results: Sample[]): void {
  const width = Math.max(...results.map((r) => r.name.length));
  const lines = [
    '',
    `Workers Free budget: ${BUDGET_MS} ms CPU per request.`,
    'Node on this machine, not workerd — a ranking and an order of magnitude.',
    '',
    `${'stage'.padEnd(width)}  ${'ms'.padStart(9)}  ${'% of 10 ms'.padStart(11)}  runs`,
    `${'-'.repeat(width)}  ${'-'.repeat(9)}  ${'-'.repeat(11)}  ----`,
  ];

  for (const { name, msEach, iterations } of results) {
    const share = ((msEach / BUDGET_MS) * 100).toFixed(1);
    lines.push(
      `${name.padEnd(width)}  ${msEach.toFixed(4).padStart(9)}  ${`${share}%`.padStart(11)}  ${iterations}`,
    );
  }

  const worst = [...results]
    .filter((r) => !r.name.startsWith('migrate'))
    .sort((a, b) => b.msEach - a.msEach)[0];
  lines.push('');
  lines.push(
    worst
      ? `Slowest per-request stage: ${worst.name} at ${worst.msEach.toFixed(3)} ms ` +
        `(${((worst.msEach / BUDGET_MS) * 100).toFixed(1)}% of the budget).`
      : 'No samples.',
  );
  lines.push('');
  lines.push('Real numbers come from `wrangler tail` on staging, which reports cpuMs.');
  lines.push('');

  process.stdout.write(lines.join('\n'));
}

// -- fixtures -----------------------------------------------------------------

function webhookBody(): unknown {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '0',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '972500000000', phone_number_id: '0' },
              messages: [
                {
                  from: '972500000000',
                  id: 'wamid.bench',
                  timestamp: String(Math.floor(NOW / 1000)),
                  type: 'text',
                  text: { body: 'תזכיר לי מחר ב-8 להתקשר לאבא' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function signatureFor(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256=${hex}`;
}

await main();
