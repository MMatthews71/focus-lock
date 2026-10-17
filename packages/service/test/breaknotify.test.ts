import { describe, it, expect } from 'vitest';
import { BreakNotifier, describeRemaining, type ActiveBreakLike } from '../src/breaknotify.js';

/** A notifier wired to a mutable clock and break, recording every notification. */
function harness(what?: string) {
  const notes: Array<{ title: string; body: string }> = [];
  let active: ActiveBreakLike | null = null;
  let now = 0;
  const notifier = new BreakNotifier({
    getActiveBreak: () => active,
    notify: (title, body) => notes.push({ title, body }),
    now: () => now,
    ...(what ? { what } : {}),
  });
  return {
    notifier,
    notes,
    setNow: (t: number) => (now = t),
    setBreak: (b: ActiveBreakLike | null) => (active = b),
  };
}

const MIN = 60_000;

describe('BreakNotifier', () => {
  it('does not notify when plenty of time remains', () => {
    const h = harness();
    h.setBreak({ startedAt: 0, endsAt: 30 * MIN }); // 30 min break
    h.setNow(MIN); // 29 min left
    h.notifier.tick();
    expect(h.notes).toHaveLength(0);
  });

  it('warns at 5 minutes and again at 30 seconds — once each', () => {
    const h = harness();
    h.setBreak({ startedAt: 0, endsAt: 30 * MIN });
    // Poll every second through the whole break.
    for (let t = 0; t < 30 * MIN; t += 1_000) {
      h.setNow(t);
      h.notifier.tick();
    }
    expect(h.notes.map((n) => n.body)).toEqual([
      'Your break ends in 5 minutes.',
      'Your break ends in 30 seconds.',
    ]);
  });

  it('shows only the most urgent warning when several are passed at once', () => {
    const h = harness();
    h.setBreak({ startedAt: 0, endsAt: 30 * MIN });
    h.setNow(30 * MIN - 20_000); // e.g. the service just started with 20s left
    h.notifier.tick();
    h.setNow(30 * MIN - 10_000);
    h.notifier.tick();
    expect(h.notes.map((n) => n.body)).toEqual(['Your break ends in 20 seconds.']);
  });

  it('does not notify after the break has already ended', () => {
    const h = harness();
    h.setBreak({ startedAt: 0, endsAt: 30 * MIN });
    h.setNow(30 * MIN + 1); // expired
    h.notifier.tick();
    expect(h.notes).toHaveLength(0);
  });

  it('warns again for a brand-new break', () => {
    const h = harness();
    h.setBreak({ startedAt: 0, endsAt: 30 * MIN });
    h.setNow(30 * MIN - 25_000);
    h.notifier.tick(); // warns for break #1

    h.setBreak(null); // break ends
    h.notifier.tick();

    h.setBreak({ startedAt: 40 * MIN, endsAt: 70 * MIN }); // new break, new startedAt
    h.setNow(70 * MIN - 25_000);
    h.notifier.tick(); // warns for break #2
    expect(h.notes).toHaveLength(2);
  });

  it('names what is ending (e.g. the movie pass)', () => {
    const h = harness('movie pass');
    h.setBreak({ startedAt: 0, endsAt: 240 * MIN });
    h.setNow(240 * MIN - 5 * MIN + 500);
    h.notifier.tick();
    expect(h.notes[0]?.body).toBe('Your movie pass ends in 5 minutes.');
  });
});

describe('describeRemaining', () => {
  it('reads naturally', () => {
    expect(describeRemaining(5 * MIN - 400)).toBe('5 minutes');
    expect(describeRemaining(MIN)).toBe('1 minute');
    expect(describeRemaining(29_400)).toBe('30 seconds');
    expect(describeRemaining(2_000)).toBe('5 seconds');
  });
});
