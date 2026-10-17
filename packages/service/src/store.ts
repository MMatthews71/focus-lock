/**
 * Persistence.
 *
 * Rules, break state, modes, settings and statistics events are stored on disk
 * as plain files:
 *   - `config.json`     — the engine state plus its integrity signature.
 *   - `events.jsonl`    — append-only statistics events, one JSON per line.
 *
 * We deliberately use a dependency-free file store rather than a native or
 * built-in database so the service runs on any Node ≥ 18 with zero build tools
 * and zero experimental flags. The {@link Store} class is a narrow interface,
 * so a SQLite-backed implementation (e.g. Node's `node:sqlite`, which needs
 * Node ≥ 22.5) can be swapped in later without touching the rest of the service.
 *
 * The store owns integrity: every save re-signs the config, and every load
 * verifies the signature. A tampered config is reported so the caller can fail
 * closed.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineState, StatEvent } from '@focuslock/core';
import { canonicalize, sign, verify, loadOrCreateSecret } from './integrity.js';

export interface LoadResult {
  state: EngineState;
  /** True when the stored config failed signature verification (tampered). */
  integrityFailed: boolean;
}

interface ConfigFile {
  json: string;
  signature: string;
  updatedAt: number;
}

export class Store {
  private configPath: string;
  private eventsPath: string;
  private secret: Buffer;

  /**
   * @param dataDir    Directory to hold the data files (created if missing).
   * @param secretPath Path to the HMAC secret (created with 0600 if missing).
   */
  constructor(dataDir: string, secretPath: string) {
    mkdirSync(dataDir, { recursive: true });
    this.configPath = join(dataDir, 'config.json');
    this.eventsPath = join(dataDir, 'events.jsonl');
    this.secret = loadOrCreateSecret(secretPath);
  }

  hasConfig(): boolean {
    return existsSync(this.configPath);
  }

  saveState(state: EngineState): void {
    const json = canonicalize(state);
    const signature = sign(this.secret, json);
    const payload: ConfigFile = { json, signature, updatedAt: Date.now() };
    // Atomic write: write to a temp file then rename over the target.
    const tmp = `${this.configPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    renameSync(tmp, this.configPath);
  }

  loadState(): LoadResult | null {
    if (!existsSync(this.configPath)) return null;
    const raw = readFileSync(this.configPath, 'utf8');
    const payload = JSON.parse(raw) as ConfigFile;
    const integrityFailed = !verify(this.secret, payload.json, payload.signature);
    const state = JSON.parse(payload.json) as EngineState;
    return { state, integrityFailed };
  }

  appendStatEvent(event: StatEvent): void {
    appendFileSync(this.eventsPath, `${JSON.stringify(event)}\n`, 'utf8');
  }

  /** All stat events at/after `sinceMs`, oldest first. */
  statEventsSince(sinceMs: number): StatEvent[] {
    if (!existsSync(this.eventsPath)) return [];
    const lines = readFileSync(this.eventsPath, 'utf8').split('\n');
    const out: StatEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as StatEvent;
        if (event.at >= sinceMs) out.push(event);
      } catch {
        // Skip any partially-written/corrupt line rather than crashing.
      }
    }
    return out;
  }

  /** Delete stat events older than `beforeMs` (housekeeping). */
  pruneStatEvents(beforeMs: number): void {
    const kept = this.statEventsSince(beforeMs);
    const body = kept.map((e) => JSON.stringify(e)).join('\n');
    writeFileSync(this.eventsPath, body ? `${body}\n` : '', 'utf8');
  }

  // Kept for API symmetry with a future database-backed store.
  close(): void {
    /* no open handles to release for the file store */
  }
}
