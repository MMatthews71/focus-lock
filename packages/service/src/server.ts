/**
 * Local HTTP API — the IPC surface the browser extensions and desktop UI use
 * to talk to the service. Bound to loopback only. All rule logic lives in the
 * service/core; this file only marshals requests and responses.
 *
 * The API is deliberately small and predictable:
 *
 *   GET  /health                      liveness + integrity status
 *   POST /check        {kind,value}   "can this load/run?" -> Decision
 *   GET  /state                       full engine state (for the UI)
 *   GET  /stats                       today's rolled-up statistics
 *   POST /targets      {target,rule}  add a managed target
 *   PUT  /targets/:id   {rule}        change a target's rule
 *   DEL  /targets/:id                 remove a target
 *   POST /categories   {categoryId,rule}
 *   POST /breaks/start {targetId}
 *   POST /breaks/end
 *   POST /modes/activate {modeId|null}
 *   POST /sessions/start {name,durationMs,locked,targetIds}
 *   POST /sessions/end
 *   PUT  /settings     {resetTime?,timezoneOffsetMinutes?}
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { CONTROL_PAGE_HTML } from './control.js';
import { parseNewTarget } from './targetinput.js';
import { isValidRule, type ProtectionService } from './service.js';
import type { ExtensionGuardian } from './guardian.js';
import type { AppGuardian } from './appguard.js';
import type { AccessRequest, Rule } from '@focuslock/core';

export interface ServerOptions {
  host?: string;
  port?: number;
  guardian?: ExtensionGuardian;
  appGuardian?: AppGuardian;
}

/** Longest focus session the API will start (a locked one can't be ended early). */
const MAX_SESSION_MS = 7 * 24 * 60 * 60 * 1000;

export const DEFAULT_PORT = 47615; // "FOCUS" on a phone keypad-ish; loopback only.

export function createApiServer(service: ProtectionService, options: ServerOptions = {}): Server {
  const host = options.host ?? '127.0.0.1';
  const guardian = options.guardian;
  const appGuardian = options.appGuardian;

  const port = options.port ?? DEFAULT_PORT;
  const server = createServer((req, res) => {
    handle(service, guardian, appGuardian, port, req, res).catch((err) => {
      sendJson(res, 500, { error: String(err?.message ?? err) });
    });
  });

  // Refuse any non-loopback connection defensively.
  server.on('connection', (socket) => {
    const addr = socket.remoteAddress ?? '';
    if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') {
      socket.destroy();
    }
  });

  server.listen(port, host);
  return server;
}

