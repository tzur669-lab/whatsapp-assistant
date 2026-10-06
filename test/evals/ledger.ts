/**
 * The evals' shared daily ledger (PLAN §9, 2026-10-06).
 *
 * The evals spend from the same Groq organization as the live bot, so every
 * eval script charges one ledger per UTC day and stops itself early enough to
 * leave the bot headroom. These are project safety guards, not exact fractions
 * of each Groq limit: any limit may answer 429 first, and that is handled.
 *
 * - One run at a time: an exclusive lock file. A second script refuses to start.
 * - Count before sending: a request is charged its reservation before it goes,
 *   and corrected to its usage after. A crash, a timeout or a 429 still counts.
 * - Atomic: written to a temp file and renamed, after every request.
 *
 * Counts only — model ids and integers. Never a prompt or a reply.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Tokens on any one model per UTC day: half the free tier's about 200K. */
export const LEDGER_MODEL_TOKENS = 100_000;
/** Requests across all models per UTC day: under a third of one model's 1,000 RPD. */
export const LEDGER_TOTAL_REQUESTS = 300;

type Day = { date: string; tokens: Record<string, number>; requests: number };

export type Charge = { readonly model: string; readonly tokens: number };

export class EvalLedger {
  private day: Day;
  private closed = false;

  private constructor(
    private readonly dir: string,
    private readonly lockPath: string,
    private readonly now: () => number,
  ) {
    this.day = this.load();
  }

  /** Takes the lock, or throws with who holds it. */
  static open(dir: string, now: () => number = Date.now): EvalLedger {
    mkdirSync(dir, { recursive: true });
    const lockPath = join(dir, 'eval.lock');
    let fd: number;
    try {
      fd = openSync(lockPath, 'wx');
    } catch {
      const holder = existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : '?';
      throw new Error(`Another eval holds ${lockPath} (${holder.trim()}). If that process is gone, delete the file by hand.`);
    }
    writeFileSync(fd, `pid ${process.pid}, started ${new Date(now()).toISOString()}\n`);
    closeSync(fd);
    const ledger = new EvalLedger(dir, lockPath, now);
    process.once('exit', () => ledger.close());
    // Ctrl+C or a kill: free the lock, then exit as the signal would have.
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        ledger.close();
        process.exit(128 + (signal === 'SIGINT' ? 2 : 15));
      });
    }
    return ledger;
  }

  /** Why the run must stop now, or null while there is room. */
  stopReason(model: string): string | null {
    this.rollover();
    if ((this.day.tokens[model] ?? 0) >= LEDGER_MODEL_TOKENS) {
      return `${model} has spent ${this.day.tokens[model]} eval tokens today (guard ${LEDGER_MODEL_TOKENS})`;
    }
    if (this.day.requests >= LEDGER_TOTAL_REQUESTS) {
      return `${this.day.requests} eval requests today across all models (guard ${LEDGER_TOTAL_REQUESTS})`;
    }
    return null;
  }

  /** Charge a request before it is sent, at its reservation size. */
  begin(model: string, reserved: number): Charge {
    this.rollover();
    this.day.tokens[model] = (this.day.tokens[model] ?? 0) + reserved;
    this.day.requests += 1;
    this.save();
    return { model, tokens: reserved };
  }

  /** Replace a charge with what the request measured; zero (no usage) keeps the reservation. */
  settle(charge: Charge, measured: number): void {
    if (measured <= 0) return;
    this.day.tokens[charge.model] = Math.max(0, (this.day.tokens[charge.model] ?? 0) - charge.tokens + measured);
    this.save();
  }

  spentToday(): Day {
    this.rollover();
    return { ...this.day, tokens: { ...this.day.tokens } };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    rmSync(this.lockPath, { force: true });
  }

  private date(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  private path(date = this.date()): string {
    return join(this.dir, `ledger-${date}.json`);
  }

  private load(): Day {
    const path = this.path();
    if (!existsSync(path)) return { date: this.date(), tokens: {}, requests: 0 };
    return JSON.parse(readFileSync(path, 'utf8')) as Day;
  }

  private rollover(): void {
    if (this.day.date !== this.date()) this.day = this.load();
  }

  private save(): void {
    const path = this.path(this.day.date);
    const temp = `${path}.tmp`;
    writeFileSync(temp, JSON.stringify(this.day));
    renameSync(temp, path);
  }
}
