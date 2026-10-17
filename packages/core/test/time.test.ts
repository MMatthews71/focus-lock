import { describe, it, expect } from 'vitest';
import {
  parseHhMm,
  toLocalClock,
  resetDayKey,
  msUntilNextReset,
  isWindowOpen,
  anyWindowOpen,
  msUntilNextWindowOpen,
} from '../src/time.js';

// A fixed reference: 2024-01-01T00:00:00Z was a Monday.
const MON_MIDNIGHT_UTC = Date.UTC(2024, 0, 1, 0, 0, 0);
const HOUR = 3_600_000;

describe('parseHhMm', () => {
  it('parses valid times', () => {
    expect(parseHhMm('05:00')).toBe(300);
    expect(parseHhMm('23:59')).toBe(1439);
    expect(parseHhMm('0:07')).toBe(7);
  });
  it('rejects invalid times', () => {
    expect(() => parseHhMm('24:00')).toThrow();
    expect(() => parseHhMm('12:60')).toThrow();
    expect(() => parseHhMm('noon')).toThrow();
  });
});

describe('toLocalClock', () => {
  it('reports weekday correctly (2024-01-01 is Monday)', () => {
    expect(toLocalClock(MON_MIDNIGHT_UTC, 0).weekday).toBe(1);
  });
  it('applies timezone offset', () => {
    // UTC-5 => local time is 19:00 on the previous day (Sunday).
    const clock = toLocalClock(MON_MIDNIGHT_UTC, -300);
    expect(clock.minutesOfDay).toBe(19 * 60);
    expect(clock.weekday).toBe(0); // Sunday
  });
});

describe('resetDayKey', () => {
  it('rolls over exactly at the reset boundary (05:00)', () => {
    const before = MON_MIDNIGHT_UTC + 4 * HOUR + 59 * 60_000; // 04:59
    const after = MON_MIDNIGHT_UTC + 5 * HOUR; // 05:00
    expect(resetDayKey(before, 0, '05:00')).not.toBe(resetDayKey(after, 0, '05:00'));
  });
  it('is stable within the same reset day', () => {
    const morning = MON_MIDNIGHT_UTC + 6 * HOUR;
    const evening = MON_MIDNIGHT_UTC + 22 * HOUR;
    expect(resetDayKey(morning, 0, '05:00')).toBe(resetDayKey(evening, 0, '05:00'));
  });
});

describe('msUntilNextReset', () => {
  it('counts down to the next 05:00', () => {
    const at2am = MON_MIDNIGHT_UTC + 2 * HOUR;
    expect(msUntilNextReset(at2am, 0, '05:00')).toBe(3 * HOUR);
  });
  it('wraps to tomorrow when past reset', () => {
    const at6am = MON_MIDNIGHT_UTC + 6 * HOUR;
    expect(msUntilNextReset(at6am, 0, '05:00')).toBe(23 * HOUR);
  });
});

describe('isWindowOpen / schedules', () => {
  const clockAt = (h: number, m = 0) =>
    toLocalClock(MON_MIDNIGHT_UTC + h * HOUR + m * 60_000, 0);

  it('opens inside a normal window', () => {
    const w = { start: '19:00', end: '21:00' };
    expect(isWindowOpen(w, clockAt(20))).toBe(true);
    expect(isWindowOpen(w, clockAt(18, 59))).toBe(false);
    expect(isWindowOpen(w, clockAt(21))).toBe(false); // end is exclusive
  });

  it('handles windows that wrap past midnight', () => {
    const w = { start: '22:00', end: '02:00' };
    expect(isWindowOpen(w, clockAt(23))).toBe(true);
    expect(isWindowOpen(w, clockAt(1))).toBe(true);
    expect(isWindowOpen(w, clockAt(3))).toBe(false);
  });

  it('respects weekday restrictions', () => {
    const w = { start: '00:00', end: '23:59', days: [1] }; // Monday only
    expect(isWindowOpen(w, clockAt(12))).toBe(true); // reference day is Monday
    const tuesday = toLocalClock(MON_MIDNIGHT_UTC + 24 * HOUR + 12 * HOUR, 0);
    expect(isWindowOpen(w, tuesday)).toBe(false);
  });

  it('anyWindowOpen unions windows', () => {
    const ws = [
      { start: '07:00', end: '09:00' },
      { start: '19:00', end: '21:00' },
    ];
    expect(anyWindowOpen(ws, clockAt(8))).toBe(true);
    expect(anyWindowOpen(ws, clockAt(20))).toBe(true);
    expect(anyWindowOpen(ws, clockAt(12))).toBe(false);
  });
});

describe('msUntilNextWindowOpen', () => {
  it('returns 0 when a window is open now', () => {
    const w = [{ start: '00:00', end: '23:59' }];
    expect(msUntilNextWindowOpen(w, MON_MIDNIGHT_UTC + 12 * HOUR, 0)).toBe(0);
  });
  it('finds the next opening later today', () => {
    const w = [{ start: '19:00', end: '21:00' }];
    const at5pm = MON_MIDNIGHT_UTC + 17 * HOUR;
    expect(msUntilNextWindowOpen(w, at5pm, 0)).toBe(2 * HOUR);
  });
  it('returns undefined for empty windows', () => {
    expect(msUntilNextWindowOpen([], MON_MIDNIGHT_UTC, 0)).toBeUndefined();
  });
});
