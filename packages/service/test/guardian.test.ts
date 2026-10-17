import { describe, it, expect } from 'vitest';
import { ExtensionGuardian } from '../src/guardian.js';

/** A guardian wired to fake process listing/killing for deterministic tests. */
function makeGuardian(opts: { running: Set<string>; enabled?: boolean; graceMs?: number }) {
  const killed: string[] = [];
  const guardian = new ExtensionGuardian({
    isEnabled: () => opts.enabled ?? true,
    graceMs: opts.graceMs ?? 1000,
    heartbeatTimeoutMs: 500,
    listRunning: async () => opts.running,
    killExe: async (exe) => {
      killed.push(exe);
    },
  });
  return { guardian, killed };
}

describe('ExtensionGuardian', () => {
  it('leaves a browser alone while it heartbeats', async () => {
    const { guardian, killed } = makeGuardian({ running: new Set(['chrome.exe']) });
    guardian.heartbeat('chrome');
    await guardian.tick();
    expect(killed).toEqual([]);
    expect(guardian.status()[0]).toMatchObject({ exe: 'chrome.exe', protected: true });
  });

  it('closes a browser running without the extension after the grace period', async () => {
    const { guardian, killed } = makeGuardian({ running: new Set(['chrome.exe']), graceMs: 0 });
    // No heartbeat -> unprotected. Grace 0 means it closes on the first pass
    // once elapsed >= grace (second tick, since the first only starts the clock).
    await guardian.tick(); // starts the unprotected clock
    await guardian.tick(); // grace elapsed -> close
    expect(killed).toContain('chrome.exe');
  });

  it('does not close anything when enforcement is disabled', async () => {
    const { guardian, killed } = makeGuardian({
      running: new Set(['chrome.exe']),
      enabled: false,
      graceMs: 0,
    });
    await guardian.tick();
    await guardian.tick();
    expect(killed).toEqual([]);
    // Still reported as unprotected so the UI can warn.
    expect(guardian.status()[0]).toMatchObject({ exe: 'chrome.exe', protected: false });
  });

  it('a chromium heartbeat protects both chrome and brave (UA ambiguity)', async () => {
    const { guardian, killed } = makeGuardian({
      running: new Set(['chrome.exe', 'brave.exe']),
      graceMs: 0,
    });
    guardian.heartbeat('chrome');
    await guardian.tick();
    await guardian.tick();
    expect(killed).toEqual([]);
  });

  it('does not touch browsers that are not running', async () => {
    const { guardian, killed } = makeGuardian({ running: new Set(), graceMs: 0 });
    await guardian.tick();
    await guardian.tick();
    expect(killed).toEqual([]);
    expect(guardian.status()).toEqual([]);
  });

  it('reports a countdown while unprotected', async () => {
    const { guardian } = makeGuardian({ running: new Set(['msedge.exe']), graceMs: 60_000 });
    await guardian.tick();
    const status = guardian.status().find((s) => s.exe === 'msedge.exe');
    expect(status?.protected).toBe(false);
    expect(status?.secondsUntilClose).toBeGreaterThan(0);
  });

  it('always closes an unsupported browser (Firefox) — it can never be protected', async () => {
    const { guardian, killed } = makeGuardian({ running: new Set(['firefox.exe']), graceMs: 0 });
    await guardian.tick(); // start clock
    await guardian.tick(); // grace elapsed -> close
    expect(killed).toContain('firefox.exe');
  });

  it('a chromium heartbeat does NOT protect Firefox (no bypass)', async () => {
    const { guardian, killed } = makeGuardian({ running: new Set(['firefox.exe']), graceMs: 0 });
    guardian.heartbeat('chrome'); // protects chrome/brave only
    await guardian.tick();
    await guardian.tick();
    expect(killed).toContain('firefox.exe');
  });

  it('watches other non-extension browsers too (LibreWolf, Vivaldi, Arc)', async () => {
    const { guardian, killed } = makeGuardian({
      running: new Set(['librewolf.exe', 'vivaldi.exe', 'arc.exe']),
      graceMs: 0,
    });
    await guardian.tick();
    await guardian.tick();
    expect(killed).toEqual(expect.arrayContaining(['librewolf.exe', 'vivaldi.exe', 'arc.exe']));
  });
});
