import { describe, it, expect } from 'vitest';
import { zipSync, strToU8, strFromU8, unzipSync } from 'fflate';
import {
  buildImportZip,
  expandExportZip,
  parseCcjs,
  META_MARKER,
  type ZipScript,
} from '../src/index';

const SCRIPTS: ZipScript[] = [
  { path: 'utils/game/saveProgress', body: 'main();', metadata: { clientCallable: true, scriptTimeout: 30 } },
  { path: 'api/helper', body: 'main();', metadata: { s2sCallable: true } },
  { path: 'helper', body: 'main();' }, // same bare name as api/helper, but at root
];

describe('buildImportZip', () => {
  it('names entries by full path so same-named scripts in different folders do not collide', () => {
    const entries = unzipSync(buildImportZip(SCRIPTS));
    expect(Object.keys(entries).sort()).toEqual([
      'api/helper.ccjs',
      'helper.ccjs',
      'utils/game/saveProgress.ccjs',
    ]);
  });

  it('writes folderPath into each block (server places by folderPath, not entry path)', () => {
    const entries = unzipSync(buildImportZip(SCRIPTS));
    const saved = parseCcjs(strFromU8(entries['utils/game/saveProgress.ccjs']!));
    expect(saved.metadata.folderPath).toBe('utils/game');
    expect(saved.metadata.scriptName).toBe('saveProgress');
  });

  it('omits folderPath for a root script', () => {
    const entries = unzipSync(buildImportZip(SCRIPTS));
    const root = parseCcjs(strFromU8(entries['helper.ccjs']!));
    expect(root.metadata.folderPath).toBeUndefined();
    expect(root.metadata.scriptName).toBe('helper');
  });

  it('lowercases folder names but preserves script-name case', () => {
    const entries = unzipSync(buildImportZip([{ path: 'Utils/Game/SaveProgress', body: 'x();' }]));
    const name = Object.keys(entries)[0]!;
    expect(name).toBe('utils/game/SaveProgress.ccjs');
  });

  it('every entry carries the metadata marker', () => {
    const entries = unzipSync(buildImportZip(SCRIPTS));
    for (const bytes of Object.values(entries)) {
      expect(strFromU8(bytes)).toContain(META_MARKER);
    }
  });
});

describe('expandExportZip', () => {
  it('round-trips build → expand (sorted by path)', () => {
    const expanded = expandExportZip(buildImportZip(SCRIPTS));
    expect(expanded.map((s) => s.path)).toEqual(['api/helper', 'helper', 'utils/game/saveProgress']);
    const save = expanded.find((s) => s.path === 'utils/game/saveProgress')!;
    expect(save.body).toBe('main();');
    expect(save.metadata!.clientCallable).toBe(true);
    expect(save.metadata!.scriptTimeout).toBe(30);
  });

  it('derives the path from the entry when a content-only file has no block', () => {
    const zip = zipSync({ 'foo/bar/baz.ccjs': strToU8('main();') });
    const [script] = expandExportZip(zip);
    expect(script!.path).toBe('foo/bar/baz');
    expect(script!.body).toBe('main();');
  });

  it('prefers the block folderPath/scriptName over the entry path', () => {
    // Entry path says one thing; block says another — block wins (it drives server placement).
    const zip = zipSync({
      'wrong/place.ccjs': strToU8(
        `main();\n\n${META_MARKER}\n// "scriptName": "realName",\n// "folderPath": "right/spot"\n`
      ),
    });
    const [script] = expandExportZip(zip);
    expect(script!.path).toBe('right/spot/realName');
  });

  it('skips directories, hidden files and non-script entries', () => {
    const zip = zipSync({
      'dir/': strToU8(''),
      '.DS_Store': strToU8('junk'),
      'readme.txt': strToU8('not a script'),
      'good.ccjs': strToU8('main();'),
    });
    const expanded = expandExportZip(zip);
    expect(expanded.map((s) => s.path)).toEqual(['good']);
  });

  it('accepts .js and .cloudcode.js extensions', () => {
    const zip = zipSync({
      'a.js': strToU8('main();'),
      'b.cloudcode.js': strToU8('main();'),
    });
    expect(expandExportZip(zip).map((s) => s.path).sort()).toEqual(['a', 'b']);
  });
});
