# FocusLock browser extension

A Manifest V3 extension that asks the local FocusLock service whether each page
may load, and shows the block page when it may not. It stores **no rules** and
makes **no decisions of its own** — the service is always the source of truth.

## Load it (Chrome / Edge / Brave / Opera / Arc)

1. Start the FocusLock service: `npm run service` (from the repo root).
2. Go to `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select this folder (`apps/extension`).

## How it works

- `background.js` — service worker. On every top-level navigation it POSTs to
  `http://127.0.0.1:47615/check`. If the answer is *blocked* — or the service
  is unreachable — it redirects the tab to `block.html` (**fail closed**).
- `content.js` — runs in each page and re-checks every few seconds, so a page
  that becomes blocked *while open* (e.g. when a 30-minute break expires) is
  closed on its own without a manual refresh. The worker also re-checks on tab
  focus and on a 30-second alarm (a backstop for throttled background tabs).
- `block.html` / `block.js` / `block.css` — the calm block page. When the
  service reports a daily break is available, the page offers to spend one.
- `popup.html` / `popup.js` — live protection status.

## Firefox

Firefox uses the same service API. It needs a separate build with Firefox's MV3
packaging (`browser_specific_settings`, background `scripts` fallback); that
packaging is not included here yet.

## Notes

- No build step: this loads as plain ES modules.
- The port (`47615`) is loopback-only and hard-coded to match the service
  default; make it configurable before shipping.
