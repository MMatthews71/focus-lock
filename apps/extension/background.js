/**
 * FocusLock browser extension — background service worker.
 *
 * The extension is intentionally "dumb": it stores no rules and makes no
 * blocking decisions of its own. It asks the local FocusLock service, "Can
 * this page load?", and if the answer is no it redirects the tab to the
 * bundled block page. The service is always the single source of truth.
 *
 * If the service is unreachable the extension DEGRADES SAFELY rather than
 * failing closed on the entire web: it keeps a local mirror of the block list
 * and, while the service is momentarily down, blocks ONLY sites on that list
 * and lets everything else load. The instant the service answers again its
 * authoritative decisions take over. (Previously a downed service blocked every
 * page and locked the user out of the whole browser.)
 *
 * Reliability: navigations are caught from several angles — webNavigation
 * (before-navigate, committed, history state), tabs.onUpdated (reloads and URL
 * changes), and a scan of already-open tabs on startup — so a page can't slip
 * through just because one signal was missed while the worker was asleep.
 *
 * Open the service-worker console (chrome://extensions → FocusLock →
 * "Inspect views: service worker") to watch the [FocusLock] logs below.
 */

const SERVICE_ORIGIN = 'http://127.0.0.1:47615';
const BLOCK_PAGE = chrome.runtime.getURL('block.html');

function log(...args) {
  console.log('[FocusLock]', ...args);
}

// --- Offline block-list cache -----------------------------------------------
// The service is always the single source of truth. But if it is momentarily
// unreachable we must NOT brick the whole browser by blocking everything — that
// old fail-closed-on-everything behaviour locked the user out of every site.
// Instead we mirror the block list locally (refreshed whenever the service is
// up) and, while it is down, block only the sites actually on the list.
const CACHE_KEY = 'focuslock:blocklist';
let blockCache = []; // [{ kind, value }] — web targets that aren't always-allowed.

/** Load the cached block list from storage into memory (on worker wake-up). */
async function loadBlockCache() {
  try {
    const stored = await chrome.storage.local.get(CACHE_KEY);
    if (Array.isArray(stored[CACHE_KEY])) blockCache = stored[CACHE_KEY];
    log(`loaded ${blockCache.length} cached block pattern(s)`);
  } catch (err) {
    log('loadBlockCache failed:', String(err && err.message ? err.message : err));
  }
}

