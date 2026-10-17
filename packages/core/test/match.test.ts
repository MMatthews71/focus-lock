import { describe, it, expect } from 'vitest';
import {
  hostFromUrl,
  hostMatchesDomain,
  normalizeAppName,
  findMatchingTarget,
} from '../src/match.js';
import type { ManagedTarget } from '../src/types.js';

describe('host helpers', () => {
  it('extracts and normalizes hosts', () => {
    expect(hostFromUrl('https://www.YouTube.com/watch?v=1')).toBe('youtube.com');
    expect(hostFromUrl('m.youtube.com')).toBe('m.youtube.com');
    expect(hostFromUrl('not a url ::')).toBeNull();
  });
  it('matches subdomains against a bare domain', () => {
    expect(hostMatchesDomain('m.youtube.com', 'youtube.com')).toBe(true);
    expect(hostMatchesDomain('youtube.com', 'youtube.com')).toBe(true);
    expect(hostMatchesDomain('notyoutube.com', 'youtube.com')).toBe(false);
  });
  it('normalizes app names case- and extension-insensitively', () => {
    expect(normalizeAppName('Steam.exe')).toBe('steam');
    expect(normalizeAppName('  DISCORD ')).toBe('discord');
  });
});

describe('findMatchingTarget precedence', () => {
  const mt = (id: string, kind: ManagedTarget['target']['kind'], value: string): ManagedTarget => ({
    target: { id, kind, value, label: value },
    rule: { type: 'permanent-block' },
  });

  it('matches a domain rule to a web request', () => {
    const managed = [mt('yt', 'domain', 'youtube.com')];
    const found = findMatchingTarget({ kind: 'web', value: 'https://m.youtube.com/feed' }, managed);
    expect(found?.target.id).toBe('yt');
  });

  it('prefers the most specific rule (url beats domain)', () => {
    const managed = [
      mt('yt-domain', 'domain', 'youtube.com'),
      mt('yt-shorts', 'url', 'https://youtube.com/shorts'),
    ];
    const shorts = findMatchingTarget(
      { kind: 'web', value: 'https://youtube.com/shorts/abc' },
      managed,
    );
    expect(shorts?.target.id).toBe('yt-shorts');
    const feed = findMatchingTarget({ kind: 'web', value: 'https://youtube.com/feed' }, managed);
    expect(feed?.target.id).toBe('yt-domain');
  });

  it('prefers a deeper subdomain rule over a parent domain rule', () => {
    const managed = [
      mt('all', 'domain', 'google.com'),
      mt('mail', 'domain', 'mail.google.com'),
    ];
    const found = findMatchingTarget({ kind: 'web', value: 'https://mail.google.com' }, managed);
    expect(found?.target.id).toBe('mail');
  });

  it('matches app requests to app targets only', () => {
    const managed = [mt('steam', 'app', 'Steam')];
    expect(findMatchingTarget({ kind: 'app', value: 'steam.exe' }, managed)?.target.id).toBe('steam');
    expect(findMatchingTarget({ kind: 'web', value: 'https://steam.com' }, managed)).toBeNull();
  });

  it('returns null when nothing matches', () => {
    const managed = [mt('yt', 'domain', 'youtube.com')];
    expect(findMatchingTarget({ kind: 'web', value: 'https://example.com' }, managed)).toBeNull();
  });

  it('keyword matches many mirror domains of the same site', () => {
    const managed = [mt('123', 'keyword', '123movies')];
    const hits = [
      'https://123movies.com',
      'https://www.123moviesfree.net',
      'https://ww1.123-movies.to/watch/foo',
      'https://123.movies.la',
      'http://123movies.sx/movie/123',
    ];
    for (const url of hits) {
      expect(findMatchingTarget({ kind: 'web', value: url }, managed)?.target.id).toBe('123');
    }
    // Unrelated sites are not caught.
    expect(findMatchingTarget({ kind: 'web', value: 'https://youtube.com' }, managed)).toBeNull();
    expect(findMatchingTarget({ kind: 'web', value: 'https://example.com' }, managed)).toBeNull();
  });

  it('keyword does not match app requests', () => {
    const managed = [mt('kw', 'keyword', 'discord')];
    expect(findMatchingTarget({ kind: 'app', value: 'Discord' }, managed)).toBeNull();
  });
});
