/**
 * FocusLock block page logic.
 *
 * Reads the decision context passed in the query string, renders a calm block
 * screen, and — when the service says a daily break is available — offers to
 * spend one. Spending a break (or the weekly pass) asks the background worker
 * (which relays to the service) to start it, then reloads the original URL so
 * the now-unlocked page loads.
 */

const params = new URLSearchParams(location.search);
const originalUrl = params.get('url') ?? '';
const reason = params.get('reason') ?? 'permanent-block';
const breakAvailable = params.get('breakAvailable') === 'true';
const weeklyPassAvailable = params.get('weeklyPassAvailable') === 'true';
const breaksRemaining = Number(params.get('breaksRemaining') ?? '0');
const msUntilReset = Number(params.get('msUntilReset') ?? '0');
const targetId = params.get('targetId');

const REASON_TEXT = {
  'permanent-block': 'This target is permanently blocked.',
  'blocked-no-break-remaining': 'No daily breaks remaining.',
  'blocked-break-available': 'Blocked — but you can spend a daily break to open it.',
  'blocked-break-on-other-target': 'Your active break is being used on another app.',
  'blocked-by-schedule': 'Outside its allowed hours.',
  'blocked-by-mode': 'Blocked by your current mode.',
  'blocked-by-focus-session': 'A focus session is in progress.',
  'blocked-fail-closed': 'Protection is active in safe mode.',
  'service-unavailable': 'FocusLock protection is unavailable, so this page is blocked.',
};

function host(url) {
  try {
    return new URL(url).host;
  } catch {
    return url || '—';
  }
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const totalMinutes = Math.round(ms / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Null-safe: some of these elements may have been removed from the page.
function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}
setText('host', host(originalUrl));
setText('reason', REASON_TEXT[reason] ?? 'This page is currently unavailable.');
setText('reset', formatDuration(msUntilReset));
setText('breaks', String(breaksRemaining));

const breakBtn = document.getElementById('break-btn');
const passBtn = document.getElementById('weekly-pass-btn');

const canTakeBreak = breakAvailable && !!targetId && breaksRemaining > 0;
const canTakePass = weeklyPassAvailable && !!targetId;

if (breakBtn && canTakeBreak) {
  breakBtn.hidden = false;
  breakBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'start-break', targetId }, (response) => {
      if (response?.ok) {
        location.href = originalUrl; // reload; the page is now unlocked
      } else {
        breakBtn.textContent = 'Could not start break — try again';
      }
    });
  });
}

// Weekly 4-hour pass (e.g. to watch a full movie). Shown only when available.
if (passBtn && canTakePass) {
  passBtn.hidden = false;
  passBtn.addEventListener('click', () => {
    if (!confirm('Use your one weekly pass to unlock this for 4 hours? You get only one per week.')) return;
    chrome.runtime.sendMessage({ type: 'start-weekly-pass', targetId }, (response) => {
      if (response?.ok) {
        location.href = originalUrl; // reload; the page is now unlocked for 4 hours
      } else {
        passBtn.textContent = 'Could not start pass — try again';
      }
    });
  });
}

document.getElementById('close-btn').addEventListener('click', () => {
  // window.close() only works for script-opened tabs; fall back to a blank page.
  window.close();
  location.replace('about:blank');
});
