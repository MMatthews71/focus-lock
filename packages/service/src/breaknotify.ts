/**
 * Break Notifier — warns the user before an active break ends.
 *
 * Breaks are timed and enforced by the service, not the UI, and the UI window is
 * usually closed while the user is off on their break. So the warnings have to
 * come from here: when the remaining time first drops to each warning threshold
 * (default: 5 minutes, then 30 seconds), we fire a native OS notification that
 * appears wherever the user currently is.
 *
 * Each threshold fires once per break: the break's `startedAt` identifies it, so
 * a break that is ended and a *new* one started later each get their own
 * warnings, but a single break never double-warns across polls. If several
 * thresholds are passed at once (e.g. the service starts with 20s left), only the
 * most urgent warning is shown.
 */

import type { Notifier } from './notify.js';

export interface ActiveBreakLike {
  startedAt: number;
  endsAt: number;
}

export const DEFAULT_WARNINGS_MS = [5 * 60_000, 30_000];

export interface BreakNotifierOptions {
  /** The currently active break, or null. Read fresh each tick. */
  getActiveBreak: () => ActiveBreakLike | null;
  /** Show a notification to the user. */
  notify: Notifier;
  /** Remaining times that each trigger one warning. Default: 5 minutes and 30 seconds. */
  thresholdsMs?: number[];
  /** What is ending, for the message (e.g. "break", "movie pass"). Default "break". */
  what?: string;
  /** Poll interval. Default 1_000ms. */
  pollMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  log?: (message: string) => void;
}

/** "5 minutes", "1 minute", "30 seconds" — rounded to how people say it. */
export function describeRemaining(ms: number): string {
  if (ms >= 60_000) {
    const minutes = Math.max(1, Math.round(ms / 60_000));
    return minutes === 1 ? '1 minute' : `${minutes} minutes`;
  }
  const seconds = Math.max(5, Math.round(ms / 5_000) * 5);
  return `${seconds} seconds`;
}

export class BreakNotifier {
  private timer: NodeJS.Timeout | null = null;
  /** `startedAt` of the break whose warnings we're tracking, or null. */
  private trackedBreak: number | null = null;
  /** Thresholds already warned about for the tracked break. */
  private warned = new Set<number>();

  private readonly thresholdsMs: number[];
  private readonly what: string;
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(private opts: BreakNotifierOptions) {
    this.thresholdsMs = opts.thresholdsMs ?? DEFAULT_WARNINGS_MS;
    this.what = opts.what ?? 'break';
    this.pollMs = opts.pollMs ?? 1_000;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        this.log(`break notifier tick error: ${String(err)}`);
      }
    }, this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One monitoring pass. Exposed for tests. */
  tick(): void {
    const active = this.opts.getActiveBreak();
    const remaining = active ? active.endsAt - this.now() : 0;
    // No break running (ended, expired, or never started) — reset so the next
    // break gets its own warnings.
    if (!active || remaining <= 0) {
      this.trackedBreak = null;
      this.warned.clear();
      return;
    }
    if (this.trackedBreak !== active.startedAt) {
      this.trackedBreak = active.startedAt;
      this.warned.clear();
    }

    const due = this.thresholdsMs.filter((t) => remaining <= t && !this.warned.has(t));
    if (due.length === 0) return;
    for (const t of due) this.warned.add(t);

    const left = describeRemaining(remaining);
    this.log(`${this.what} ending soon — notifying (${left} left)`);
    this.opts.notify('FocusLock', `Your ${this.what} ends in ${left}.`);
  }
}
