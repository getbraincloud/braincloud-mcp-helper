import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseCcjs, type ZipScript } from '@braincloud/cloudsync-core';
import { readScriptTree, writeScript, writeScriptTree, deleteScript } from '../src/fs-tree';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'bcsync-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const SCRIPTS: ZipScript[] = [
  { path: 'utils/game/saveProgress', body: 'main();', metadata: { clientCallable: true, scriptTimeout: 30 } },
  { path: 'api/helper', body: 'doApi();', metadata: { s2sCallable: true } },
  { path: 'topLevel', body: 'top();' },
];

describe('writeScript / readScriptTree round-trip', () => {
  it('writes nested folders and reads them back by logical path', async () => {
    await writeScriptTree(root, SCRIPTS);
    const read = await readScriptTree(root);
    expect(read.map((s) => s.path)).toEqual(['api/helper', 'topLevel', 'utils/game/saveProgress']);
  });

  it('preserves body and authoritative metadata', async () => {
    await writeScript(root, SCRIPTS[0]!);
    const [read] = await readScriptTree(root);
    expect(read!.body).toBe('main();');
    expect(read!.metadata!.clientCallable).toBe(true);
    expect(read!.metadata!.scriptTimeout).toBe(30);
  });

  it('writes the script at the path mirroring the folder tree', async () => {
    await writeScript(root, SCRIPTS[0]!);
    const onDisk = await fs.readFile(path.join(root, 'utils', 'game', 'saveProgress.ccjs'), 'utf8');
    expect(parseCcjs(onDisk).metadata.folderPath).toBe('utils/game');
  });

  it('omits folderPath for a root-level script', async () => {
    await writeScript(root, SCRIPTS[2]!);
    const onDisk = await fs.readFile(path.join(root, 'topLevel.ccjs'), 'utf8');
    expect(parseCcjs(onDisk).metadata.folderPath).toBeUndefined();
  });
});

describe('readScriptTree', () => {
  it('returns an empty array for a missing root', async () => {
    expect(await readScriptTree(path.join(root, 'does-not-exist'))).toEqual([]);
  });

  it('ignores hidden files and .bcsync state', async () => {
    await writeScript(root, SCRIPTS[2]!);
    await fs.writeFile(path.join(root, '.bcsync'), '{}', 'utf8');
    await fs.writeFile(path.join(root, '.bcsync.local'), '{}', 'utf8');
    await fs.writeFile(path.join(root, '.hidden.ccjs'), 'x();', 'utf8');
    const read = await readScriptTree(root);
    expect(read.map((s) => s.path)).toEqual(['topLevel']);
  });

  it('ignores non-script files', async () => {
    await writeScript(root, SCRIPTS[2]!);
    await fs.writeFile(path.join(root, 'README.md'), '# hi', 'utf8');
    const read = await readScriptTree(root);
    expect(read.map((s) => s.path)).toEqual(['topLevel']);
  });
});

describe('deleteScript', () => {
  it('removes the file and prunes emptied folders', async () => {
    await writeScriptTree(root, SCRIPTS);
    await deleteScript(root, 'utils/game/saveProgress');
    expect(await readScriptTree(root)).toHaveLength(2);
    // utils/ and utils/game/ should be gone
    await expect(fs.access(path.join(root, 'utils'))).rejects.toThrow();
  });

  it('does not prune folders that still hold scripts', async () => {
    await writeScriptTree(root, [
      { path: 'utils/a', body: 'a();' },
      { path: 'utils/b', body: 'b();' },
    ]);
    await deleteScript(root, 'utils/a');
    await fs.access(path.join(root, 'utils')); // still present
    expect((await readScriptTree(root)).map((s) => s.path)).toEqual(['utils/b']);
  });
});
