/**
 * FocusLock app block screen (Electron main process).
 *
 * Launched by the service when a blocked app starts:
 *   electron.exe <this dir> --fl-app=Terraria --fl-target=<id> --fl-break=true
 *                --fl-pass=false --fl-breaks=2 --fl-reset=<ms>
 *
 * Shows a full-screen, always-on-top window that looks exactly like the website
 * block page. The app stays open behind it while the user decides:
 *  - "Use one 30-minute break" spends a break; the app just keeps running.
 *  - Choosing not to (or closing this window any other way) tells the service,
 *    which then closes the app.
 * While open, the window checks in with the service every 2 seconds.
 */

const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const fs = require('fs');
const path = require('path');

// Some Windows GPU drivers crash the renderer ("renderer gone: crashed") under
// the kiosk / always-on-top block window, which makes the block screen flash and
// vanish instead of staying up. Software rendering draws once, a touch slower,
// but never lets the GPU process take the block screen down — correctness wins.
app.disableHardwareAcceleration();

const SERVICE = 'http://127.0.0.1:47615';
const LOG = path.join(__dirname, '..', 'overlay.log');

function log(message) {
  try {
    fs.appendFileSync(LOG, `${new Date().toISOString()}  [${process.pid}] ${message}\n`);
  } catch {
    /* ignore */
  }
}

function arg(name) {
  const prefix = `--fl-${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : '';
}

async function post(pathname, body) {
  try {
    const res = await fetch(SERVICE + pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}

/**
 * Banner mode (--fl-mode=banner --fl-text=...): a small warning in the top-right
 * corner, e.g. "Your break ends in 5 minutes." It sits above full-screen games,
 * never takes focus or blocks clicks, and goes away on its own after ~9 seconds.
 * Uses its own profile folder so it can run alongside the block screen.
 */
function runBanner() {
  app.setPath('userData', path.join(app.getPath('appData'), 'FocusLockBanner'));
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    const { screen } = require('electron');
    const area = screen.getPrimaryDisplay().workArea;
    const W = 400;
    const H = 96;
    const win = new BrowserWindow({
      width: W,
      height: H,
      x: area.x + area.width - W - 12,
      y: area.y + 12,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true);
    win.loadFile(path.join(__dirname, 'banner.html'), { query: { text: arg('text') } });
    win.once('ready-to-show', () => win.showInactive());
    log(`banner: ${arg('text')}`);
    setTimeout(() => app.quit(), 9000);
  });
  app.on('window-all-closed', () => app.quit());
}

if (arg('mode') === 'banner') {
  runBanner();
} else if (!app.requestSingleInstanceLock()) {
  // One block screen at a time. A second launch hands off to the first and does
  // nothing else — it must not create a window or register handlers of its own.
  log(`another block screen is open; exiting (app=${arg('app')})`);
  app.exit(0);
} else {
  const targetId = arg('target');
  let win = null;
  let decided = false; // a break was taken, or "no break" was reported
  let heartbeat = null;

  async function decline(why) {
    if (decided) return;
    decided = true;
    log(`no break taken (${why})`);
    if (targetId) await post('/apps/decline', { targetId });
  }

  app.on('second-instance', () => {
    log('second launch — bringing the existing block screen forward');
    if (win) {
      win.show();
      win.focus();
    }
  });

  ipcMain.handle('fl:start-break', async () => {
    const res = await post('/breaks/start', { targetId });
    if (res.ok) {
      decided = true;
      log('break taken');
    }
    return res;
  });
  ipcMain.handle('fl:start-pass', async () => {
    const res = await post('/weekly-pass/start', { targetId });
    if (res.ok) {
      decided = true;
      log('weekly pass taken');
    }
    return res;
  });
  ipcMain.handle('fl:close', async () => {
    await decline('user chose not to');
    if (win) win.close();
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    log(`showing block screen (app=${arg('app')}, break=${arg('break')}, pass=${arg('pass')})`);

    // Check in right away and every 2s, so the service knows the screen is up.
    post('/apps/blockscreen/alive');
    heartbeat = setInterval(() => post('/apps/blockscreen/alive'), 2000);

    win = new BrowserWindow({
      fullscreen: true,
      kiosk: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      backgroundColor: '#0e0f13',
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    // Above normal and most full-screen windows (the app is still running underneath).
    win.setAlwaysOnTop(true, 'screen-saver');

    win.loadFile(path.join(__dirname, 'overlay.html'), {
      query: {
        app: arg('app'),
        targetId,
        breakAvailable: arg('break'),
        weeklyPassAvailable: arg('pass'),
        breaksRemaining: arg('breaks'),
        msUntilReset: arg('reset'),
      },
    });

    win.once('ready-to-show', () => {
      win.show();
      win.focus();
    });
    // The app is running underneath; if it grabs the foreground, take it back.
    win.on('blur', () => {
      if (!decided && win && !win.isDestroyed()) {
        setTimeout(() => {
          if (!decided && win && !win.isDestroyed()) {
            win.setAlwaysOnTop(true, 'screen-saver');
            win.focus();
          }
        }, 150);
      }
    });
    // Closed some other way (e.g. Alt+F4) without choosing: that's a "no".
    win.on('close', () => {
      if (!decided) decline('window closed');
    });
    win.webContents.on('render-process-gone', (_e, details) => log(`renderer gone: ${details.reason}`));
    win.on('closed', () => {
      log('window closed');
      if (heartbeat) clearInterval(heartbeat);
      win = null;
      app.quit();
    });
  });

  app.on('window-all-closed', () => app.quit());
  process.on('uncaughtException', (err) => log(`uncaught: ${err && err.stack ? err.stack : err}`));
}