/** Refresh the cache from the service's authoritative state. No-op if down. */
async function refreshBlockCache() {
  try {
    const res = await fetch(`${SERVICE_ORIGIN}/state`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return;
    const state = await res.json();
    const targets = Array.isArray(state && state.managedTargets) ? state.managedTargets : [];
    // A break is GLOBAL: while one is active it unlocks EVERY target, so the
    // offline block list must be empty for its duration — otherwise a reload
    // that briefly can't reach the service would flash the block page mid-break.
    const now = Date.now();
    const active = state && state.breaks && state.breaks.activeBreak;
    const breakActive =
      !!active && typeof active.endsAt === 'number' && active.endsAt > now;
    const pass = state && state.weeklyPass && state.weeklyPass.active;
    const activePassTargetId =
      pass && typeof pass.endsAt === 'number' && pass.endsAt > now ? pass.targetId : null;
    const next = [];
    if (!breakActive) {
      for (const mt of targets) {
        const t = mt && mt.target;
        const rule = mt && mt.rule;
        if (!t || !rule || typeof t.value !== 'string' || !t.value) continue;
        // Only web targets can be matched against a URL offline, and an
        // always-allowed target never blocks — neither belongs in the cache.
        if (t.kind !== 'domain' && t.kind !== 'url' && t.kind !== 'keyword') continue;
        if (rule.type === 'always-allowed') continue;
        if (t.id && t.id === activePassTargetId) continue; // unlocked by an active weekly pass
        next.push({ kind: t.kind, value: t.value });
      }
    }
    blockCache = next;
    await chrome.storage.local.set({ [CACHE_KEY]: next });
    log(`refreshed block cache: ${next.length} pattern(s)`);
  } catch {
    /* service down — keep whatever we already have cached */
  }
}

// Offline matchers — ported verbatim from @focuslock/core's match.ts so the
// fallback classifies a URL exactly the way the service would.
function normalizeHost(host) {
  return host.trim().toLowerCase().replace(/^www\./, '');
}
function hostFromUrl(url) {
  try {
    return normalizeHost(new URL(url.includes('://') ? url : `https://${url}`).hostname);
  } catch {
    return null;
  }
}
function hostMatchesDomain(host, domain) {
  const h = normalizeHost(host);
  const d = normalizeHost(domain);
  return h === d || h.endsWith(`.${d}`);
}
function normalizeAlnum(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}
function safePath(url) {
  try {
    return new URL(url.includes('://') ? url : `https://${url}`).pathname || '/';
  } catch {
    return '/';
  }
}
function matchesCached(url, entry) {
  const host = hostFromUrl(url);
  if (host === null) return false;
  switch (entry.kind) {
    case 'domain':
      return hostMatchesDomain(host, entry.value);
    case 'url': {
      const ruleHost = hostFromUrl(entry.value);
      if (!ruleHost || !hostMatchesDomain(host, ruleHost)) return false;
      return safePath(url).startsWith(safePath(entry.value));
    }
    case 'keyword': {
      const needle = normalizeAlnum(entry.value);
      return needle.length > 0 && normalizeAlnum(host).includes(needle);
    }
    default:
      return false;
  }
}
/** True if `url` is on the cached block list (used only while service is down). */
function offlineBlocked(url) {
  return blockCache.some((entry) => matchesCached(url, entry));
}

/** Best-effort detection of which browser this is, for the guardian. */
function detectBrowser() {
  try {
    if (typeof navigator !== 'undefined' && navigator.brave) return 'brave';
  } catch {
    /* ignore */
  }
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  if (ua.includes('Edg/')) return 'edge';
  if (ua.includes('OPR/') || ua.includes('Opera')) return 'opera';
  return 'chrome';
}
const BROWSER_FAMILY = detectBrowser();

/**
 * Tell the service this browser is running FocusLock. If these stop arriving,
 * the service's guardian will (after a grace period) close this browser — that
 * is how "the extension can't just be removed" is enforced.
 */
async function sendHeartbeat() {
  try {
    await fetch(`${SERVICE_ORIGIN}/extension/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ browser: BROWSER_FAMILY }),
      signal: AbortSignal.timeout(1000),
    });
  } catch {
    /* service not up yet; will retry on the next tick */
  }
}

/** Ask the service about a URL. Returns a Decision, or null if unreachable. */
async function checkUrl(url) {
  try {
    const res = await fetch(`${SERVICE_ORIGIN}/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'web', value: url }),
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) {
      log('check HTTP', res.status, 'for', url);
      return null;
    }
    return await res.json();
  } catch (err) {
    log('check failed (service unreachable?):', String(err && err.message ? err.message : err));
    return null;
  }
}

/** Build the block-page URL carrying just enough context for it to render. */
function blockPageFor(url, decision) {
  const params = new URLSearchParams({ url });
  if (decision) {
    params.set('reason', decision.reason);
    params.set('breakAvailable', String(decision.breakAvailable));
    params.set('weeklyPassAvailable', String(decision.weeklyPassAvailable === true));
    params.set('breaksRemaining', String(decision.breaksRemaining));
    params.set('msUntilReset', String(decision.msUntilReset));
    if (decision.targetId) params.set('targetId', decision.targetId);
  } else {
    params.set('reason', 'service-unavailable');
  }
  return `${BLOCK_PAGE}?${params.toString()}`;
}

/** Only govern real web pages — never the block page or internal schemes. */
function isGovernable(url) {
  return typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://')) && !url.startsWith(BLOCK_PAGE);
}

/** Evaluate a tab's URL and redirect to the block page if it isn't allowed. */
async function evaluate(tabId, url, source) {
  if (typeof tabId !== 'number' || tabId < 0) return;
  if (!isGovernable(url)) return;

  const decision = await checkUrl(url);
  let blocked;
  if (decision) {
    blocked = !decision.allowed;
    log(source, blocked ? 'BLOCK' : 'allow', url, `(${decision.reason})`);
  } else {
    // Service unreachable: fall back to the cached block list instead of
    // failing closed on the whole web. Only known-bad sites are blocked.
    blocked = offlineBlocked(url);
    log(source, blocked ? 'BLOCK (offline cache)' : 'allow (offline; not on list)', url);
  }
  if (blocked) {
    try {
      await chrome.tabs.update(tabId, { url: blockPageFor(url, decision) });
    } catch (err) {
      log('redirect failed:', String(err && err.message ? err.message : err));
    }
  }
}

