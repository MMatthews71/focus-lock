/**
 * Request → Target matching.
 *
 * The service receives concrete requests ("is https://m.youtube.com/watch
 * allowed?", "may steam.exe run?") and must find which managed target, if any,
 * governs them. Matching is deliberately strict and predictable — a core
 * product principle is that "rules are predictable".
 */

import type { ManagedTarget, TargetKind } from './types.js';

/** A concrete thing the user/browser/OS is trying to access. */
export interface AccessRequest {
  kind: 'web' | 'app';
  /** For web: a full URL. For app: a process/executable name. */
  value: string;
}

/** Lower-case host with any leading "www." removed. */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^www\./, '');
}

/** Extract a normalized host from a URL string, or null if unparseable. */
export function hostFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url.includes('://') ? url : `https://${url}`);
    return normalizeHost(parsed.hostname);
  } catch {
    return null;
  }
}

/** True if `host` is `domain` or a subdomain of it. */
export function hostMatchesDomain(host: string, domain: string): boolean {
  const h = normalizeHost(host);
  const d = normalizeHost(domain);
  return h === d || h.endsWith(`.${d}`);
}

/** Normalize an app/executable name for comparison (case- and .exe-insensitive). */
export function normalizeAppName(name: string): string {
  return name.trim().toLowerCase().replace(/\.exe$/, '');
}

/**
 * Reduce a string to lower-case alphanumerics only. Used for keyword matching
 * so that "123movies", "123-movies", "123.movies" and "123 movies" all compare
 * equal — the trick that lets one keyword catch a piracy site's many mirror
 * domains.
 */
export function normalizeAlnum(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function matchesTarget(request: AccessRequest, kind: TargetKind, value: string): boolean {
  switch (kind) {
    case 'domain': {
      if (request.kind !== 'web') return false;
      const host = hostFromUrl(request.value);
      return host !== null && hostMatchesDomain(host, value);
    }
    case 'url': {
      if (request.kind !== 'web') return false;
      const reqHost = hostFromUrl(request.value);
      const ruleHost = hostFromUrl(value);
      if (!reqHost || !ruleHost || !hostMatchesDomain(reqHost, ruleHost)) return false;
      // URL rules additionally constrain by path prefix.
      const reqPath = safePath(request.value);
      const rulePath = safePath(value);
      return reqPath.startsWith(rulePath);
    }
    case 'keyword': {
      if (request.kind !== 'web') return false;
      const host = hostFromUrl(request.value);
      if (host === null) return false;
      const needle = normalizeAlnum(value);
      return needle.length > 0 && normalizeAlnum(host).includes(needle);
    }
    case 'app':
    case 'executable': {
      if (request.kind !== 'app') return false;
      return normalizeAppName(request.value) === normalizeAppName(value);
    }
    case 'category':
      // Categories are expanded into concrete targets before evaluation, so a
      // raw category target never matches a request directly.
      return false;
  }
}

function safePath(url: string): string {
  try {
    return new URL(url.includes('://') ? url : `https://${url}`).pathname || '/';
  } catch {
    return '/';
  }
}

/**
 * Find the managed target governing a request. When several match, the MOST
 * SPECIFIC wins: an exact `url` rule beats a `domain` rule, which beats a
 * broader parent-domain rule. This makes overlapping rules deterministic.
 */
export function findMatchingTarget(
  request: AccessRequest,
  managed: ManagedTarget[],
): ManagedTarget | null {
  let best: ManagedTarget | null = null;
  let bestScore = -1;

  for (const mt of managed) {
    if (!matchesTarget(request, mt.target.kind, mt.target.value)) continue;
    const score = specificity(mt.target.kind, mt.target.value);
    if (score > bestScore) {
      best = mt;
      bestScore = score;
    }
  }
  return best;
}

/** Higher = more specific. url > longer-domain > shorter-domain > app. */
function specificity(kind: TargetKind, value: string): number {
  switch (kind) {
    case 'url':
      return 1000 + value.length;
    case 'domain':
      return 100 + value.length; // longer/deeper domains beat parent domains
    case 'keyword':
      return 80; // broader than a specific domain, but still explicit
    case 'app':
    case 'executable':
      return 50;
    case 'category':
      return 0;
  }
}
