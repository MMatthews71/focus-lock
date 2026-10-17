import { describe, it, expect } from 'vitest';
import type { ManagedTarget } from '@focuslock/core';
import { parseNewTarget } from '../src/targetinput.js';

const body = (kind: string, value: string, rule = 'daily-break') => ({
  target: { kind, value, label: value },
  rule: { type: rule },
});

const existing: ManagedTarget[] = [
  { target: { id: '1', kind: 'keyword', value: '123movie', label: '123movie' }, rule: { type: 'daily-break' } },
  { target: { id: '2', kind: 'app', value: 'Terraria', label: 'Terraria' }, rule: { type: 'daily-break' } },
];

describe('parseNewTarget', () => {
  it('accepts a website and normalizes it to the bare domain', () => {
    const r = parseNewTarget(body('domain', 'https://www.YouTube.com/watch?v=abc'), existing);
    expect(r).toEqual({
      ok: true,
      value: { target: { kind: 'domain', value: 'youtube.com', label: 'https://www.YouTube.com/watch?v=abc' }, rule: { type: 'daily-break' } },
    });
  });

  it('accepts a keyword and an app (stripping .exe)', () => {
    const k = parseNewTarget(body('keyword', 'Reddit', 'permanent-block'), existing);
    expect(k.ok && k.value.target.value).toBe('reddit');
    const a = parseNewTarget(body('app', 'RobloxPlayerBeta.exe'), existing);
    expect(a.ok && a.value.target.value).toBe('RobloxPlayerBeta');
  });

  it('rejects unknown kinds and rules', () => {
    expect(parseNewTarget(body('website', 'youtube.com'), existing).ok).toBe(false);
    expect(parseNewTarget(body('domain', 'youtube.com', 'always-allowed'), existing).ok).toBe(false);
    expect(parseNewTarget(body('domain', 'youtube.com', 'daily-breaks'), existing).ok).toBe(false);
    expect(parseNewTarget(null, existing).ok).toBe(false);
  });

  it('rejects empty and malformed values', () => {
    expect(parseNewTarget(body('domain', '   '), existing).ok).toBe(false);
    expect(parseNewTarget(body('domain', 'not a site'), existing).ok).toBe(false);
    expect(parseNewTarget(body('domain', 'youtube'), existing).ok).toBe(false);
    expect(parseNewTarget(body('app', 'C:\\Games\\x.exe'), existing).ok).toBe(false);
  });

  it('refuses keywords so short they would block almost everything', () => {
    for (const w of ['com', 'www', 'net', 'a', '.c-o-m.']) {
      expect(parseNewTarget(body('keyword', w), existing).ok).toBe(false);
    }
  });

  it('refuses anything that would block FocusLock’s own page', () => {
    expect(parseNewTarget(body('domain', '127.0.0.1'), existing).ok).toBe(false);
    expect(parseNewTarget(body('keyword', 'localhost'), existing).ok).toBe(false);
    expect(parseNewTarget(body('keyword', '127001'), existing).ok).toBe(false);
  });

  it('refuses apps that would break Windows, the browser, or FocusLock', () => {
    for (const a of ['explorer', 'Explorer.exe', 'node', 'electron', 'wscript', 'chrome', 'svchost', 'taskmgr']) {
      expect(parseNewTarget(body('app', a), existing).ok).toBe(false);
    }
  });

  it('refuses duplicates of something already blocked', () => {
    expect(parseNewTarget(body('keyword', '123-Movie'), existing)).toEqual({ ok: false, error: 'That’s already blocked.' });
    expect(parseNewTarget(body('app', 'terraria.exe'), existing).ok).toBe(false);
  });
});
