import { describe, it, expect } from 'vitest';
import { classifyScript, classifyScripts, type ScriptComparison } from '../src/index';

const action = (cmp: ScriptComparison) => classifyScript(cmp).action;

describe('classifyScript — no base (never synced)', () => {
  it('local only → push-new', () => {
    expect(action({ path: 'a', local: { hash: 'h' } })).toBe('push-new');
  });
  it('remote only → pull-new', () => {
    expect(action({ path: 'a', remote: { version: 1 } })).toBe('pull-new');
  });
  it('both, identical content → converged', () => {
    expect(action({ path: 'a', local: { hash: 'h' }, remote: { version: 1, hash: 'h' } })).toBe('converged');
  });
  it('both, differing content → conflict', () => {
    expect(action({ path: 'a', local: { hash: 'h1' }, remote: { version: 1, hash: 'h2' } })).toBe('conflict');
  });
  it('both, remote hash unknown → conflict', () => {
    expect(action({ path: 'a', local: { hash: 'h' }, remote: { version: 1 } })).toBe('conflict');
  });
  it('neither → in-sync', () => {
    expect(action({ path: 'a' })).toBe('in-sync');
  });
});

describe('classifyScript — with base, both present', () => {
  const base = { version: 5, sha256: 'base' };
  it('unchanged both → in-sync', () => {
    expect(action({ path: 'a', base, local: { hash: 'base' }, remote: { version: 5 } })).toBe('in-sync');
  });
  it('remote changed, local unchanged → pull', () => {
    expect(action({ path: 'a', base, local: { hash: 'base' }, remote: { version: 6 } })).toBe('pull');
  });
  it('local changed, remote unchanged → push', () => {
    expect(action({ path: 'a', base, local: { hash: 'new' }, remote: { version: 5 } })).toBe('push');
  });
  it('both changed, identical → converged', () => {
    expect(action({ path: 'a', base, local: { hash: 'same' }, remote: { version: 6, hash: 'same' } })).toBe('converged');
  });
  it('both changed, differ → conflict', () => {
    expect(action({ path: 'a', base, local: { hash: 'mine' }, remote: { version: 6, hash: 'theirs' } })).toBe('conflict');
  });
  it('both changed, remote hash unknown → conflict (conservative)', () => {
    expect(action({ path: 'a', base, local: { hash: 'mine' }, remote: { version: 6 } })).toBe('conflict');
  });
});

describe('classifyScript — with base, deletions', () => {
  const base = { version: 5, sha256: 'base' };
  it('remote deleted, local unchanged → delete-local', () => {
    expect(action({ path: 'a', base, local: { hash: 'base' } })).toBe('delete-local');
  });
  it('remote deleted, local changed → conflict', () => {
    expect(action({ path: 'a', base, local: { hash: 'new' } })).toBe('conflict');
  });
  it('local deleted, remote unchanged → delete-remote', () => {
    expect(action({ path: 'a', base, remote: { version: 5 } })).toBe('delete-remote');
  });
  it('local deleted, remote changed → conflict', () => {
    expect(action({ path: 'a', base, remote: { version: 6 } })).toBe('conflict');
  });
  it('both deleted → in-sync (clear stale base)', () => {
    expect(action({ path: 'a', base })).toBe('in-sync');
  });
});

describe('classifyScripts — set diff', () => {
  it('classifies the union of paths in sorted order', () => {
    const result = classifyScripts({
      local: { b: { hash: 'x' }, c: { hash: 'base' } },
      base: { c: { version: 1, sha256: 'base' }, d: { version: 2, sha256: 'base' } },
      remote: { c: { version: 1 }, d: { version: 2 } },
    });
    expect(result.map((r) => r.path)).toEqual(['b', 'c', 'd']);
    expect(result.find((r) => r.path === 'b')!.action).toBe('push-new'); // local only, no base
    expect(result.find((r) => r.path === 'c')!.action).toBe('in-sync'); // unchanged
    expect(result.find((r) => r.path === 'd')!.action).toBe('delete-remote'); // local gone, remote unchanged
  });
});
