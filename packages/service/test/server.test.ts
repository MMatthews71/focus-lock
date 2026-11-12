import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createApiServer, isTrustedRequest } from '../src/server.js';
import { ProtectionService } from '../src/service.js';
import { Store } from '../src/store.js';

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

describe('isTrustedRequest', () => {
  it('accepts local clients, the extension and the control page', () => {
    expect(isTrustedRequest('127.0.0.1:47615', undefined, 47615)).toBe(true);
    expect(isTrustedRequest('localhost:47615', EXT, 47615)).toBe(true);
    expect(isTrustedRequest('127.0.0.1:47615', 'http://127.0.0.1:47615', 47615)).toBe(true);
  });

  it('rejects web pages and DNS rebinding', () => {
    expect(isTrustedRequest('127.0.0.1:47615', 'https://evil.example', 47615)).toBe(false);
    expect(isTrustedRequest('127.0.0.1:47615', 'null', 47615)).toBe(false);
    expect(isTrustedRequest('evil.example:47615', undefined, 47615)).toBe(false);
    expect(isTrustedRequest(undefined, undefined, 47615)).toBe(false);
  });
});

describe('HTTP API origin guard', () => {
  let dir: string;
  let store: Store;
  let server: Server;
  let base: string;
  let port: number;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'focuslock-api-'));
    store = new Store(dir, join(dir, 'config.key'));
    const service = new ProtectionService(store);
    // The Host check needs to know the real port, so pick one up front.
    port = 47000 + Math.floor(Math.random() * 500);
    server = createApiServer(service, { port });
    await new Promise<void>((r) => server.once('listening', () => r()));
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a cross-site POST', async () => {
    const res = await fetch(`${base}/modes/activate`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' },
      body: JSON.stringify({ modeId: 'mode-work' }),
    });
    expect(res.status).toBe(403);
  });

  it('serves the extension with its own origin echoed back', async () => {
    const res = await fetch(`${base}/health`, { headers: { Origin: EXT } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(EXT);
  });

  it('validates focus session input', async () => {
    const res = await fetch(`${base}/sessions/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', durationMs: -5 }),
    });
    expect(res.status).toBe(400);
  });
});
