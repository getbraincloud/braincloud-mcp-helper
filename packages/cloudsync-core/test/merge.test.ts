import { describe, it, expect } from 'vitest';
import { merge3 } from '../src/index';

const BASE = 'line1\nline2\nline3';

describe('merge3', () => {
  it('merges non-overlapping edits cleanly', () => {
    const local = 'LINE1\nline2\nline3'; // changed line1
    const remote = 'line1\nline2\nLINE3'; // changed line3
    const r = merge3(local, BASE, remote);
    expect(r.conflict).toBe(false);
    expect(r.merged).toBe('LINE1\nline2\nLINE3');
  });

  it('collapses identical edits on both sides (no false conflict)', () => {
    const same = 'line1\nCHANGED\nline3';
    const r = merge3(same, BASE, same);
    expect(r.conflict).toBe(false);
    expect(r.merged).toBe(same);
  });

  it('takes the changed side when only one side changed', () => {
    const local = 'line1\nlocalChange\nline3';
    const r = merge3(local, BASE, BASE);
    expect(r.conflict).toBe(false);
    expect(r.merged).toBe(local);
  });

  it('produces git-style conflict markers on overlapping edits', () => {
    const local = 'line1\nMINE\nline3';
    const remote = 'line1\nTHEIRS\nline3';
    const r = merge3(local, BASE, remote, { local: 'local', remote: 'brainCloud v6' });
    expect(r.conflict).toBe(true);
    expect(r.merged).toContain('<<<<<<< local');
    expect(r.merged).toContain('MINE');
    expect(r.merged).toContain('=======');
    expect(r.merged).toContain('THEIRS');
    expect(r.merged).toContain('>>>>>>> brainCloud v6');
  });

  it('is a no-op when nothing changed', () => {
    const r = merge3(BASE, BASE, BASE);
    expect(r.conflict).toBe(false);
    expect(r.merged).toBe(BASE);
  });

  it('ignores CRLF vs LF differences', () => {
    const r = merge3(BASE.replace(/\n/g, '\r\n'), BASE, BASE);
    expect(r.conflict).toBe(false);
    expect(r.merged).toBe(BASE);
  });
});
