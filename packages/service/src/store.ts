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

import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, appendFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineState, StatEvent } from '@focuslock/core';
import { canonicalize, sign, verify, loadOrCreateSecret } from './integrity.js';

export interface LoadResult {
  /** The loaded state, or null when a config exists but nothing in it could be parsed. */
  state: EngineState | null;
  /** True when the stored config failed signature verification (tampered/corrupt). */
  integrityFailed: boolean;
  /** True when config.json was bad and the signed backup was used instead. */
  restoredFromBackup?: boolean;
}

interface ConfigFile {
  json: string;
  signature: string;
  updatedAt: number;
}

export class Store {
  private configPath: string;
  private backupPath: string;
  private eventsPath: string;
  private secret: Buffer;

  /**
   * @param dataDir    Directory to hold the data files (created if missing).
   * @param secretPath Path to the HMAC secret (created with 0600 if missing).
   */
  constructor(dataDir: string, secretPath: string) {
    mkdirSync(dataDir, { recursive: true });
    this.configPath = join(dataDir, 'config.json');
    // Last known-good signed copy. Restored automatically when config.json is
    // missing, unreadable, or fails verification, so deleting or hand-editing
    // the main file neither wipes every block nor bricks the browser.
    this.backupPath = join(dataDir, 'config.backup.json');
    this.eventsPath = join(dataDir, 'events.jsonl');
    this.secret = loadOrCreateSecret(secretPath);
  }

  hasConfig(): boolean {
    return existsSync(this.configPath) || existsSync(this.backupPath);
  }

  saveState(state: EngineState): void {
    const json = canonicalize(state);
    const signature = sign(this.secret, json);
    const payload: ConfigFile = { json, signature, updatedAt: Date.now() };
    // Atomic write: write to a temp file then rename over the target.
    const tmp = `${this.configPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    renameSync(tmp, this.configPath);
    // Keep the backup in step. Best effort: the primary write already landed.
    try {
      copyFileSync(this.configPath, `${this.backupPath}.tmp`);
      renameSync(`${this.backupPath}.tmp`, this.backupPath);
    } catch {
      /* ignore */
    }
  }

  /**
   * Load and verify the config. Never throws: a corrupt or unreadable file is
   * reported as an integrity failure (fail closed) instead of crashing the
   * service, which would otherwise leave nothing enforcing app blocks at all.
   *
   * Order of preference: a verified primary, then a verified backup, then (if
   * either file exists but neither verifies) a fail-closed result.
   */
  loadState(): LoadResult | null {
    const primaryExists = existsSync(this.configPath);
    const backupExists = existsSync(this.backupPath);
    if (!primaryExists && !backupExists) return null;

    const primary = primaryExists ? this.readVerified(this.configPath) : null;
    if (primary?.verified) return { state: primary.state, integrityFailed: false };

    const backup = backupExists ? this.readVerified(this.backupPath) : null;
    if (backup?.verified) {
      // Put the good copy back so the next load is clean.
      try {
        copyFileSync(this.backupPath, `${this.configPath}.tmp`);
        renameSync(`${this.configPath}.tmp`, this.configPath);
      } catch {
        /* ignore — we still return the verified state */
      }
      return { state: backup.state, integrityFailed: false, restoredFromBackup: true };
    }

    // Neither verifies. Keep whatever state we could parse (so the UI can still
    // show it), but flag it so the caller fails closed.
    const parsed = primary?.state ?? backup?.state;
    if (parsed) return { state: parsed, integrityFailed: true };
    return { state: null, integrityFailed: true };
  }

  private readVerified(path: string): { state: EngineState; verified: boolean } | null {
    try {
      const payload = JSON.parse(readFileSync(path, 'utf8')) as Partial<ConfigFile>;
      if (typeof payload.json !== 'string' || typeof payload.signature !== 'string') return null;
      const state = JSON.parse(payload.json) as EngineState;
      if (!state || typeof state !== 'object' || !Array.isArray(state.managedTargets)) return null;
      return { state, verified: verify(this.secret, payload.json, payload.signature) };
    } catch {
      return null;
    }
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
