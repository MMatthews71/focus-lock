# FocusLock architecture

This document describes how FocusLock is put together, why, and — importantly —
what is implemented today versus designed for the future. Honesty about the
boundary matters for a tool whose entire value is trustworthiness.

## Layering

```
┌─────────────────────────────────────────────────────────────┐
│  Desktop UI  (apps/desktop)      Browser Extensions (apps/…) │
│  React + TS + Tailwind           MV3 service worker + block  │
└───────────────┬─────────────────────────────┬───────────────┘
                │  HTTP over loopback (IPC)    │
                ▼                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Background Protection Service   (packages/service)          │
│  • HTTP API (server.ts)                                      │
│  • ProtectionService state machine (service.ts)              │
│  • File persistence + integrity signing (store.ts)           │
└───────────────┬─────────────────────────────────────────────┘
                │  pure function calls
                ▼
┌─────────────────────────────────────────────────────────────┐
│  Rule Engine   (packages/core)                               │
│  Pure, deterministic, no I/O, no clock. evaluate(state,…)    │
└─────────────────────────────────────────────────────────────┘
```

### Why this shape

- **Single source of truth.** Only the service mutates and persists state. The
  UI and extensions are stateless clients. This is what lets the spec's promise
  hold: *"if the UI closes, the service continues"* and *"rules are enforced by
  the service, not the browser extensions or UI."*
- **A pure engine.** `@focuslock/core` takes `(state, request, now)` and returns
  a `Decision`. No ambient clock, no database, no network. Every decision is
  deterministic and unit-testable, and the *same* engine can later run on
  macOS/Linux or be compiled to WASM for an extension-side fast path without
  changing any logic.
- **Fail closed, everywhere.** `evaluateSafely` blocks on any internal error.
  The service blocks *everything* if its signed config fails verification. The
  extension blocks the page if the service is unreachable.

## The Rule Engine (`packages/core`)

Pure modules, each independently tested:

| Module | Responsibility |
|--------|----------------|
| `types.ts` | The whole domain: `Target`, `Rule`, `EngineState`, `Decision`. |
| `time.ts` | Wall-clock reasoning: reset-day keys, schedule windows, "ms until…". |
| `breaks.ts` | The break-token pool: grant, spend, expire, refill (no rollover). |
| `match.ts` | Request → target matching with most-specific-wins precedence. |
| `modes.ts` | Effective-rule resolution under an active mode. |
| `categories.ts` | Curated category → target expansion. |
| `engine.ts` | `evaluate` / `evaluateSafely` — ties it all together. |
| `stats.ts` | Minimal statistics rollups. |

### Decision precedence (fixed & documented)

1. **Active Focus Session** covering the target → **blocked**.
2. The target's **effective rule** (base rule as reshaped by the active mode):
   - `always-allowed` → allowed
   - `scheduled` → allowed inside a window, else blocked
   - `permanent-block` → blocked (breaks never apply)
   - `daily-break` → allowed only while an exclusive break unlocks it
3. **No matching target** → allowed (FocusLock only governs what you configure).

### Determinism

The engine never calls `Date.now()`. Callers pass `now` (epoch ms) and a
`timezoneOffsetMinutes`. Daily resets and schedules are therefore reproducible
and testable across timezones. Break state is reconciled lazily on every read
(`reconcileBreaks`) so that time-driven transitions — token refills at the
reset boundary and break expiry — always apply exactly once.

## The Background Service (`packages/service`)

- **`server.ts`** — a small `node:http` API bound to `127.0.0.1` only, with a
  connection guard that drops non-loopback peers. Endpoints are listed at the
  top of the file. No framework: "very lightweight" is a product goal.
- **`service.ts`** — `ProtectionService` holds the authoritative `EngineState`
  in memory, applies mutations, persists them, records stats, and answers
  `check()` by deferring to the engine.
- **`store.ts`** — a dependency-free file store: the engine state is written to
  `config.json` as one **signed** payload (atomic write via temp-file + rename),
  and stat events are appended to `events.jsonl`. This runs on any Node ≥ 18
  with no native modules, no build tools, and no experimental flags. `Store` is
  a narrow interface, so a SQLite backend (e.g. Node's `node:sqlite`, which
  needs Node ≥ 22.5) can be dropped in later without touching the rest of the
  service.
- **`integrity.ts`** — HMAC-SHA256 over a canonical (key-sorted) JSON of the
  config, keyed by a locally-generated secret with `0600` permissions.
