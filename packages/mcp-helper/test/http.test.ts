import { describe, it, expect, vi } from 'vitest';
import { unzipSync, strToU8 } from 'fflate';
import {
  listRemoteScripts,
  importScriptsZip,
  exportScriptsZip,
  parseRemoteScripts,
  getRemoteScript,
  getScriptVersionContent,
  updateRemoteScript,
  deleteRemoteScript,
  parseScriptObject,
  type SyncTicket,
} from '../src/http';

const TICKET: SyncTicket = {
  baseUrl: 'https://host/builder/v1/team/T/app/A',
  authorization: 'Basic abc123',
  appName: 'MyApp',
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('parseRemoteScripts', () => {
  it('parses the wrapped { response: { scripts: [...] } } shape', () => {
    const parsed = parseRemoteScripts({
      response: {
        scripts: [
          { scriptId: 'id1', scriptName: 'helper', scriptFullPath: 'utils/helper', version: 3 },
          { scriptId: 'id2', scriptName: 'root', version: 1 },
        ],
      },
    });
    expect(parsed).toEqual([
      { scriptId: 'id1', scriptName: 'helper', folderPath: 'utils', path: 'utils/helper', version: 3 },
      { scriptId: 'id2', scriptName: 'root', folderPath: '', path: 'root', version: 1 },
    ]);
  });

  it('skips malformed entries and returns [] when absent', () => {
    expect(parseRemoteScripts({})).toEqual([]);
    expect(parseRemoteScripts({ scripts: [{ scriptName: 'x' }] })).toEqual([]);
  });
});

describe('listRemoteScripts', () => {
  it('GETs the versionOnly listing with the ticket authorization', async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({ scripts: [{ scriptId: 'i', scriptName: 'n', version: 2 }] })
    );
    const result = await listRemoteScripts(TICKET, { fetch });
    expect(fetch).toHaveBeenCalledWith(
      'https://host/builder/v1/team/T/app/A/script?versionOnly=true',
      expect.objectContaining({ method: 'GET', headers: { Authorization: 'Basic abc123' } })
    );
    expect(result[0]!.version).toBe(2);
  });
});

describe('importScriptsZip', () => {
  it('POSTs multipart form with appName, mode and the zip file', async () => {
    let captured: RequestInit | undefined;
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      captured = init;
      return jsonResponse({ importSummary: { scriptsAdded: 1 } });
    });
    const zip = strToU8('zip-bytes');
    const out = await importScriptsZip(TICKET, zip, 'addAndUpdateOnly', { fetch });

    expect(fetch).toHaveBeenCalledWith(
      'https://host/builder/v1/team/T/app/A/scripts',
      expect.objectContaining({ method: 'POST' })
    );
    const form = captured!.body as FormData;
    expect(form.get('appName')).toBe('MyApp');
    expect(form.get('mode')).toBe('addAndUpdateOnly');
    expect(form.get('file')).toBeInstanceOf(Blob);
    expect(out).toEqual({ importSummary: { scriptsAdded: 1 } });
  });
});

describe('exportScriptsZip', () => {
  it('GETs the export and returns the raw bytes', async () => {
    const realZip = (await import('fflate')).zipSync({ 'a.ccjs': strToU8('main();') });
    const fetch = vi.fn(async () => new Response(realZip, { status: 200 }));
    const bytes = await exportScriptsZip(TICKET, { fetch });
    expect(Object.keys(unzipSync(bytes))).toEqual(['a.ccjs']);
  });
});

describe('parseScriptObject', () => {
  it('extracts body/version/scriptName from a wrapped single-script response', () => {
    const parsed = parseScriptObject(
      { response: { script: { scriptId: 'i', scriptName: 'h', scriptFullPath: 'utils/h', version: 4, content: 'main();' } } },
      'script',
      'i'
    );
    expect(parsed).toEqual({ scriptId: 'i', scriptName: 'h', folderPath: 'utils', version: 4, body: 'main();' });
  });

  it('reads an archived version under scriptVersion', () => {
    const parsed = parseScriptObject(
      { response: { scriptVersion: { scriptName: 'h', version: 2, content: 'old();' } } },
      'scriptVersion',
      'i'
    );
    expect(parsed.body).toBe('old();');
    expect(parsed.version).toBe(2);
  });
});

describe('getRemoteScript / getScriptVersionContent', () => {
  it('GETs a single script by id', async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({ response: { script: { scriptId: 'i', scriptName: 'h', version: 5, content: 'x();' } } })
    );
    const r = await getRemoteScript(TICKET, 'i', { fetch });
    expect(fetch).toHaveBeenCalledWith('https://host/builder/v1/team/T/app/A/script/i', expect.anything());
    expect(r.body).toBe('x();');
    expect(r.version).toBe(5);
  });

  it('GETs a specific archived version', async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({ response: { scriptVersion: { scriptName: 'h', version: 3, content: 'base();' } } })
    );
    const r = await getScriptVersionContent(TICKET, 'i', 3, { fetch });
    expect(fetch).toHaveBeenCalledWith('https://host/builder/v1/team/T/app/A/script/i/version/3', expect.anything());
    expect(r.body).toBe('base();');
  });
});

describe('updateRemoteScript / deleteRemoteScript', () => {
  it('PATCHes with version lock, scriptName and content', async () => {
    let init: RequestInit | undefined;
    const fetch = vi.fn(async (_u: string, i?: RequestInit) => { init = i; return jsonResponse({ response: {} }); });
    await updateRemoteScript(TICKET, { scriptId: 'i', version: 5, scriptName: 'h', content: 'merged();' }, { fetch });
    expect(fetch).toHaveBeenCalledWith('https://host/builder/v1/team/T/app/A/script/i', expect.objectContaining({ method: 'PATCH' }));
    expect(JSON.parse(init!.body as string)).toEqual({ version: 5, scriptName: 'h', content: 'merged();' });
  });

  it('DELETEs with a version body', async () => {
    let init: RequestInit | undefined;
    const fetch = vi.fn(async (_u: string, i?: RequestInit) => { init = i; return jsonResponse({ response: {} }); });
    await deleteRemoteScript(TICKET, 'i', 7, { fetch });
    expect(fetch).toHaveBeenCalledWith('https://host/builder/v1/team/T/app/A/script/i', expect.objectContaining({ method: 'DELETE' }));
    expect(JSON.parse(init!.body as string)).toEqual({ version: 7 });
  });
});

describe('ticket expiry', () => {
  it('refuses an expired ticket before making a request', async () => {
    const fetch = vi.fn();
    const expired: SyncTicket = { ...TICKET, expiresAt: '2000-01-01T00:00:00.000Z' };
    await expect(listRemoteScripts(expired, { fetch })).rejects.toThrow(/expired/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('surfaces a non-2xx status as an error', async () => {
    const fetch = vi.fn(async () => new Response('nope', { status: 403 }));
    await expect(listRemoteScripts(TICKET, { fetch })).rejects.toThrow(/403/);
  });
});
