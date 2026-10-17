import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { resolveBlockScreenAssets } from '../src/overlay.js';

/**
 * These guard the bug that let a blocked app (e.g. Terraria) be closed with NO
 * block screen: the launcher only ever looked at `<root>/electron/electron.exe`,
 * which is absent in both real install layouts. The resolver must now find the
 * pieces wherever they actually land.
 */
describe('resolveBlockScreenAssets', () => {
  const bin = process.platform === 'win32' ? 'electron.exe' : 'electron';

  /** A fake filesystem: `exists(p)` is true iff `p` is in the set. */
  const fsWith = (present: string[]) => (p: string) => present.includes(p);

  it('finds the elevated-install layout (<root>/overlay + <root>/electron)', () => {
    const root = join('C:', 'Users', 'me', 'AppData', 'Local', 'FocusLock');
    const moduleDir = join(root, 'service');
    const present = [join(root, 'overlay', 'main.cjs'), join(root, 'electron', bin)];

    const assets = resolveBlockScreenAssets({ root, moduleDir, exists: fsWith(present) });

    expect(assets).toEqual({ appDir: join(root, 'overlay'), electron: join(root, 'electron', bin) });
  });

  it('finds the dev/background layout relative to the service module', () => {
    const repo = join('C:', 'dev', 'focus-lock');
    // The service runs in place from packages/service/dist; <root> is packages/service.
    const root = join(repo, 'packages', 'service');
    const moduleDir = join(root, 'dist');
    const present = [
      join(repo, 'apps', 'overlay', 'main.cjs'),
      join(repo, 'node_modules', 'electron', 'dist', bin),
    ];

    const assets = resolveBlockScreenAssets({ root, moduleDir, exists: fsWith(present) });

    expect(assets).toEqual({
      appDir: join(repo, 'apps', 'overlay'),
      electron: join(repo, 'node_modules', 'electron', 'dist', bin),
    });
  });

  it('returns null when Electron is missing even though the overlay is present', () => {
    const root = join('C:', 'FocusLock');
    const moduleDir = join(root, 'service');
    const present = [join(root, 'overlay', 'main.cjs')]; // no electron anywhere

    expect(resolveBlockScreenAssets({ root, moduleDir, exists: fsWith(present) })).toBeNull();
  });

  it('returns null when the overlay app folder is missing', () => {
    const root = join('C:', 'FocusLock');
    const moduleDir = join(root, 'service');
    const present = [join(root, 'electron', bin)]; // electron but no main.cjs

    expect(resolveBlockScreenAssets({ root, moduleDir, exists: fsWith(present) })).toBeNull();
  });

  it('prefers the elevated layout over the dev fallback when both exist', () => {
    const repo = join('C:', 'dev', 'focus-lock');
    const root = join(repo, 'packages', 'service');
    const moduleDir = join(root, 'dist');
    const present = [
      join(root, 'overlay', 'main.cjs'), // deployed next to <root>
      join(repo, 'apps', 'overlay', 'main.cjs'), // and in the repo
      join(root, 'electron', bin),
      join(repo, 'node_modules', 'electron', 'dist', bin),
    ];

    const assets = resolveBlockScreenAssets({ root, moduleDir, exists: fsWith(present) });

    // Most-specific (install-root) candidate wins.
    expect(assets).toEqual({ appDir: join(root, 'overlay'), electron: join(root, 'electron', bin) });
  });
});
