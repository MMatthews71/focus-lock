/**
 * Full-screen block screen for apps.
 *
 * When a blocked app starts, this opens a full-screen, always-on-top window that
 * looks exactly like the website block page (same markup and stylesheet),
 * offering the daily break. The app stays open behind it while the user
 * decides; the window reports the choice back to the service.
 *
 * The window is a tiny Electron app installed next to the service:
 *   <root>/electron/electron.exe   – the runtime
 *   <root>/overlay/                – main.cjs, preload.cjs, overlay.html/js, block.css
 * Electron is deliberately NOT a browser the extension guardian closes, so the
 * block screen can never be killed as a "browser without the extension".
 *
 * If either piece is missing (e.g. running from a dev checkout), this logs and
 * does nothing — the app is still closed, just without the screen.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Decision } from '@focuslock/core';

export interface OverlayLauncherOptions {
  /** Install root containing `electron/` and `overlay/`. */
  root: string;
  log?: (message: string) => void;
}

export function createOverlayLauncher(opts: OverlayLauncherOptions) {
  const log = opts.log ?? (() => {});
  const electron = join(opts.root, 'electron', 'electron.exe');
  const appDir = join(opts.root, 'overlay');

  return function showAppBlockScreen(processName: string, decision: Decision): void {
    if (process.platform !== 'win32') return;
    if (!existsSync(electron) || !existsSync(join(appDir, 'main.cjs'))) {
      log(`block screen not installed at ${opts.root} — closed ${processName} without it`);
      return;
    }
    // Each value is its own argv entry (no shell), so spaces in paths are safe.
    // The "--fl-" prefix avoids clashing with Chromium's own switches (e.g. --app).
    const args = [
      appDir,
      `--fl-app=${processName.replace(/\.exe$/i, '')}`,
      `--fl-target=${decision.targetId ?? ''}`,
      `--fl-break=${decision.breakAvailable === true}`,
      `--fl-pass=${decision.weeklyPassAvailable === true}`,
      `--fl-breaks=${decision.breaksRemaining}`,
      `--fl-reset=${decision.msUntilReset}`,
    ];
    try {
      const child = spawn(electron, args, { detached: true, stdio: 'ignore', windowsHide: false });
      child.on('error', (err) => log(`block screen failed to start: ${err.message}`));
      child.unref();
      log(`showing block screen for ${processName}`);
    } catch (err) {
      log(`block screen failed to start: ${String(err)}`);
    }
  };
}

/**
 * Corner warning banner (e.g. "Your break ends in 5 minutes."). Unlike a Windows
 * notification, it still shows while a game is running full screen, when
 * Windows' automatic do-not-disturb would hide the notification.
 */
export function createBannerLauncher(opts: OverlayLauncherOptions) {
  const log = opts.log ?? (() => {});
  const electron = join(opts.root, 'electron', 'electron.exe');
  const appDir = join(opts.root, 'overlay');

  return function showBanner(text: string): void {
    if (process.platform !== 'win32') return;
    if (!existsSync(electron) || !existsSync(join(appDir, 'banner.html'))) return;
    try {
      const child = spawn(electron, [appDir, '--fl-mode=banner', `--fl-text=${text}`], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.on('error', (err) => log(`banner failed to start: ${err.message}`));
      child.unref();
    } catch (err) {
      log(`banner failed to start: ${String(err)}`);
    }
  };
}