- **`guardian.ts`** — the Extension Guardian. The extension heartbeats the
  service (`POST /extension/heartbeat`) every ~30s; the guardian lists running
  browser processes and closes any supported browser that has no recent
  heartbeat, after a ~120s grace window (so the user can install the extension).
  A chromium-family heartbeat protects both `chrome.exe` and `brave.exe` to
  avoid ever closing a browser that is in fact protected. Toggleable via the
  `enforceExtension` setting.

### Integrity & fail-closed model (honest scope)

A user-space process **cannot prevent** a determined user with admin rights from
editing the database — so FocusLock **detects** tampering instead:

- Every save re-signs the config; every load verifies it.
- On a verification failure the service enters **safe mode**: `check()` blocks
  *every* request (not just the surviving rules — an attacker might have deleted
  rules, and enforcing only what's left would be a fail-open hole).
- Trust is re-established only when the app writes a fresh, correctly-signed
  config through the normal API.

This is a real, testable safety property (see `service.test.ts`), not security
theatre — but it is **detection, not prevention**. True prevention needs the OS
layer below.

## Browser Extensions (`apps/extension`)

Manifest V3, loadable unpacked, deliberately "dumb":

- `background.js` listens to `webNavigation` and asks the service `/check` on
  every top-level navigation; on "no" (or if the service is unreachable) it
  redirects the tab to the bundled **block page**.
- `block.html/js/css` render the calm block screen and, when a daily break is
  available, let the user spend one (relayed to the service, then reload).
- `popup.html/js` shows live protection status.

The same service API works for Chrome, Edge, Brave, Opera and Arc (all
Chromium/MV3). A Firefox build differs only in packaging.

## Desktop App (`apps/desktop`)

An **Electron** shell around a React + TypeScript + Tailwind + Vite UI. The
renderer is a stateless control surface over the service API (`src/api.ts`) —
dark-first, calm, minimal: the home dashboard, break-token pool, mode picker,
and target manager. In dev, Vite proxies `/api/*` to the service; in the
packaged app the renderer calls the service directly over loopback.

- `electron/main.cjs` — the main process. On launch it **pings the service and,
  if it isn't running, spawns it as a detached child** so protection keeps
  running after the window closes (per the spec). Then it opens the window and
  loads the Vite dev server (dev) or the built files (prod).
- `electron/preload.cjs` — a context-isolated bridge (`contextIsolation: true`,
  `nodeIntegration: false`) exposing only app metadata today; it's the seam for
  future native calls (e.g. an OS "pick an app to block" dialog) without
  weakening isolation.
- Packaging is configured via **electron-builder** (`npm run dist` / `dist:win`),
  producing an NSIS installer on Windows (AppImage/dmg elsewhere). The service
  and core bundles are shipped as `extraResources`.

> Electron was chosen over Tauri here for zero-friction cross-platform builds
> from the existing Node/TS stack; the layering (a stateless renderer over the
> service contract) means a future Tauri shell could replace `electron/` without
> touching the UI or the engine.

## What is intentionally NOT here yet

These belong to the OS-integration phase and are designed-for but unimplemented:

- **Windows Service** (privileged) that supervises the Node/Rust enforcer,
  auto-starts with Windows, and restarts it on exit.
- **Real application blocking** — enumerating and terminating blocked processes
  (`App Blocker` / `Process Monitor` in the spec diagram). The engine already
  answers app `check()`s; the OS hook that acts on the answer is future work.
- **Protected configuration storage** (ACL'd / DPAPI-encrypted) and
  **code-signed** binaries so integrity is *enforced*, not just *detected*.
- **Real application blocking that acts on `check()`** (the process monitor can
  now close browsers — see the guardian below — but doesn't yet terminate other
  blocked apps like Steam).
- **Auto-update** and code-signed installers (electron-builder packaging is
  wired up, but signing certs and an update feed are not).
- **Bundling the service into the packaged app** so the desktop build is fully
  self-contained (today the service is run from the repo / shipped alongside as
  a resource; a production build would launch the bundled copy).

## Extending FocusLock

The layering is chosen so future features slot in without architectural churn:

- **New rule type?** Add a variant to `Rule` and a case to `evaluate`. The type
  system will flag every place that must handle it.
- **macOS / Linux?** The engine is already platform-free. Add a new enforcer
  process that reuses `@focuslock/core` and the service contract.
- **Cloud sync / mobile companion?** They become additional clients of the same
  signed-state contract; the engine stays the authority.
