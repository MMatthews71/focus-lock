/**
 * Service bootstrap.
 *
 * Wires the store, the ProtectionService, and the HTTP API together, then
 * keeps everything alive. In production this process is what the OS supervises
 * (a Windows Service / launchd agent / systemd unit) so that "if the UI closes,
 * the service continues running" and "if the service stops, it restarts".
 *
 * Here we implement the parts that belong in user space:
 *  - a heartbeat / integrity tick,
 *  - graceful shutdown,
 *  - crash isolation so a bad request never takes the enforcer down.
 *
 * The OS-level supervision (auto-start with the OS, restart-on-exit) is
 * configured by the platform installer — see docs/ARCHITECTURE.md.
 */

import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ProtectionService } from './service.js';
import { Store } from './store.js';
import { createApiServer, DEFAULT_PORT } from './server.js';
import { ExtensionGuardian } from './guardian.js';
import { AppGuardian } from './appguard.js';
import { createBannerLauncher, createOverlayLauncher } from './overlay.js';
import { BreakNotifier } from './breaknotify.js';
import { notify } from './notify.js';

/** Install root: the folder above this service's own directory. */
const INSTALL_ROOT = process.env.FOCUSLOCK_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface BootOptions {
  dataDir?: string;
  port?: number;
}

export function boot(options: BootOptions = {}) {
  const dataDir = options.dataDir ?? join(homedir(), '.focuslock');
  const store = new Store(dataDir, join(dataDir, 'config.key'));
  const service = new ProtectionService(store);

  // The guardian closes supported browsers that run without the extension.
  // Enforcement is PERMANENT — there is no user setting to turn it off.
  const guardian = new ExtensionGuardian({
    isEnabled: () => true,
    log,
  });

  // The app guardian puts up the full-screen block screen when a blocked app
  // (e.g. Terraria) starts. The app stays open behind it while the user decides
  // whether to spend a break; it's closed if they don't.
  const showAppBlockScreen = createOverlayLauncher({ root: INSTALL_ROOT, log });
  const appGuardian = new AppGuardian({
    evaluate: (name) => service.evaluateApp(name),
    onBlocked: (name, decision) => {
      service.recordAppBlocked(name, decision);
      showAppBlockScreen(name, decision);
    },
    log,
  });

  // Warns the user 5 minutes and 30 seconds before an active break — or the
  // weekly movie pass — ends: a corner banner that shows even over a full-screen
  // game, plus a regular Windows notification.
  const showBanner = createBannerLauncher({ root: INSTALL_ROOT, log });
  const warn = (title: string, body: string) => {
    showBanner(body);
    notify(title, body, log);
  };
  const breakNotifier = new BreakNotifier({
    getActiveBreak: () => service.getState().breaks.activeBreak,
    notify: warn,
    what: 'break',
    log,
  });
  const passNotifier = new BreakNotifier({
    getActiveBreak: () => service.getState().weeklyPass.active,
    notify: warn,
    what: 'movie pass',
    log,
  });

  const port = options.port ?? DEFAULT_PORT;
  const server = createApiServer(service, { port, guardian, appGuardian });

  // Only enforce once we own the port. A second copy (e.g. started by the
  // supervisor while the first was slow to answer) must exit at once rather than
  // linger half-alive with its own guardians running alongside the real one.
  server.once('listening', () => {
    guardian.start();
    appGuardian.start();
    breakNotifier.start();
    passNotifier.start();
    const status = service.getStatus();
    log(`FocusLock service listening on 127.0.0.1:${port}`);
    log(`Protected targets: ${status.protectedTargets} | integrity: ${status.integrityOk ? 'OK' : 'FAILED (fail-closed)'}`);
    log('Extension enforcement: ON (permanent)');
  });
  server.once('error', (err: NodeJS.ErrnoException) => {
    log(
      err.code === 'EADDRINUSE'
        ? `port ${port} is already in use — another FocusLock service is running; exiting`
        : `could not start the API server: ${err.message}; exiting`,
    );
    process.exit(err.code === 'EADDRINUSE' ? 0 : 1);
  });

  // Heartbeat: a cheap liveness signal a supervisor / the UI can observe, and
  // a natural place to re-verify integrity over time.
  const heartbeat = setInterval(() => {
    const s = service.getStatus();
    if (!s.integrityOk) {
      log('integrity check failing — enforcing fail-closed safe mode');
    }
  }, 30_000);
  heartbeat.unref?.();

  // Never let an unexpected error tear down protection.
  process.on('uncaughtException', (err) => log(`uncaught: ${err?.stack ?? err}`));
  process.on('unhandledRejection', (reason) => log(`unhandled rejection: ${String(reason)}`));

  const shutdown = () => {
    log('shutting down…');
    clearInterval(heartbeat);
    guardian.stop();
    appGuardian.stop();
    breakNotifier.stop();
    passNotifier.stop();
    server.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { service, server, store, guardian };
}

function log(message: string): void {
  // eslint-disable-next-line no-console
  console.log(`[focuslock] ${new Date().toISOString()} ${message}`);
}

// Auto-boot when run directly (not when imported by tests). Use pathToFileURL
// so the comparison is correct on every platform — a naive `'file://' + argv[1]`
// never matches on Windows (backslash paths, and file:// vs file:///), which
// would silently prevent the service from ever starting.
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  boot({ port: Number(process.env.FOCUSLOCK_PORT ?? DEFAULT_PORT) });
}
