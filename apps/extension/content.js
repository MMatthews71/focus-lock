/**
 * FocusLock content script — live enforcement.
 *
 * Navigation checks alone can't catch a page that becomes blocked *while you're
 * sitting on it* — e.g. when a 30-minute daily break runs out, or a scheduled
 * window closes. This tiny script runs in every web page and periodically asks
 * the background worker "am I still allowed?". If not, the worker redirects the
 * tab to the block page. That means an expired break closes the page on its own
 * within a few seconds, without needing a manual refresh.
 *
 * Note: browsers throttle timers in background (hidden) tabs to roughly once a
 * minute, so for those the worker's own 30-second alarm scan is the backstop;
 * this timer gives near-immediate enforcement on the tab you're actually using.
 */

const POLL_MS = 4000;

function recheck() {
  try {
    chrome.runtime.sendMessage({ type: 'recheck', url: location.href }, () => {
      // Swallow "receiving end does not exist" while the worker is starting.
      void chrome.runtime.lastError;
    });
  } catch {
    /* extension context not available (e.g. during reload) */
  }
}

// Re-check on a timer, and again whenever the tab becomes visible.
setInterval(recheck, POLL_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') recheck();
});
