/**
 * Full-screen block screen for apps.
 *
 * When a blocked app starts, this opens a full-screen, always-on-top window that
 * looks exactly like the website block page (same markup and stylesheet),
 * offering the daily break. The app stays open behind it while the user
 * decides; the window reports the choice back to the service.
 *
 * The window is a tiny Electron app. Its two pieces — the Electron runtime
 * (`electron.exe`) and the overlay app folder (`main.cjs`, `preload.cjs`,
 * `overlay.html/js`, `block.css`) — live in different places depending on how
 * FocusLock was installed, so we do NOT hard-code one path. {@link
 * resolveBlockScreenAssets} searches every known layout:
 *
 *   - Elevated install  (<root>\electron\electron.exe + <root>\overlay\)
 *   - Dev / background   (runs from the repo: node_modules\electron\dist +
 *                         apps\overlay, found relative to this module)
 *
 * Electron is deliberately NOT a browser the extension guardian closes, so the
 * block screen can never be killed as a "browser without the extension".
 *
 * If neither piece can be found (e.g. Electron was never installed), the
 * launchers log exactly where they looked and do nothing — the app is still
 * closed, just without the screen.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Decision } from '@focuslock/core';

export interface OverlayLauncherOptions {
  /** Install root containing `electron/` and `overlay/` (elevated layout). */
  root: string;
  log?: (message: string) => void;
}

/** The two resolved pieces the block screen needs to launch. */
export interface BlockScreenAssets {
  /** Absolute path to the Electron runtime (electron.exe on Windows). */
  electron: string;
  /** Absolute path to the overlay app directory (the one holding main.cjs). */
  appDir: string;
}

/** On Windows the runtime is `electron.exe`; elsewhere (tests/dev) it's `electron`. */
const ELECTRON_BIN = process.platform === 'win32' ? 'electron.exe' : 'electron';

/** Directory of this compiled module — the anchor for the dev/deployed fallbacks. */
function thisModuleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * Find the Electron runtime and the overlay app folder, trying every install
 * layout in turn. Pure and fully injectable (`moduleDir`, `exists`) so it can be
 * unit-tested without a filesystem. Returns `null` when a piece is genuinely
 * absent, along with — via {@link describeSearch} — a record of where it looked.
 *
 * `root` is the install root the service was told about; `moduleDir` is where
 * this module sits (…/service in a deploy, …/packages/service/dist in the repo),
 * which is what lets us locate the repo's own `node_modules` and `apps/overlay`.
 */
export function resolveBlockScreenAssets(opts: {
  root: string;
  moduleDir?: string;
  exists?: (p: string) => boolean;
}): BlockScreenAssets | null {
  const moduleDir = opts.moduleDir ?? thisModuleDir();
  const exists = opts.exists ?? existsSync;

  const appDir = firstExisting(appDirCandidates(opts.root, moduleDir), (dir) => exists(join(dir, 'main.cjs')));
  const electron =
    (process.env.FOCUSLOCK_ELECTRON && exists(process.env.FOCUSLOCK_ELECTRON)
      ? process.env.FOCUSLOCK_ELECTRON
      : null) ?? firstExisting(electronCandidates(opts.root, moduleDir), exists);

  if (!appDir || !electron) return null;
  return { electron, appDir };
}

/** Candidate overlay app directories, most-specific first. */
export function appDirCandidates(root: string, moduleDir: string): string[] {
  return [
    join(root, 'overlay'), // elevated deploy: <root>\overlay
    join(moduleDir, '..', 'overlay'), // deploy alt: <deploy>\service\..\overlay
    join(moduleDir, '..', '..', '..', 'apps', 'overlay'), // dev: packages\service\dist -> repo\apps\overlay
  ];
}

/** Candidate Electron runtime paths, most-specific first. */
export function electronCandidates(root: string, moduleDir: string): string[] {
  return [
    join(root, 'electron', ELECTRON_BIN), // elevated deploy: <root>\electron\electron.exe
    join(moduleDir, '..', 'electron', ELECTRON_BIN), // deploy alt
    join(root, 'node_modules', 'electron', 'dist', ELECTRON_BIN), // root === repo
    join(moduleDir, '..', '..', '..', 'node_modules', 'electron', 'dist', ELECTRON_BIN), // dev: repo\node_modules\electron\dist
  ];
}

/** Human-readable list of everywhere the resolver looks (for logging on failure). */
export function describeSearch(root: string, moduleDir = thisModuleDir()): string {
  return `overlay app dir in [${appDirCandidates(root, moduleDir).join(', ')}]; electron in [${electronCandidates(root, moduleDir).join(', ')}]`;
}

function firstExisting(candidates: string[], exists: (p: string) => boolean): string | null {
  for (const c of candidates) if (exists(c)) return c;
  return null;
}

export function createOverlayLauncher(opts: OverlayLauncherOptions) {
  const log = opts.log ?? (() => {});
  let warned = false;

  return function showAppBlockScreen(processName: string, decision: Decision): void {
    if (process.platform !== 'win32') return;
    const assets = resolveBlockScreenAssets({ root: opts.root });
    if (!assets) {
      // Log once — the guardian calls this on every new block.
      if (!warned) {
        warned = true;
        log(`block screen not installed — looked for ${describeSearch(opts.root)}`);
      }
      log(`closed ${processName} without a block screen (Electron/overlay not found)`);
      return;
    }
    // Each value is its own argv entry (no shell), so spaces in paths are safe.
    // The "--fl-" prefix avoids clashing with Chromium's own switches (e.g. --app).
    const args = [
      assets.appDir,
      `--fl-app=${processName.replace(/\.exe$/i, '')}`,
      `--fl-target=${decision.targetId ?? ''}`,
      `--fl-break=${decision.breakAvailable === true}`,
      `--fl-pass=${decision.weeklyPassAvailable === true}`,
      `--fl-breaks=${decision.breaksRemaining}`,
      `--fl-reset=${decision.msUntilReset}`,
    ];
    try {
      const child = spawn(assets.electron, args, { detached: true, stdio: 'ignore', windowsHide: false });
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

  return function showBanner(text: string): void {
    if (process.platform !== 'win32') return;
    const assets = resolveBlockScreenAssets({ root: opts.root });
    // The banner lives in the same folder as the block screen and shares the
    // Electron runtime; if the block screen isn't installed, neither is this.
    if (!assets || !existsSync(join(assets.appDir, 'banner.html'))) return;
    try {
      const child = spawn(assets.electron, [assets.appDir, '--fl-mode=banner', `--fl-text=${text}`], {
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