// --- webNavigation signals (top frame only) ---------------------------------
function fromWebNav(source) {
  return (details) => {
    if (details.frameId !== 0) return;
    evaluate(details.tabId, details.url, source);
  };
}
chrome.webNavigation.onBeforeNavigate.addListener(fromWebNav('before-navigate'));
chrome.webNavigation.onCommitted.addListener(fromWebNav('committed'));
chrome.webNavigation.onHistoryStateUpdated.addListener(fromWebNav('history-state'));

// --- tabs.onUpdated: reliably fires on reloads and URL changes ---------------
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') {
    const url = changeInfo.url || (tab && tab.url);
    if (url) evaluate(tabId, url, 'tab-updated');
  }
});

// --- On startup / install, scan any already-open tabs -----------------------
function scanOpenTabs(reason) {
  chrome.tabs.query({}, (tabs) => {
    log(`scanning ${tabs.length} open tab(s) (${reason})`);
    for (const tab of tabs) {
      if (tab.id != null && tab.url) evaluate(tab.id, tab.url, 'startup-scan');
    }
  });
}
chrome.runtime.onStartup.addListener(() => {
  sendHeartbeat();
  loadBlockCache().then(() => refreshBlockCache());
  scanOpenTabs('browser startup');
});
chrome.runtime.onInstalled.addListener(() => {
  log('installed / updated — FocusLock extension active');
  sendHeartbeat();
  loadBlockCache().then(() => refreshBlockCache());
  scanOpenTabs('installed');
});

// --- Live enforcement: catch pages that become blocked while sitting open ----
// Re-check the tab you switch to, and the focused tab when a window regains
// focus, so an expired break blocks immediately when you return to the page.
chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    if (!chrome.runtime.lastError && tab && tab.url) evaluate(tabId, tab.url, 'tab-activated');
  });
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  chrome.tabs.query({ active: true, windowId }, (tabs) => {
    for (const tab of tabs) if (tab.id != null && tab.url) evaluate(tab.id, tab.url, 'window-focus');
  });
});

// A periodic backstop (every 30s — the alarms minimum) re-checks every open tab.
// This catches background tabs whose page timers the browser has throttled.
chrome.alarms.create('focuslock-recheck', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'focuslock-recheck') {
    sendHeartbeat(); // ~every 30s, well within the guardian's timeout
    refreshBlockCache(); // keep the offline fallback list current
    scanOpenTabs('alarm');
  }
});

// --- Messaging: break start + health, used by the block page and popup ------
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message && message.type === 'recheck' && message.url) {
      const tabId = _sender.tab && _sender.tab.id;
      if (typeof tabId !== 'number' || !isGovernable(message.url)) {
        sendResponse({ blocked: false });
        return;
      }
      const decision = await checkUrl(message.url);
      // Only redirect on a *definite* block. If the service is momentarily
      // unreachable we skip this cycle rather than yanking the user off an
      // active page — navigation-time checks still fail closed.
      if (decision && !decision.allowed) {
        log('recheck BLOCK', message.url, `(${decision.reason})`);
        try {
          await chrome.tabs.update(tabId, { url: blockPageFor(message.url, decision) });
        } catch (err) {
          log('recheck redirect failed:', String(err && err.message ? err.message : err));
        }
        sendResponse({ blocked: true });
      } else {
        sendResponse({ blocked: false });
      }
      return;
    }
    if (message && message.type === 'start-break' && message.targetId) {
      try {
        const res = await fetch(`${SERVICE_ORIGIN}/breaks/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetId: message.targetId }),
        });
        sendResponse({ ok: res.ok });
      } catch {
        sendResponse({ ok: false });
      }
      return;
    }
    if (message && message.type === 'start-weekly-pass' && message.targetId) {
      try {
        const res = await fetch(`${SERVICE_ORIGIN}/weekly-pass/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetId: message.targetId }),
        });
        sendResponse({ ok: res.ok });
      } catch {
        sendResponse({ ok: false });
      }
      return;
    }
    if (message && message.type === 'health') {
      try {
        const res = await fetch(`${SERVICE_ORIGIN}/health`, { signal: AbortSignal.timeout(1000) });
        sendResponse(res.ok ? await res.json() : { running: false });
      } catch {
        sendResponse({ running: false });
      }
      return;
    }
    sendResponse({ ok: false });
  })();
  return true; // async response
});

log(`service worker loaded (browser: ${BROWSER_FAMILY})`);
sendHeartbeat();
loadBlockCache().then(() => refreshBlockCache());
