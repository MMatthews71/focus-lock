/**
 * Validation for blocks added through the API (e.g. the "Add a block" box on
 * the control page).
 *
 * Blocks are permanent — they can never be removed or loosened — so a mistake
 * here is a mistake forever. This rejects anything malformed, and anything that
 * would permanently break Windows, the browser FocusLock lives in, or FocusLock
 * itself (e.g. a keyword like "com" that matches nearly every website, or an
 * app like "explorer" / "node").
 */

import {
  normalizeAlnum,
  normalizeAppName,
  normalizeHost,
  type ManagedTarget,
} from '@focuslock/core';

export type NewTargetKind = 'domain' | 'keyword' | 'app';
export type NewRuleType = 'daily-break' | 'permanent-block';

export interface NewTarget {
  target: { kind: NewTargetKind; value: string; label: string };
  rule: { type: NewRuleType };
}

export type ParseResult = { ok: true; value: NewTarget } | { ok: false; error: string };

const KINDS: readonly NewTargetKind[] = ['domain', 'keyword', 'app'];
const RULES: readonly NewRuleType[] = ['daily-break', 'permanent-block'];

/** Keywords shorter than this match far too much (e.g. "com" matches almost every site). */
const MIN_KEYWORD_LENGTH = 4;

/** Hosts FocusLock itself is reached on — never let a block cover them. */
const OWN_HOSTS = ['localhost', '127.0.0.1'];

/**
 * Processes that must never be blocked: closing them would break Windows, the
 * browser the FocusLock extension and control page run in, or FocusLock itself.
 */
const PROTECTED_APPS = new Set([
  // FocusLock itself (service, supervisor, block screen, launcher)
  'node', 'electron', 'wscript', 'cscript',
  // Browsers FocusLock lives in
  'chrome', 'msedge',
  // Windows
  'explorer', 'svchost', 'csrss', 'wininit', 'winlogon', 'lsass', 'services', 'smss',
  'system', 'registry', 'dwm', 'taskmgr', 'conhost', 'sihost', 'ctfmon', 'fontdrvhost',
  'runtimebroker', 'searchhost', 'searchapp', 'startmenuexperiencehost',
  'shellexperiencehost', 'textinputhost', 'applicationframehost', 'securityhealthsystray',
  'cmd', 'powershell', 'pwsh', 'windowsterminal', 'openconsole', 'msedgewebview2',
]);

export function parseNewTarget(body: unknown, existing: readonly ManagedTarget[]): ParseResult {
  const b = body as { target?: { kind?: unknown; value?: unknown; label?: unknown }; rule?: { type?: unknown } } | null;
  const kind = b?.target?.kind;
  const rawValue = b?.target?.value;
  const ruleType = b?.rule?.type;

  if (typeof kind !== 'string' || !KINDS.includes(kind as NewTargetKind)) {
    return { ok: false, error: 'Choose a website, a word, or an app.' };
  }
  if (typeof ruleType !== 'string' || !RULES.includes(ruleType as NewRuleType)) {
    return { ok: false, error: 'Choose how it should be blocked.' };
  }
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    return { ok: false, error: 'Type what to block.' };
  }
  if (rawValue.length > 200) {
    return { ok: false, error: 'That name is too long.' };
  }

  let value: string;
  switch (kind as NewTargetKind) {
    case 'domain': {
      // Accept "https://www.youtube.com/watch?v=x" and keep just "youtube.com".
      const host = normalizeHost(
        rawValue.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0]!.split(':')[0]!,
      );
      if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) {
        return { ok: false, error: 'That doesn’t look like a website address (e.g. youtube.com).' };
      }
      if (/^[0-9.]+$/.test(host) || OWN_HOSTS.includes(host)) {
        return { ok: false, error: 'That address can’t be blocked.' };
      }
      value = host;
      break;
    }
    case 'keyword': {
      const word = normalizeAlnum(rawValue);
      if (word.length < MIN_KEYWORD_LENGTH) {
        return { ok: false, error: `Use at least ${MIN_KEYWORD_LENGTH} letters or numbers — shorter words match too many sites.` };
      }
      if (OWN_HOSTS.some((h) => normalizeAlnum(h).includes(word))) {
        return { ok: false, error: 'That word would block FocusLock’s own page, so it can’t be used.' };
      }
      value = rawValue.trim().toLowerCase();
      break;
    }
    case 'app': {
      const name = normalizeAppName(rawValue);
      if (!/^[a-z0-9][a-z0-9 ._+-]*$/.test(name)) {
        return { ok: false, error: 'Use the app’s process name from Task Manager → Details (e.g. Terraria).' };
      }
      if (PROTECTED_APPS.has(name)) {
        return { ok: false, error: 'Blocking that would break Windows, your browser, or FocusLock itself.' };
      }
      value = rawValue.trim().replace(/\.exe$/i, '');
      break;
    }
  }

  // Already blocked? (Compare the way the matcher compares.)
  const same = (t: ManagedTarget): boolean => {
    if (t.target.kind !== kind) return false;
    if (kind === 'domain') return normalizeHost(t.target.value) === value;
    if (kind === 'keyword') return normalizeAlnum(t.target.value) === normalizeAlnum(value);
    return normalizeAppName(t.target.value) === normalizeAppName(value);
  };
  if (existing.some(same)) {
    return { ok: false, error: 'That’s already blocked.' };
  }

  const rawLabel = b?.target?.label;
  const label = typeof rawLabel === 'string' && rawLabel.trim() ? rawLabel.trim().slice(0, 80) : value;

  return {
    ok: true,
    value: { target: { kind: kind as NewTargetKind, value, label }, rule: { type: ruleType as NewRuleType } },
  };
}
