/**
 * Statistics accumulation — deliberately minimal (the spec explicitly wants
 * "no unnecessary graphs"). The engine records events; the UI renders totals.
 */

import type { EpochMs } from './types.js';

export interface BlockedAttemptEvent {
  type: 'blocked-attempt';
  targetId: string | null;
  label: string;
  at: EpochMs;
}

export interface BreakUsedEvent {
  type: 'break-used';
  targetId: string;
  at: EpochMs;
}

export type StatEvent = BlockedAttemptEvent | BreakUsedEvent;

/** A rolled-up view for a single reset-day, ready for the home screen. */
export interface DailyStats {
  blockedAttempts: number;
  breaksUsed: number;
  /**
   * "Time saved" — a simple, honest proxy: each blocked attempt represents a
   * distraction avoided. We estimate a fixed cost per averted distraction.
   */
  timeSavedMs: EpochMs;
  /** Labels sorted by how often they were opened/attempted, most first. */
  mostOpened: string[];
}

/** Estimated minutes reclaimed per blocked attempt (a conservative proxy). */
export const TIME_SAVED_PER_BLOCK_MS = 4 * 60 * 1000;

export function summarize(events: StatEvent[], topN = 3): DailyStats {
  let blockedAttempts = 0;
  let breaksUsed = 0;
  const counts = new Map<string, number>();

  for (const event of events) {
    if (event.type === 'blocked-attempt') {
      blockedAttempts += 1;
      counts.set(event.label, (counts.get(event.label) ?? 0) + 1);
    } else if (event.type === 'break-used') {
      breaksUsed += 1;
    }
  }

  const mostOpened = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([label]) => label);

  return {
    blockedAttempts,
    breaksUsed,
    timeSavedMs: blockedAttempts * TIME_SAVED_PER_BLOCK_MS,
    mostOpened,
  };
}