async function handle(
  service: ProtectionService,
  guardian: ExtensionGuardian | undefined,
  appGuardian: AppGuardian | undefined,
  port: number,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // Loopback-only sockets are not enough on their own: any web page open in the
  // browser can also reach 127.0.0.1. Refuse requests that a web page could
  // forge (see isTrustedRequest) before touching any route.
  const origin = req.headers.origin;
  if (!isTrustedRequest(req.headers.host, origin, port)) {
    return sendJson(res, 403, { error: 'forbidden origin' });
  }

  // CORS: echo only the trusted origin (the extension or the control page).
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Chrome's Private Network Access: a request from an extension/page to this
  // loopback server is a "private network" request and its preflight must be
  // explicitly allowed, or the browser silently blocks the call.
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  if (method === 'OPTIONS') return sendJson(res, 204, {});

  // ---- Control page (served same-origin so it works with no app installed) ----
  if (method === 'GET' && (path === '/' || path === '/control')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(CONTROL_PAGE_HTML);
    return;
  }

  // ---- Reads ----
  if (method === 'GET' && path === '/health') {
    return sendJson(res, 200, {
      ...service.getStatus(),
      // Browser enforcement is permanent — always on, no setting to disable it.
      guardian: { enforce: true, browsers: guardian ? guardian.status() : [] },
      appGuardian: { blocked: appGuardian ? appGuardian.status() : [] },
    });
  }
  // Extension heartbeat: proof that a supported browser is running FocusLock.
  if (method === 'POST' && path === '/extension/heartbeat') {
    const body = await readJson<{ browser?: string }>(req);
    if (guardian) guardian.heartbeat(body?.browser ?? 'chrome');
    return sendJson(res, 200, { ok: true });
  }
  // Graceful shutdown, used by the desktop app to replace an outdated service.
  // Loopback-only is already enforced by the connection guard.
  if (method === 'POST' && path === '/shutdown') {
    sendJson(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 50);
    return;
  }
  if (method === 'GET' && path === '/state') {
    return sendJson(res, 200, service.getState());
  }
  if (method === 'GET' && path === '/stats') {
    return sendJson(res, 200, service.getStats());
  }

  // ---- The check ----
  if (method === 'POST' && path === '/check') {
    const body = await readJson<AccessRequest>(req);
    if (!body || (body.kind !== 'web' && body.kind !== 'app') || typeof body.value !== 'string') {
      return sendJson(res, 400, { error: 'expected {kind:"web"|"app", value:string}' });
    }
    return sendJson(res, 200, service.check(body));
  }

  // ---- Targets ----
  if (method === 'POST' && path === '/targets') {
    // Blocks are permanent, so validate strictly before anything is saved.
    const parsed = parseNewTarget(await readJson<unknown>(req), service.getState().managedTargets);
    if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
    const created = service.addTarget(parsed.value.target, parsed.value.rule);
    return sendJson(res, 201, created);
  }
  const targetMatch = /^\/targets\/([^/]+)$/.exec(path);
  if (targetMatch) {
    const id = decodeURIComponent(targetMatch[1]!);
    if (method === 'PUT') {
      const body = await readJson<{ rule: Rule }>(req);
      if (!isValidRule(body?.rule)) return sendJson(res, 400, { error: 'expected {rule}' });
      const result = service.updateTargetRule(id, body!.rule);
      if (result.ok) return sendJson(res, 200, { ok: true });
      return sendJson(res, result.reason === 'not-found' ? 404 : 403, { ok: false, error: result.reason });
    }
    if (method === 'DELETE') {
      // Targets are locked once added (commitment device); removal is refused.
      const result = service.removeTarget(id);
      return sendJson(res, result.reason === 'not-found' ? 404 : 403, { ok: false, error: result.reason });
    }
  }

  // ---- Categories ----
  if (method === 'POST' && path === '/categories') {
    const body = await readJson<{ categoryId: string; rule: Rule }>(req);
    if (!body?.categoryId || !isValidRule(body.rule)) return sendJson(res, 400, { error: 'expected {categoryId, rule}' });
    try {
      return sendJson(res, 201, service.addCategory(body.categoryId, body.rule));
    } catch (err) {
      return sendJson(res, 400, { error: String((err as Error).message) });
    }
  }

  // ---- Breaks ----
  if (method === 'POST' && path === '/breaks/start') {
    const body = await readJson<{ targetId: string }>(req);
    if (typeof body?.targetId !== 'string' || !body.targetId) return sendJson(res, 400, { error: 'expected {targetId}' });
    const result = service.startBreak(body.targetId);
    return sendJson(res, result.ok ? 200 : 409, result);
  }
  if (method === 'POST' && path === '/breaks/end') {
    service.endBreak();
    return sendJson(res, 200, { ok: true });
  }

  // ---- App block screen ----
  // The block screen checks in while it's open, and reports "no break" so the
  // app it covers can be closed.
  if (method === 'POST' && path === '/apps/blockscreen/alive') {
    appGuardian?.blockScreenAlive();
    return sendJson(res, 200, { ok: true });
  }
  if (method === 'POST' && path === '/apps/decline') {
    const body = await readJson<{ targetId: string }>(req);
    if (!body?.targetId) return sendJson(res, 400, { error: 'expected {targetId}' });
    appGuardian?.decline(body.targetId);
    return sendJson(res, 200, { ok: true });
  }

  // ---- Weekly pass (e.g. a 4-hour movie pass, once a week) ----
  if (method === 'POST' && path === '/weekly-pass/start') {
    const body = await readJson<{ targetId: string }>(req);
    if (!body?.targetId) return sendJson(res, 400, { error: 'expected {targetId}' });
    const result = service.startWeeklyPass(body.targetId);
    return sendJson(res, result.ok ? 200 : 409, result);
  }

  // ---- Uninstall cooldown (commitment device) ----
  if (method === 'GET' && path === '/removal') {
    return sendJson(res, 200, service.removalStatus());
  }
  if (method === 'POST' && path === '/removal/request') {
    return sendJson(res, 200, { ok: true, ...service.requestRemoval() });
  }
  if (method === 'POST' && path === '/removal/cancel') {
    service.cancelRemoval();
    return sendJson(res, 200, { ok: true });
  }

  // ---- Modes ----
  if (method === 'POST' && path === '/modes/activate') {
    const body = await readJson<{ modeId: string | null }>(req);
    const modeId = body?.modeId ?? null;
    if (modeId !== null && typeof modeId !== 'string') return sendJson(res, 400, { error: 'expected {modeId}' });
    const result = service.setActiveMode(modeId);
    return sendJson(res, result.ok ? 200 : result.reason === 'not-found' ? 404 : 403, result);
  }

  // ---- Focus sessions ----
  if (method === 'POST' && path === '/sessions/start') {
    const body = await readJson<{ name: unknown; durationMs: unknown; locked?: unknown; targetIds?: unknown }>(req);
    const targetIds = body?.targetIds ?? [];
    if (
      typeof body?.name !== 'string' ||
      !body.name.trim() ||
      typeof body.durationMs !== 'number' ||
      !Number.isFinite(body.durationMs) ||
      body.durationMs <= 0 ||
      body.durationMs > MAX_SESSION_MS ||
      (body.locked !== undefined && typeof body.locked !== 'boolean') ||
      !Array.isArray(targetIds) ||
      !targetIds.every((t) => typeof t === 'string')
    ) {
      return sendJson(res, 400, { error: 'expected {name, durationMs (1ms..7d), locked?, targetIds?}' });
    }
    const now = Date.now();
    const result = service.startSession(
      {
        name: body.name.trim().slice(0, 100),
        startedAt: now,
        endsAt: now + body.durationMs,
        locked: body.locked ?? false,
        targetIds: targetIds as string[],
      },
      now,
    );
    if (!result.ok) return sendJson(res, 409, result);
    return sendJson(res, 201, result.session);
  }
  if (method === 'POST' && path === '/sessions/end') {
    const result = service.endSession();
    return sendJson(res, result.ok ? 200 : 409, result);
  }

  // ---- Settings ----
  if (method === 'PUT' && path === '/settings') {
    const body = await readJson<{ resetTime?: unknown; timezoneOffsetMinutes?: unknown }>(req);
    const result = service.updateSettings(body ?? {});
    if (!result.ok) return sendJson(res, 400, { error: result.reason });
    return sendJson(res, 200, service.getState().settings);
  }

  sendJson(res, 404, { error: `no route for ${method} ${path}` });
}

/**
 * Decide whether a request may use the API.
 *
 *  - Host must be a loopback name for our port. This defeats DNS rebinding,
 *    where a hostile site points its own domain at 127.0.0.1.
 *  - Origin, when present, must be the FocusLock extension (chrome-extension://,
 *    used by Chrome/Edge/Brave/Opera) or the control page served from this
 *    server. Browsers always attach Origin to cross-site POSTs, including
 *    `mode: 'no-cors'` ones, so this stops any website from silently calling
 *    /shutdown, /modes/activate, /extension/heartbeat, and so on.
 *  - No Origin at all means a non-browser local client (the block screen's
 *    Electron main process, the uninstaller's PowerShell, curl) or a same-origin
 *    GET from the control page. Those are allowed.
 */
export function isTrustedRequest(host: string | undefined, origin: string | undefined, port: number): boolean {
  const loopbackHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  if (!host || !loopbackHosts.includes(host.toLowerCase())) return false;
  if (origin === undefined) return true;
  if (/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return true;
  return loopbackHosts.some((h) => origin.toLowerCase() === `http://${h}`);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

async function readJson<T>(req: IncomingMessage): Promise<T | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    return null;
  }
}
