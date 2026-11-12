import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProtectionService } from '../src/service.js';
import { Store } from '../src/store.js';
import { DEFAULT_MEDITATION_REQUIRED_MS } from '@focuslock/core';

let dir: string;
let store: Store;
let service: ProtectionService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'focuslock-'));
  store = new Store(dir, join(dir, 'config.key'));
  service = new ProtectionService(store, Date.UTC(2024, 0, 1, 12, 0, 0));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ProtectionService end-to-end', () => {
  it('allows unmanaged requests and blocks managed ones', () => {
    expect(service.check({ kind: 'web', value: 'https://example.com' }).allowed).toBe(true);
    service.addTarget({ kind: 'domain', value: 'tiktok.com', label: 'TikTok' }, { type: 'permanent-block' });
    expect(service.check({ kind: 'web', value: 'https://tiktok.com' }).allowed).toBe(false);
  });

  it('runs the full daily-break flow through the service', () => {
    const now = Date.UTC(2024, 0, 1, 12, 0, 0);
    const yt = service.addTarget(
      { kind: 'domain', value: 'youtube.com', label: 'YouTube' },
      { type: 'daily-break' },
    );
    // Blocked, but a break is offered.
    const before = service.check({ kind: 'web', value: 'https://youtube.com' }, now);
    expect(before.allowed).toBe(false);
    expect(before.breakAvailable).toBe(true);

    // The break is gated behind the guided meditation: no meditation, no break.
    expect(service.startBreak(yt.target.id, now)).toEqual({ ok: false, reason: 'meditation-required' });

    // Meditate, then spend the break once it has run long enough.
    service.startMeditation(yt.target.id, now);
    const after = now + DEFAULT_MEDITATION_REQUIRED_MS;
    const started = service.startBreak(yt.target.id, after);
    expect(started.ok).toBe(true);
    expect(service.getStatus().breaksRemaining).toBe(1);

    // Now allowed.
    expect(service.check({ kind: 'web', value: 'https://youtube.com' }, after).allowed).toBe(true);
  });

  it('expands a category into many targets', () => {
    const added = service.addCategory('social-media', { type: 'permanent-block' });
    expect(added.length).toBeGreaterThan(3);
    expect(service.check({ kind: 'web', value: 'https://instagram.com' }).allowed).toBe(false);
  });

  it('refuses to end a locked focus session early', () => {
    service.startSession({
      name: 'Deep Work',
      startedAt: Date.now(),
      endsAt: Date.now() + 3_600_000,
      locked: true,
      targetIds: [],
    });
    const result = service.endSession();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('session-locked');
  });

  it('persists state across restarts', () => {
    service.addTarget({ kind: 'domain', value: 'reddit.com', label: 'Reddit' }, { type: 'permanent-block' });
    // Re-open the service against the same store (simulates a restart).
    const revived = new ProtectionService(store, Date.UTC(2024, 0, 1, 13, 0, 0));
    expect(revived.check({ kind: 'web', value: 'https://reddit.com' }).allowed).toBe(false);
  });

  it('records blocked attempts in statistics', () => {
    service.addTarget({ kind: 'domain', value: 'tiktok.com', label: 'TikTok' }, { type: 'permanent-block' });
    const now = Date.UTC(2024, 0, 1, 12, 0, 0);
    service.check({ kind: 'web', value: 'https://tiktok.com' }, now);
    service.check({ kind: 'web', value: 'https://tiktok.com' }, now + 1000);
    const stats = service.getStats(now + 2000);
    expect(stats.blockedAttempts).toBe(2);
    expect(stats.mostOpened[0]).toBe('TikTok');
  });

  it('fails closed when the persisted config is tampered with', () => {
    service.addTarget({ kind: 'domain', value: 'youtube.com', label: 'YouTube' }, { type: 'daily-break' });
    store.close();

    // Tamper: rewrite the config file's JSON directly, leaving the old signature.
    // Both the main file and its signed backup are edited, so there is no
    // known-good copy to fall back to.
    for (const name of ['config.json', 'config.backup.json']) {
      const configPath = join(dir, name);
      const payload = JSON.parse(readFileSync(configPath, 'utf8'));
      const mutated = JSON.parse(payload.json);
      mutated.managedTargets = []; // attacker removes all rules
      payload.json = JSON.stringify(mutated);
      writeFileSync(configPath, JSON.stringify(payload), 'utf8');
    }

    // Re-open: integrity check fails -> fully fail closed.
    const reopened = new Store(dir, join(dir, 'config.key'));
    const tampered = new ProtectionService(reopened, Date.UTC(2024, 0, 1, 13, 0, 0));
    expect(tampered.getStatus().integrityOk).toBe(false);

    // Even a normally-unmanaged site is blocked while integrity is compromised:
    // the attacker cannot get a fail-open by deleting rules.
    const d = tampered.check({ kind: 'web', value: 'https://example.com' });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('blocked-fail-closed');

    // Unrelated mutations must NOT re-sign the stripped config as trusted.
    expect(tampered.startMeditation('anything').ok).toBe(false);
    expect(tampered.setActiveMode(null).ok).toBe(false);
    expect(tampered.updateSettings({ resetTime: '06:00' }).ok).toBe(false);
    expect(tampered.getStatus().integrityOk).toBe(false);

    // Recovery: adding protection through the app re-establishes trust.
    tampered.addTarget({ kind: 'domain', value: 'x.com', label: 'X' }, { type: 'permanent-block' });
    expect(tampered.getStatus().integrityOk).toBe(true);
    expect(tampered.check({ kind: 'web', value: 'https://example.com' }).allowed).toBe(true);
    reopened.close();
  });

  it('restores the signed backup when config.json is tampered with or deleted', () => {
    service.addTarget({ kind: 'domain', value: 'youtube.com', label: 'YouTube' }, { type: 'permanent-block' });
    store.close();

    const configPath = join(dir, 'config.json');
    const payload = JSON.parse(readFileSync(configPath, 'utf8'));
    const mutated = JSON.parse(payload.json);
    mutated.managedTargets = [];
    payload.json = JSON.stringify(mutated);
    writeFileSync(configPath, JSON.stringify(payload), 'utf8');

    const s1 = new Store(dir, join(dir, 'config.key'));
    const restored = new ProtectionService(s1, Date.UTC(2024, 0, 1, 13, 0, 0));
    expect(restored.getStatus().integrityOk).toBe(true);
    expect(restored.getStatus().protectedTargets).toBe(1);
    expect(restored.check({ kind: 'web', value: 'https://youtube.com' }).allowed).toBe(false);

    // Deleting the main file doesn't wipe the block list either.
    rmSync(configPath);
    const s2 = new Store(dir, join(dir, 'config.key'));
    expect(new ProtectionService(s2, Date.UTC(2024, 0, 1, 13, 0, 0)).getStatus().protectedTargets).toBe(1);
  });

  it('fails closed (instead of crashing) when the config is unreadable', () => {
    store.close();
    writeFileSync(join(dir, 'config.json'), '{not json', 'utf8');
    writeFileSync(join(dir, 'config.backup.json'), '', 'utf8');
    const s1 = new Store(dir, join(dir, 'config.key'));
    const svc = new ProtectionService(s1, Date.UTC(2024, 0, 1, 13, 0, 0));
    expect(svc.getStatus().integrityOk).toBe(false);
    expect(svc.check({ kind: 'web', value: 'https://example.com' }).allowed).toBe(false);
  });

  describe('bypass resistance', () => {
    const now = Date.UTC(2024, 0, 1, 12, 0, 0);

    it('refuses to activate a mode that turns blocks off', () => {
      service.addTarget({ kind: 'domain', value: 'tiktok.com', label: 'TikTok' }, { type: 'permanent-block' });
      expect(service.setActiveMode('mode-weekend')).toEqual({ ok: false, reason: 'mode-loosens' });
      expect(service.check({ kind: 'web', value: 'https://tiktok.com' }).allowed).toBe(false);
      // Strict modes still work.
      expect(service.setActiveMode('mode-work').ok).toBe(true);
      expect(service.setActiveMode(null).ok).toBe(true);
    });

    it('does not refill break tokens when the reset time or timezone changes', () => {
      const yt = service.addTarget({ kind: 'domain', value: 'youtube.com', label: 'YouTube' }, { type: 'daily-break' });
      for (let i = 0; i < 2; i++) {
        const t = now + i * 3_600_000;
        service.startMeditation(yt.target.id, t);
        expect(service.startBreak(yt.target.id, t + DEFAULT_MEDITATION_REQUIRED_MS).ok).toBe(true);
      }
      const later = now + 3 * 3_600_000; // 15:00 UTC, both breaks spent
      expect(service.check({ kind: 'web', value: 'https://youtube.com' }, later).breaksRemaining).toBe(0);
      // Move the reset boundary to just behind "now" — previously this refilled.
      expect(service.updateSettings({ resetTime: '14:59' }, later).ok).toBe(true);
      expect(service.check({ kind: 'web', value: 'https://youtube.com' }, later + 1000).breaksRemaining).toBe(0);
      expect(service.updateSettings({ timezoneOffsetMinutes: 600 }, later).ok).toBe(true);
      expect(service.check({ kind: 'web', value: 'https://youtube.com' }, later + 2000).breaksRemaining).toBe(0);
    });

    it('rejects invalid settings instead of saving them', () => {
      expect(service.updateSettings({ resetTime: 'banana' }).ok).toBe(false);
      expect(service.updateSettings({ timezoneOffsetMinutes: 99999 }).ok).toBe(false);
      expect(service.getState().settings.resetTime).toBe('05:00');
    });

    it('cannot replace a running locked session with an unlocked one', () => {
      const s = service.startSession({ name: 'Deep work', startedAt: now, endsAt: now + 3_600_000, locked: true, targetIds: [] }, now);
      expect(s.ok).toBe(true);
      const swap = service.startSession({ name: 'x', startedAt: now, endsAt: now + 1, locked: false, targetIds: [] }, now + 1000);
      expect(swap).toEqual({ ok: false, reason: 'session-locked' });
      expect(service.endSession(now + 2000)).toEqual({ ok: false, reason: 'session-locked' });
    });

    it('refuses a break for an id that is not on the list', () => {
      service.startMeditation('made-up', now);
      expect(service.startBreak('made-up', now + DEFAULT_MEDITATION_REQUIRED_MS)).toEqual({ ok: false, reason: 'not-found' });
    });
  });

  describe('commitment lock (added targets cannot be removed or unblocked)', () => {
    it('refuses to remove a target, and the target stays enforced', () => {
      const t = service.addTarget(
        { kind: 'app', value: 'Terraria', label: 'Terraria' },
        { type: 'permanent-block' },
      );
      const result = service.removeTarget(t.target.id);
      expect(result).toEqual({ ok: false, reason: 'locked' });
      expect(service.getState().managedTargets).toHaveLength(1);
      expect(service.check({ kind: 'app', value: 'Terraria.exe' }).allowed).toBe(false);
    });

    it('reports not-found when removing an id that was never added', () => {
      expect(service.removeTarget('nope')).toEqual({ ok: false, reason: 'not-found' });
    });

    it('refuses to weaken a blocking rule to always-allowed', () => {
      const t = service.addTarget(
        { kind: 'domain', value: 'youtube.com', label: 'YouTube' },
        { type: 'permanent-block' },
      );
      const result = service.updateTargetRule(t.target.id, { type: 'always-allowed' });
      expect(result).toEqual({ ok: false, reason: 'locked-no-unblock' });
      // Still blocked.
      expect(service.check({ kind: 'web', value: 'https://youtube.com' }).allowed).toBe(false);
    });

    it('allows switching between blocking rules (making it stricter)', () => {
      const t = service.addTarget(
        { kind: 'domain', value: 'youtube.com', label: 'YouTube' },
        { type: 'daily-break' },
      );
      expect(service.updateTargetRule(t.target.id, { type: 'permanent-block' })).toEqual({ ok: true });
      const d = service.check({ kind: 'web', value: 'https://youtube.com' });
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe('permanent-block');
    });

    it('refuses to loosen a block by switching rule types', () => {
      const t = service.addTarget(
        { kind: 'domain', value: 'youtube.com', label: 'YouTube' },
        { type: 'permanent-block' },
      );
      expect(service.updateTargetRule(t.target.id, { type: 'daily-break' })).toEqual({ ok: false, reason: 'locked-no-loosen' });
      expect(
        service.updateTargetRule(t.target.id, { type: 'scheduled', windows: [{ start: '00:00', end: '23:59' }] }),
      ).toEqual({ ok: false, reason: 'locked-no-loosen' });
      expect(service.updateTargetRule(t.target.id, { type: 'permanent-block' })).toEqual({ ok: true });
      expect(service.updateTargetRule(t.target.id, { type: 'bogus' } as never)).toEqual({ ok: false, reason: 'invalid-rule' });
    });

    it('reports not-found when updating an id that was never added', () => {
      expect(service.updateTargetRule('nope', { type: 'permanent-block' })).toEqual({
        ok: false,
        reason: 'not-found',
      });
    });
  });

  describe('uninstall cooldown (7-day commitment)', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const t0 = Date.UTC(2024, 0, 1, 12, 0, 0);

    it('starts with no pending removal', () => {
      const s = service.removalStatus(t0);
      expect(s.requested).toBe(false);
      expect(s.unlocked).toBe(false);
    });

    it('requesting removal does not unlock until 7 days pass', () => {
      service.requestRemoval(t0);
      expect(service.removalStatus(t0).unlocked).toBe(false);
      expect(service.removalStatus(t0 + 6 * DAY).unlocked).toBe(false);
      expect(service.removalStatus(t0 + 7 * DAY).unlocked).toBe(true);
    });

    it('re-requesting never shortens the wait (idempotent)', () => {
      const first = service.requestRemoval(t0);
      const again = service.requestRemoval(t0 + 3 * DAY);
      expect(again.removalRequestedAt).toBe(first.removalRequestedAt);
      expect(service.removalStatus(t0 + 7 * DAY - 1).unlocked).toBe(false);
      expect(service.removalStatus(t0 + 7 * DAY).unlocked).toBe(true);
    });

    it('cancelling clears the request so removal is blocked again', () => {
      service.requestRemoval(t0);
      service.cancelRemoval();
      expect(service.removalStatus(t0 + 8 * DAY).requested).toBe(false);
      expect(service.removalStatus(t0 + 8 * DAY).unlocked).toBe(false);
    });

    it('survives a service restart (persisted)', () => {
      service.requestRemoval(t0);
      const revived = new ProtectionService(store, t0 + DAY);
      const s = revived.removalStatus(t0 + 7 * DAY);
      expect(s.requested).toBe(true);
      expect(s.unlocked).toBe(true);
    });
  });

  describe('weekly pass', () => {
    it('unlocks a website target for 4 hours (after meditating)', () => {
      const now = Date.UTC(2024, 0, 1, 12, 0, 0);
      const t = service.addTarget({ kind: 'keyword', value: '123movie', label: 'movies' }, { type: 'daily-break' });
      service.startMeditation(t.target.id, now);
      const after = now + DEFAULT_MEDITATION_REQUIRED_MS;
      expect(service.startWeeklyPass(t.target.id, after)).toEqual({ ok: true });
      expect(service.check({ kind: 'web', value: 'https://123movies.com' }, after).reason).toBe(
        'allowed-by-weekly-pass',
      );
    });

    it('refuses to spend the pass on an app (before even reaching the meditation gate)', () => {
      const t = service.addTarget({ kind: 'app', value: 'Terraria', label: 'Terraria' }, { type: 'daily-break' });
      expect(service.startWeeklyPass(t.target.id)).toEqual({ ok: false, reason: 'not-for-apps' });
      expect(service.check({ kind: 'app', value: 'Terraria.exe' }).allowed).toBe(false);
    });
  });

  describe('meditation gate', () => {
    const now = Date.UTC(2024, 0, 1, 12, 0, 0);

    it('refuses a break until the meditation has run long enough', () => {
      const yt = service.addTarget(
        { kind: 'domain', value: 'youtube.com', label: 'YouTube' },
        { type: 'daily-break' },
      );
      service.startMeditation(yt.target.id, now);
      // Too soon — still short of the required duration.
      expect(service.startBreak(yt.target.id, now + DEFAULT_MEDITATION_REQUIRED_MS - 1)).toEqual({
        ok: false,
        reason: 'meditation-required',
      });
      // Long enough — granted.
      expect(service.startBreak(yt.target.id, now + DEFAULT_MEDITATION_REQUIRED_MS).ok).toBe(true);
    });

    it('refuses the weekly pass without a completed meditation', () => {
      const t = service.addTarget({ kind: 'domain', value: 'netflix.com', label: 'Netflix' }, { type: 'daily-break' });
      expect(service.startWeeklyPass(t.target.id, now)).toEqual({ ok: false, reason: 'meditation-required' });
    });

    it('consumes the meditation — a second break needs a fresh one', () => {
      const yt = service.addTarget(
        { kind: 'domain', value: 'youtube.com', label: 'YouTube' },
        { type: 'daily-break' },
      );
      // First break: meditate, wait, spend.
      service.startMeditation(yt.target.id, now);
      const t1 = now + DEFAULT_MEDITATION_REQUIRED_MS;
      expect(service.startBreak(yt.target.id, t1).ok).toBe(true);
      // Let that break expire so a second could start.
      const t2 = t1 + 31 * 60 * 1000;
      // The earlier meditation was consumed — a second break is refused.
      expect(service.startBreak(yt.target.id, t2)).toEqual({ ok: false, reason: 'meditation-required' });
      // Meditate again, then it is granted.
      service.startMeditation(yt.target.id, t2);
      expect(service.startBreak(yt.target.id, t2 + DEFAULT_MEDITATION_REQUIRED_MS).ok).toBe(true);
    });
  });
});
