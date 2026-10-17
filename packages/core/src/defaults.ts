/**
 * Sensible defaults and a seed state so a fresh install is useful immediately
 * with "minimal setup" (a core product goal).
 */

import { createBreakState, DEFAULT_BREAK_DURATION_MS, DEFAULT_TOKENS_PER_DAY } from './breaks.js';
import { createWeeklyPassState } from './weeklypass.js';
import type { EngineState, Mode, Settings } from './types.js';

export const DEFAULT_SETTINGS: Settings = {
  resetTime: '05:00',
  timezoneOffsetMinutes: 0,
};

/**
 * A couple of illustrative modes. "Work" is an allow-list mode: only its
 * overrides are permitted, everything else is blocked.
 */
export function defaultModes(): Mode[] {
  return [
    { id: 'mode-work', name: 'Work', defaultPolicy: 'block', overrides: {} },
    { id: 'mode-weekend', name: 'Weekend', defaultPolicy: 'allow', overrides: {} },
    { id: 'mode-sleep', name: 'Sleep', defaultPolicy: 'block', overrides: {} },
  ];
}

/** A minimal, valid, empty-but-ready engine state. */
export function createInitialState(now: number, settings: Settings = DEFAULT_SETTINGS): EngineState {
  return {
    settings,
    managedTargets: [],
    breaks: createBreakState(now, settings, DEFAULT_TOKENS_PER_DAY, DEFAULT_BREAK_DURATION_MS),
    modes: defaultModes(),
    activeModeId: null,
    activeSession: null,
    weeklyPass: createWeeklyPassState(),
    removalRequestedAt: null,
  };
}

/** Commitment-device uninstall cooldown: 7 full days from the request. */
export const REMOVAL_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
