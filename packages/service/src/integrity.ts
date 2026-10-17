/**
 * Configuration integrity.
 *
 * A core product promise is that FocusLock is hard to bypass and that
 * externally-modified rules are rejected. Without kernel-level protection a
 * user-space service cannot *prevent* tampering, but it can reliably *detect*
 * it and fail closed.
 *
 * We keep an HMAC over the serialized configuration, signed with a locally
 * generated secret. On load we recompute and compare:
 *  - match   -> trust the config.
 *  - mismatch-> the stored rules were edited outside the app; refuse to trust
 *               them and hand the caller a fully-blocked safe state instead.
 *
 * The secret lives in a separate file with restrictive permissions. This is a
 * pragmatic, honest model — documented as such — not security theatre.
 */

import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';

export function loadOrCreateSecret(path: string): Buffer {
  if (existsSync(path)) {
    return readFileSync(path);
  }
  const secret = randomBytes(32);
  writeFileSync(path, secret, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort on platforms without POSIX perms */
  }
  return secret;
}

/** Deterministic HMAC-SHA256 signature over a canonical JSON string. */
export function sign(secret: Buffer, canonicalJson: string): string {
  return createHmac('sha256', secret).update(canonicalJson).digest('hex');
}

/** Constant-time-ish verification. */
export function verify(secret: Buffer, canonicalJson: string, signature: string): boolean {
  const expected = sign(secret, canonicalJson);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Canonical JSON: keys sorted recursively so semantically-identical configs
 * always serialize identically (and thus sign identically).
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
