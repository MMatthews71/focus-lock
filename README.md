# FocusLock

A desktop focus & distraction blocking app, built as a **commitment device**.

FocusLock is designed around one assumption: *future you will try to bypass
it.* Every decision favours reliability and predictability over flexibility.
It fails **closed** rather than open, runs entirely locally, needs no account
and no subscription.

> **Status — early foundation.** This repository contains a working,
> fully-tested **Rule Engine** and **Background Service**, a loadable
> **browser extension**, and a building **desktop UI**. The OS-level pieces
> that make blocking truly unbypassable on Windows (a privileged Windows
> Service, process termination, protected config storage, code-signed
> binaries) are **designed for but not yet implemented** — see
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for exactly what is and isn't
> here. Nothing in this codebase attempts malware-like persistence.

## The four components

| # | Component | Package | State |
|---|-----------|---------|-------|
| 1 | Desktop App | [`apps/desktop`](apps/desktop) | Electron + React + TS + Tailwind — builds & runs |
| 2 | Background Protection Service | [`packages/service`](packages/service) | Node (no native deps), HTTP IPC — runs & tested |
| 3 | Browser Extensions | [`apps/extension`](apps/extension) | MV3, loadable unpacked |
| 4 | Rule Engine | [`packages/core`](packages/core) | Pure, deterministic, 44 unit tests |

The golden rule: **the service is the single source of truth.** The UI and the
extensions never store rules or make blocking decisions — they only ask the
service *"can this load/run?"* and render the answer.

```
Desktop UI ──┐
             ├── HTTP (loopback) ──▶ Background Service ──▶ Rule Engine (core)
Extensions ──┘                              │
                                            └── files (signed config + stats)
```

## Quick start

Requires Node ≥ 18. No native modules or build tools needed.

**Windows (one click, no terminal windows):** double-click **`FocusLock.vbs`**.
The first run shows a one-time setup console (install + build); after that it
launches the Electron app **silently — no console/terminal windows appear**.
The app boots the background service itself (also hidden) if it isn't already
running.

> Prefer to see logs? `run.bat` does the same thing but keeps a visible console
> for build output and app logs — useful for troubleshooting.

**Any platform (manual):**

```bash
npm install          # install all workspaces (downloads Electron on first run)
npm test             # run the full test suite (51 tests)
npm run build        # build every package

# Run the Electron desktop app in dev (starts Vite + Electron; the app boots
# the background service for you):
npm run app

# Package a distributable desktop app (installer/AppImage/dmg):
npm run dist:win     # or run electron-builder for your platform
```

Prefer to run the pieces separately (e.g. to use the UI in a browser)?

```bash
npm run service      # background service on 127.0.0.1:47615
npm run desktop      # Vite dev server on http://localhost:5173 (proxies /api)
```

### Load the browser extension

1. Start the service (`npm run service`).
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select [`apps/extension`](apps/extension).
4. Add a rule in the desktop UI (or via the API) and try to visit the site.

> **Extension enforcement.** By default the service closes any supported
> browser that runs *without* the FocusLock extension, after a ~2-minute grace
> period (with an on-screen countdown so you can install it). This stops the
> obvious bypass of just removing the extension. Toggle it in the desktop app
> under **Browser protection**, or via `PUT /settings {"enforceExtension":false}`.

## Try the service API directly

```bash
# Block TikTok permanently
curl -X POST localhost:47615/targets -H 'Content-Type: application/json' \
  -d '{"target":{"kind":"domain","value":"tiktok.com","label":"TikTok"},"rule":{"type":"permanent-block"}}'

# Ask if a page may load
curl -X POST localhost:47615/check -H 'Content-Type: application/json' \
  -d '{"kind":"web","value":"https://tiktok.com"}'
# -> {"allowed":false,"reason":"permanent-block",...}
```

See [`packages/service`](packages/service/src/server.ts) for the full API.

## Rule types

A target can be a website (domain), a **keyword** (matches any address
containing it — one "123movies" keyword blocks all its mirror domains), or an
app. Every target has exactly **one** rule — no confusing combinations:

- **Permanent block** — always blocked, never eligible for a break.
- **Daily breaks** — the flagship. Blocked unless you spend one of your daily
  break tokens (default **2 × 30 min**). Tokens are **global/shared** across all
  daily-break targets and **exclusive** (one break unlocks one target at a
  time). No rollover; refills at your chosen reset time (default 05:00).
- **Scheduled** — allowed only inside recurring time windows.
- **Always allowed** — never restricted.

**Modes** (Work, Study, Sleep, …) instantly reshape the rule set, including
allow-list modes ("allow VS Code + Slack, block everything else"). **Focus
Sessions** are a separate, optionally *locked* deep-work lockdown that cannot be
ended early.

## Design principles

Calm, modern, fast, reliable, invisible while working, and impossible to
*accidentally* bypass. Dark-mode first, lots of spacing, minimal settings.

## License

MIT — see [LICENSE](LICENSE).
