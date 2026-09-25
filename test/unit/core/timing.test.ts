/**
 * Turn timing (PLAN §6.14, §11.3).
 *
 * The property that matters is not accuracy — it is that a timing line can
 * never carry content. `Stopwatch` holds a closed set of stage names and a
 * number each, so there is nowhere a message body could reach. These cases pin
 * that, and the arithmetic that makes the numbers worth reading.
 */
import { describe, expect, it } from 'vitest';
import { Stopwatch } from '../../../src/core/timing.js';
import { BANNED_LOG_FIELDS } from '../../../src/security/redact.js';

/** A clock the test drives, so no case depends on how fast the machine is. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let at = 1_000;
  return { now: () => at, advance: (ms) => void (at += ms) };
}

describe('Stopwatch', () => {
  it('reports the total even when no stage ran', async () => {
    const clock = fakeClock();
    const watch = new Stopwatch(clock.now);
    clock.advance(40);

    expect(watch.fields()).toEqual({ totalMs: 40, otherMs: 40 });
  });

  it('attributes time to the stage that spent it', async () => {
    const clock = fakeClock();
    const watch = new Stopwatch(clock.now);

    await watch.time('nlu', async () => clock.advance(300));
    await watch.time('act', async () => clock.advance(120));
    clock.advance(30);

    expect(watch.fields()).toEqual({ totalMs: 450, nluMs: 300, actMs: 120, otherMs: 30 });
  });

  it('names the unaccounted remainder rather than leaving it to be worked out', () => {
    // Storage, rendering and policy have no stage of their own, and that
    // remainder is the part with no owner — so it is the part worth naming.
    const clock = fakeClock();
    const watch = new Stopwatch(clock.now);
    clock.advance(100);

    expect(watch.fields()['otherMs']).toBe(100);
  });

  it('leaves out a stage that did not run, rather than reporting it as zero', async () => {
    const clock = fakeClock();
    const watch = new Stopwatch(clock.now);
    await watch.time('nlu', async () => clock.advance(10));

    const fields = watch.fields();
    // A turn with no voice note did not spend zero milliseconds transcribing —
    // it did not transcribe, and the two read differently at three in the morning.
    expect(fields).not.toHaveProperty('voiceMs');
    expect(fields).toHaveProperty('nluMs');
  });

  it('accumulates a stage entered more than once', async () => {
    const clock = fakeClock();
    const watch = new Stopwatch(clock.now);

    await watch.time('nlu', async () => clock.advance(100));
    await watch.time('nlu', async () => clock.advance(50));

    expect(watch.fields()['nluMs']).toBe(150);
  });

  it('still charges a stage that threw, because a slow failure is still slow', async () => {
    const clock = fakeClock();
    const watch = new Stopwatch(clock.now);

    await expect(
      watch.time('nlu', async () => {
        clock.advance(2_000);
        throw new Error('provider_down');
      }),
    ).rejects.toThrow('provider_down');

    expect(watch.fields()['nluMs']).toBe(2_000);
  });

  it('times a synchronous stage too', () => {
    const clock = fakeClock();
    const watch = new Stopwatch(clock.now);

    const result = watch.timeSync('act', () => {
      clock.advance(5);
      return 'done';
    });

    expect(result).toBe('done');
    expect(watch.fields()['actMs']).toBe(5);
  });

  it('emits numbers and nothing else, whatever happened during the turn', async () => {
    const clock = fakeClock();
    const watch = new Stopwatch(clock.now);
    await watch.time('nlu', async () => clock.advance(10));

    const fields = watch.fields();
    for (const [key, value] of Object.entries(fields)) {
      expect(typeof value, key).toBe('number');
    }
  });

  it('uses no field name the logger would have to redact', () => {
    // Redaction-safe by construction rather than by remembering: if a stage
    // were ever named `text` or `query`, this fails before it ships.
    const clock = fakeClock();
    const watch = new Stopwatch(clock.now);
    const banned = new Set<string>(BANNED_LOG_FIELDS);

    for (const key of Object.keys(watch.fields())) {
      expect(banned.has(key), key).toBe(false);
    }
  });
});
