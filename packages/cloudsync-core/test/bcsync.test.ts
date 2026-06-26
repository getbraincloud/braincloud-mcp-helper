import { describe, it, expect } from 'vitest';
import {
  parseBcSync,
  serializeBcSync,
  resolveBranchApp,
  parseBcSyncLocal,
  serializeBcSyncLocal,
  upsertBranchScript,
  removeBranchScript,
  getOrCreateBranchState,
  BcSyncParseError,
  type BcSyncLocal,
} from '../src/index';

const BCSYNC = JSON.stringify({
  gitRemote: 'git@bitbucket.org:org/repo.git',
  relativeFolder: '/CloudScripts',
  branchMappings: {
    main: { appId: '15656', appName: 'ProjectAlpha (Prod)' },
    develop: { appId: '15655', appName: 'ProjectAlpha (Dev)' },
  },
});

describe('parseBcSync', () => {
  it('parses branch mappings', () => {
    const cfg = parseBcSync(BCSYNC);
    expect(cfg.branchMappings.main!.appId).toBe('15656');
    expect(cfg.branchMappings.develop!.appName).toBe('ProjectAlpha (Dev)');
    expect(cfg.gitRemote).toBe('git@bitbucket.org:org/repo.git');
  });

  it('defaults branchMappings to {} when absent', () => {
    const cfg = parseBcSync(JSON.stringify({ gitRemote: 'x' }));
    expect(cfg.branchMappings).toEqual({});
  });

  it('preserves unknown top-level fields on round-trip', () => {
    const cfg = parseBcSync(JSON.stringify({ branchMappings: {}, futureField: 42 }));
    expect((cfg as Record<string, unknown>).futureField).toBe(42);
    expect(parseBcSync(serializeBcSync(cfg)).branchMappings).toEqual({});
  });

  it('throws on invalid JSON', () => {
    expect(() => parseBcSync('{ not json')).toThrow(BcSyncParseError);
  });

  it('throws when a mapping has no appId (never guess a target app)', () => {
    expect(() =>
      parseBcSync(JSON.stringify({ branchMappings: { main: { appName: 'X' } } }))
    ).toThrow(BcSyncParseError);
  });

  it('serializes with two-space indent and a trailing newline', () => {
    const out = serializeBcSync(parseBcSync(BCSYNC));
    expect(out.endsWith('}\n')).toBe(true);
    expect(out).toContain('\n  "branchMappings"');
  });
});

describe('resolveBranchApp', () => {
  it('returns the mapping for a known branch and undefined for an unknown one', () => {
    const cfg = parseBcSync(BCSYNC);
    expect(resolveBranchApp(cfg, 'main')!.appId).toBe('15656');
    expect(resolveBranchApp(cfg, 'feature/x')).toBeUndefined();
  });
});

describe('.bcsync.local', () => {
  it('parses the VS Code shape and preserves scriptVersions', () => {
    const local = parseBcSyncLocal(
      JSON.stringify({
        main: {
          lastSynced: '2026-06-03T15:30:00.000Z',
          scriptVersions: { 'folder/add/AddTwoNumbers': 5 },
        },
      })
    );
    expect(local.main!.scriptVersions['folder/add/AddTwoNumbers']).toBe(5);
    expect(local.main!.scripts).toEqual({});
    expect(local.main!.lastSynced).toBe('2026-06-03T15:30:00.000Z');
  });

  it('parses the richer scripts map', () => {
    const local = parseBcSyncLocal(
      JSON.stringify({
        main: {
          scripts: { 'a/b': { scriptId: 'id1', version: 5, sha256: '9f86d0' } },
        },
      })
    );
    expect(local.main!.scripts['a/b']).toEqual({ scriptId: 'id1', version: 5, sha256: '9f86d0' });
  });

  it('preserves unknown per-branch fields VS Code may add', () => {
    const local = parseBcSyncLocal(
      JSON.stringify({ main: { scriptVersions: {}, futureFlag: true } })
    );
    expect((local.main as Record<string, unknown>).futureFlag).toBe(true);
  });

  it('drops malformed script records', () => {
    const local = parseBcSyncLocal(
      JSON.stringify({ main: { scripts: { good: { version: 1, sha256: 'x' }, bad: { version: 1 } } } })
    );
    expect(Object.keys(local.main!.scripts)).toEqual(['good']);
  });
});

describe('upsertBranchScript / removeBranchScript', () => {
  it('keeps scripts and scriptVersions consistent on upsert', () => {
    const local: BcSyncLocal = {};
    upsertBranchScript(local, 'main', 'a/b', { scriptId: 'id1', version: 7, sha256: 'h' });
    expect(local.main!.scripts['a/b']!.version).toBe(7);
    expect(local.main!.scriptVersions['a/b']).toBe(7);
  });

  it('removes from both maps', () => {
    const local: BcSyncLocal = {};
    upsertBranchScript(local, 'main', 'a/b', { version: 1, sha256: 'h' });
    removeBranchScript(local, 'main', 'a/b');
    expect(local.main!.scripts['a/b']).toBeUndefined();
    expect(local.main!.scriptVersions['a/b']).toBeUndefined();
  });

  it('round-trips through serialize/parse', () => {
    const local: BcSyncLocal = {};
    upsertBranchScript(local, 'develop', 'x/y', { scriptId: 'id', version: 3, sha256: 'abc' });
    getOrCreateBranchState(local, 'develop').lastSynced = '2026-06-26T00:00:00.000Z';
    const reparsed = parseBcSyncLocal(serializeBcSyncLocal(local));
    expect(reparsed).toEqual(local);
  });
});
