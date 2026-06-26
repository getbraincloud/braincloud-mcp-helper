import { describe, it, expect } from 'vitest';
import {
  META_MARKER,
  buildCcjs,
  parseCcjs,
  CcjsBuildError,
  type ScriptMetadata,
} from '../src/index';

const BODY = `function main() {\n  return { ok: true };\n}\nmain();`;

describe('buildCcjs', () => {
  it('appends a metadata block with the exact server marker', () => {
    const out = buildCcjs(BODY, { scriptName: 'doThing', clientCallable: true });
    expect(out).toContain(META_MARKER);
    expect(out.startsWith(BODY)).toBe(true);
  });

  it('emits scriptName as the first metadata field (server splits on it)', () => {
    const out = buildCcjs(BODY, {
      scriptName: 'doThing',
      description: 'hi',
      clientCallable: true,
    });
    const blockLines = out
      .slice(out.indexOf(META_MARKER) + META_MARKER.length)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    expect(blockLines[0]).toBe('// "scriptName": "doThing",');
  });

  it('the final metadata line has no trailing comma (block parses as JSON)', () => {
    const out = buildCcjs(BODY, { scriptName: 'doThing', clientCallable: true });
    const lines = out.trimEnd().split('\n');
    expect(lines[lines.length - 1]!.endsWith(',')).toBe(false);
  });

  it('uses scriptTimeout (not scriptTimeoutSecs) as the timeout key', () => {
    const out = buildCcjs(BODY, { scriptName: 'doThing', scriptTimeout: 30 });
    expect(out).toContain('// "scriptTimeout": 30');
    expect(out).not.toContain('scriptTimeoutSecs');
  });

  it('orders authoritative fields before bookkeeping, unknown keys last', () => {
    const out = buildCcjs(BODY, {
      scriptName: 'doThing',
      version: 5,
      clientCallable: true,
      zzCustom: 'x',
    } as ScriptMetadata);
    const idxClient = out.indexOf('clientCallable');
    const idxVersion = out.indexOf('version');
    const idxCustom = out.indexOf('zzCustom');
    expect(idxClient).toBeGreaterThan(-1);
    expect(idxClient).toBeLessThan(idxVersion);
    expect(idxVersion).toBeLessThan(idxCustom);
  });

  it('throws without a scriptName', () => {
    expect(() => buildCcjs(BODY, {})).toThrow(CcjsBuildError);
    expect(() => buildCcjs(BODY, { scriptName: '   ' })).toThrow(CcjsBuildError);
  });
});

describe('parseCcjs', () => {
  it('returns content-only body with empty metadata when no block is present', () => {
    const parsed = parseCcjs(BODY);
    expect(parsed.hasMetadataBlock).toBe(false);
    expect(parsed.metadata).toEqual({});
    expect(parsed.body).toBe(BODY);
  });

  it('parses a block built by buildCcjs (round-trip)', () => {
    const meta: ScriptMetadata = {
      scriptName: 'doThing',
      description: 'does a thing',
      clientCallable: true,
      s2sCallable: false,
      peerCallable: false,
      scriptTimeout: 30,
      parms: '{}',
      folderPath: 'utils/game',
    };
    const parsed = parseCcjs(buildCcjs(BODY, meta));
    expect(parsed.hasMetadataBlock).toBe(true);
    expect(parsed.body).toBe(BODY);
    expect(parsed.metadata).toEqual(meta);
  });

  it('parses a server-style block with quoted/escaped description', () => {
    const meta: ScriptMetadata = {
      scriptName: 'doThing',
      description: 'has "quotes" and a , comma',
      clientCallable: true,
    };
    const parsed = parseCcjs(buildCcjs(BODY, meta));
    expect(parsed.metadata.description).toBe('has "quotes" and a , comma');
  });

  it('tolerates a trailing comma on the final block line', () => {
    const file = `${BODY}\n\n${META_MARKER}\n// "scriptName": "doThing",\n// "clientCallable": true,\n`;
    const parsed = parseCcjs(file);
    expect(parsed.metadata.scriptName).toBe('doThing');
    expect(parsed.metadata.clientCallable).toBe(true);
  });

  it('normalises CRLF line endings in the body', () => {
    const crlfFile = `${BODY.replace(/\n/g, '\r\n')}\r\n\r\n${META_MARKER}\r\n// "scriptName": "doThing"\r\n`;
    const parsed = parseCcjs(crlfFile);
    expect(parsed.body).toBe(BODY);
    expect(parsed.metadata.scriptName).toBe('doThing');
  });
});
