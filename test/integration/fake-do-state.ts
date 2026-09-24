/**
 * A stand-in for `DurableObjectState`, so the alarm scheduler can be tested
 * without workerd.
 *
 * It backs `storage.sql` with the same Node SQLite driver the repository tests
 * use — the real DO exposes the identical cursor shape — and records alarm
 * scheduling instead of performing it. The alarm is state, not a timer: what
 * matters is *when* it was set to, and that is what this captures.
 */
import { TestSqlDriver } from './sqlite-driver.js';

export type FakeDoState = {
  /** Shaped like DurableObjectState. Cast at the call site; nothing here is Cloudflare's. */
  state: unknown;
  driver: TestSqlDriver;
  /** The current alarm, or null when there is none. */
  alarmAt(): number | null;
  /** Every alarm that was ever set, in order. */
  alarmHistory: (number | null)[];
  close(): void;
};

export function createFakeDoState(): FakeDoState {
  const driver = new TestSqlDriver();
  let alarm: number | null = null;
  const alarmHistory: (number | null)[] = [];

  const storage = {
    sql: {
      exec(query: string, ...bindings: unknown[]) {
        const rows = driver.exec(query, ...bindings);
        return { toArray: () => rows };
      },
    },
    async setAlarm(at: number) {
      alarm = at;
      alarmHistory.push(at);
    },
    async deleteAlarm() {
      alarm = null;
      alarmHistory.push(null);
    },
    async getAlarm() {
      return alarm;
    },
  };

  return {
    state: {
      storage,
      // The real one queues requests until the callback settles; running it
      // inline is the same guarantee for a single-threaded test.
      blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
    },
    driver,
    alarmAt: () => alarm,
    alarmHistory,
    close: () => driver.close(),
  };
}

/** Records what was sent instead of calling Meta. */
export type FakeMeta = {
  fetchImpl: typeof fetch;
  sent: { to: string; text: string; buttons: { id: string; title: string }[] }[];
  /** Make the next `n` sends fail with this status. */
  failNext(times: number, status?: number): void;
};

export function createFakeMeta(): FakeMeta {
  const sent: FakeMeta['sent'] = [];
  let failures = 0;
  let failStatus = 500;
  let counter = 0;

  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      to?: string;
      text?: { body?: string };
      interactive?: { body?: { text?: string }; action?: { buttons?: { reply: { id: string; title: string } }[] } };
    };

    if (failures > 0) {
      failures--;
      return new Response('{}', { status: failStatus });
    }

    sent.push({
      to: body.to ?? '',
      text: body.text?.body ?? body.interactive?.body?.text ?? '',
      buttons: (body.interactive?.action?.buttons ?? []).map((b) => b.reply),
    });
    return new Response(JSON.stringify({ messages: [{ id: `wamid.out.${counter++}` }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    sent,
    failNext(times: number, status = 500) {
      failures = times;
      failStatus = status;
    },
  };
}
