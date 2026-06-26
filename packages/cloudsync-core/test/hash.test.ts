import { describe, it, expect } from 'vitest';
import { buildCcjs, computeSyncHash, parseCcjs, type ScriptMetadata } from '../src/index';

const BODY = `function main() {\n  return 1;\n}\nmain();`;

function hashOf(meta: ScriptMetadata, body = BODY): string {
  return computeSyncHash(parseCcjs(buildCcjs(body, meta)));
}

describe('computeSyncHash', () => {
  it('is stable across a build → parse → build round-trip', () => {
    const meta: ScriptMetadata = { scriptName: 'doThing', clientCallable: true, scriptTimeout: 30 };
    const first = parseCcjs(buildCcjs(BODY, meta));
    const second = parseCcjs(buildCcjs(first.body, first.metadata));
    expect(computeSyncHash(first)).toBe(computeSyncHash(second));
  });

  it('ignores bookkeeping changes (version/updatedAt) — a re-export is not a change', () => {
    const base = hashOf({ scriptName: 'doThing', clientCallable: true, version: 5 });
    const bumped = hashOf({
      scriptName: 'doThing',
      clientCallable: true,
      version: 6,
      updatedAt: 1717459200000,
      author: 'someone',
    });
    expect(bumped).toBe(base);
  });

  it('ignores scriptName (rename) and folderPath (move) — tracked structurally, not by content', () => {
    const base = hashOf({ scriptName: 'doThing', clientCallable: true });
    const renamed = hashOf({ scriptName: 'renamedThing', clientCallable: true });
    const moved = hashOf({ scriptName: 'doThing', clientCallable: true, folderPath: 'elsewhere' });
    expect(renamed).toBe(base);
    expect(moved).toBe(base);
  });

  it('changes when the body changes', () => {
    const a = hashOf({ scriptName: 'doThing' }, BODY);
    const b = hashOf({ scriptName: 'doThing' }, `${BODY}\n// extra`);
    expect(a).not.toBe(b);
  });

  it('changes when an authoritative flag changes', () => {
    const off = hashOf({ scriptName: 'doThing', clientCallable: false });
    const on = hashOf({ scriptName: 'doThing', clientCallable: true });
    expect(off).not.toBe(on);
  });

  it('changes when the timeout changes', () => {
    const t10 = hashOf({ scriptName: 'doThing', scriptTimeout: 10 });
    const t30 = hashOf({ scriptName: 'doThing', scriptTimeout: 30 });
    expect(t10).not.toBe(t30);
  });

  it('is insensitive to CRLF vs LF and trailing whitespace in the body', () => {
    const lf = computeSyncHash({ body: BODY, metadata: { scriptName: 'x' } });
    const crlf = computeSyncHash({ body: `${BODY.replace(/\n/g, '\r\n')}\n\n`, metadata: { scriptName: 'x' } });
    expect(lf).toBe(crlf);
  });
});
