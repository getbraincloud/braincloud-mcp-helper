import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveSyncRoot } from '../src/state';

let root: string;
beforeEach(async () => {
  // realpath: macOS tmpdir is a /var -> /private/var symlink; resolveSyncRoot returns the real path.
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bcstate-')));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('resolveSyncRoot', () => {
  it('returns an explicit rootDir as an absolute path without needing .bcsync', async () => {
    const resolved = await resolveSyncRoot(path.join(root, 'sub', 'folder'));
    expect(resolved).toBe(path.join(root, 'sub', 'folder'));
  });

  it('discovers the nearest .bcsync folder by walking up from the start dir', async () => {
    await fs.writeFile(path.join(root, '.bcsync'), '{"branchMappings":{}}\n', 'utf8');
    const nested = path.join(root, 'a', 'b', 'c');
    await fs.mkdir(nested, { recursive: true });

    expect(await resolveSyncRoot(undefined, nested)).toBe(root);
    expect(await resolveSyncRoot(undefined, root)).toBe(root);
  });

  it('discovers a folder marked only by .bcsync.local', async () => {
    await fs.writeFile(path.join(root, '.bcsync.local'), '{}\n', 'utf8');
    const nested = path.join(root, 'deep');
    await fs.mkdir(nested, { recursive: true });

    expect(await resolveSyncRoot(undefined, nested)).toBe(root);
  });

  it('throws an actionable error when no rootDir and no .bcsync is found', async () => {
    const nested = path.join(root, 'no', 'sync', 'here');
    await fs.mkdir(nested, { recursive: true });

    await expect(resolveSyncRoot(undefined, nested)).rejects.toThrow(/No rootDir given and no .bcsync/);
  });
});
