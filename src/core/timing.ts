/**
 * Turn timing (PLAN §6.14).
 *
 * Nothing in this system was measured end to end: no latency budget, no idea
 * what a turn costs in wall time, and therefore no way to tell a slow provider
 * from a slow tool from a slow calendar.
 *
 * **Redaction-safe by construction.** A stopwatch holds nothing but a fixed set
 * of stage names and a number of milliseconds each. There is no field a message
 * body could ever reach, which is a stronger guarantee than remembering not to
 * put one there (§6.9).
 *
 * **What it can and cannot see on Workers.** Cloudflare freezes the clock
 * between I/O operations, so `Date.now()` advances across a fetch and not across
 * a loop. That makes these numbers a measure of **waiting**, not of CPU — which
 * is the right half to measure here, because waiting is what dominates a turn
 * and CPU is covered separately by `pnpm bench` and the 10 ms budget test
 * (§4.1). A stage that reads 0 did no I/O; it is not a stage that was free.
 *
 * The **send** is deliberately not a stage here. It happens after the turn has
 * returned its reply, in the platform layer, so timing it from inside would mean
 * the pipeline knowing about a step it does not take. It is logged there instead
 * and correlates by `wamid`.
 */

/**
 * The stages a turn can spend time in. Closed, so a log line's shape is known
 * at compile time and cannot grow a field that carries content.
 */
export type Stage = 'voice' | 'nlu' | 'act';

const STAGES: readonly Stage[] = ['voice', 'nlu', 'act'];

export type Timings = Record<string, number>;

export class Stopwatch {
  private readonly startedAt: number;
  private readonly spent = new Map<Stage, number>();

  constructor(private readonly clock: () => number = Date.now) {
    this.startedAt = clock();
  }

  /** Time an async stage. Re-entering the same stage accumulates. */
  async time<T>(stage: Stage, body: () => Promise<T>): Promise<T> {
    const from = this.clock();
    try {
      return await body();
    } finally {
      this.spent.set(stage, (this.spent.get(stage) ?? 0) + (this.clock() - from));
    }
  }

  /** The same, for a stage that does not await. */
  timeSync<T>(stage: Stage, body: () => T): T {
    const from = this.clock();
    try {
      return body();
    } finally {
      this.spent.set(stage, (this.spent.get(stage) ?? 0) + (this.clock() - from));
    }
  }

  /**
   * Log fields: total, then each stage that took any time.
   *
   * Stages that took none are left out rather than reported as zero. A turn with
   * no voice note did not spend zero milliseconds transcribing — it did not
   * transcribe, and the two read differently at three in the morning.
   */
  fields(): Timings {
    const totalMs = this.clock() - this.startedAt;
    const fields: Timings = { totalMs };

    for (const stage of STAGES) {
      const ms = this.spent.get(stage);
      if (ms !== undefined && ms > 0) fields[`${stage}Ms`] = ms;
    }

    // What is left after the stages: storage, rendering, policy. Named rather
    // than left to be worked out, since it is the part with no owner.
    const accounted = [...this.spent.values()].reduce((sum, ms) => sum + ms, 0);
    const rest = totalMs - accounted;
    if (rest > 0) fields['otherMs'] = rest;

    return fields;
  }
}
