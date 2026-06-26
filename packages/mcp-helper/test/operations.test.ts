import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildImportZip, expandExportZip, type ZipScript } from '@braincloud/cloudsync-core';
import { writeScript, readScriptTree } from '../src/fs-tree';
import { readLocalState } from '../src/state';
import { syncStatus, pull, push } from '../src/operations';
import type { FetchLike, SyncTicket } from '../src/http';

const TICKET: SyncTicket = {
  baseUrl: 'https://host/builder/v1/team/T/app/A',
  authorization: 'Basic x',
  appName: 'MyApp',
};
const BRANCH = 'develop';
const NOW = '2026-06-26T00:00:00.000Z';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'bcops-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

interface RemoteEntry {
  scriptId: string;
  version: number;
  body: string;
  metadata?: ZipScript['metadata'];
}

/**
 * Stateful fake Builder API: serves a versionOnly listing and an export zip, and — like the real
 * server — applies bulk imports into the remote map (bumping versions). Lets a script that is new
 * at status time become present after a push.
 */
function fakeBuilder(initial: Record<string, RemoteEntry> = {}) {
  const remote: Record<string, RemoteEntry> = { ...initial };
  const imports: FormData[] = [];

  const fetch: FetchLike = async (url, init) => {
    if (url.includes('/script?versionOnly')) {
      const scripts = Object.entries(remote).map(([p, r]) => {
        const slash = p.lastIndexOf('/');
        return {
          scriptId: r.scriptId,
          scriptName: slash === -1 ? p : p.slice(slash + 1),
          scriptFullPath: p,
          version: r.version,
        };
      });
      return new Response(JSON.stringify({ scripts }), { status: 200 });
    }
    if (url.includes('/script?export')) {
      const zip = buildImportZip(
        Object.entries(remote).map(([p, r]) => ({ path: p, body: r.body, metadata: r.metadata }))
      );
      return new Response(zip, { status: 200 });
    }
    if (url.endsWith('/scripts')) {
      const form = init!.body as FormData;
      imports.push(form);
      const file = form.get('file') as Blob;
      const uploaded = expandExportZip(new Uint8Array(await file.arrayBuffer()));
      for (const s of uploaded) {
        const prev = remote[s.path];
        remote[s.path] = {
          scriptId: prev?.scriptId ?? `srv-${s.path}`,
          version: (prev?.version ?? 0) + 1,
          body: s.body,
          metadata: s.metadata,
        };
      }
      return new Response(JSON.stringify({ importSummary: { ok: true } }), { status: 200 });
    }
    throw new Error(`unexpected url ${url}`);
  };

  return { fetch, imports, remote };
}

describe('syncStatus', () => {
  it('classifies new-local as push-new and new-remote as pull-new', async () => {
    await writeScript(root, { path: 'localOnly', body: 'l();' });
    const { fetch } = fakeBuilder({ remoteOnly: { scriptId: 'r1', version: 1, body: 'r();' } });
    const actions = Object.fromEntries(
      (await syncStatus(root, TICKET, BRANCH, { fetch })).map((p) => [p.path, p.action])
    );
    expect(actions.localOnly).toBe('push-new');
    expect(actions.remoteOnly).toBe('pull-new');
  });
});

describe('pull', () => {
  it('writes new remote scripts and records base state', async () => {
    const { fetch } = fakeBuilder({
      'utils/helper': { scriptId: 'r1', version: 4, body: 'help();', metadata: { clientCallable: true } },
    });
    const result = await pull(root, TICKET, BRANCH, { fetch, now: NOW });

    expect(result.pulled).toEqual(['utils/helper']);
    const onDisk = await readScriptTree(root);
    expect(onDisk.map((s) => s.path)).toEqual(['utils/helper']);
    expect(onDisk[0]!.metadata!.clientCallable).toBe(true);

    const state = await readLocalState(root);
    expect(state[BRANCH]!.scripts['utils/helper']).toEqual({
      scriptId: 'r1',
      version: 4,
      sha256: expect.any(String),
    });
    expect(state[BRANCH]!.scriptVersions['utils/helper']).toBe(4);
    expect(state[BRANCH]!.lastSynced).toBe(NOW);
  });

  it('only deletes local scripts when allowDeletes is set', async () => {
    // First pull creates the file + base from remote.
    await pull(root, TICKET, BRANCH, {
      fetch: fakeBuilder({ gone: { scriptId: 'g', version: 1, body: 'x();' } }).fetch,
      now: NOW,
    });
    expect((await readScriptTree(root)).map((s) => s.path)).toEqual(['gone']);

    // Remote no longer has it → delete-local, but gated off by default.
    const guarded = await pull(root, TICKET, BRANCH, { fetch: fakeBuilder({}).fetch, now: NOW });
    expect(guarded.deleted).toEqual([]);
    expect((await readScriptTree(root)).map((s) => s.path)).toEqual(['gone']);

    // With allowDeletes, it is removed and the base record cleared.
    const allowed = await pull(root, TICKET, BRANCH, { fetch: fakeBuilder({}).fetch, now: NOW, allowDeletes: true });
    expect(allowed.deleted).toEqual(['gone']);
    expect(await readScriptTree(root)).toEqual([]);
    expect((await readLocalState(root))[BRANCH]!.scripts.gone).toBeUndefined();
  });
});

describe('push', () => {
  it('uploads a new local script via one import and records the refreshed version', async () => {
    await writeScript(root, { path: 'api/new', body: 'create();', metadata: { s2sCallable: true } });
    const builder = fakeBuilder();
    const result = await push(root, TICKET, BRANCH, { fetch: builder.fetch, now: NOW });

    expect(result.pushed).toEqual(['api/new']);
    expect(builder.imports).toHaveLength(1);
    expect(builder.imports[0]!.get('mode')).toBe('addAndUpdateOnly');

    const state = await readLocalState(root);
    expect(state[BRANCH]!.scripts['api/new']!.version).toBe(1);
    expect(state[BRANCH]!.scripts['api/new']!.scriptId).toBe('srv-api/new');
  });

  it('does not re-push an unchanged, already-synced script', async () => {
    // Push once to establish base, then push again with no local change.
    await writeScript(root, { path: 'stable', body: 'main();' });
    const builder = fakeBuilder();
    await push(root, TICKET, BRANCH, { fetch: builder.fetch, now: NOW });
    const second = await push(root, TICKET, BRANCH, { fetch: builder.fetch, now: NOW });

    expect(second.pushed).toEqual([]);
    expect(builder.imports).toHaveLength(1); // only the first push uploaded
  });
});
