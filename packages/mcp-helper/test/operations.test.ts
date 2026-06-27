import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildImportZip, expandExportZip, type ZipScript } from '@braincloud/cloudsync-core';
import { writeScript, readScriptTree, deleteScript } from '../src/fs-tree';
import { readLocalState } from '../src/state';
import { syncStatus, pull, push, sync } from '../src/operations';
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

  // Archived versions keyed by `${scriptId}@${version}` — populated whenever a live version is
  // superseded or deleted, mirroring brainCloud's serverScriptArchive.
  const archive: Record<string, { body: string; scriptName: string; version: number }> = {};
  const nameOf = (p: string) => (p.lastIndexOf('/') === -1 ? p : p.slice(p.lastIndexOf('/') + 1));
  const findByScriptId = (id: string) =>
    Object.entries(remote).find(([, r]) => r.scriptId === id);
  const archiveCurrent = (path: string) => {
    const cur = remote[path];
    if (cur) archive[`${cur.scriptId}@${cur.version}`] = { body: cur.body, scriptName: nameOf(path), version: cur.version };
  };

  const scriptJson = (path: string) => {
    const r = remote[path]!;
    return { scriptId: r.scriptId, scriptName: nameOf(path), scriptFullPath: path, version: r.version, content: r.body };
  };

  const fetch: FetchLike = async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url.includes('/script?versionOnly')) {
      const scripts = Object.entries(remote).map(([p, r]) => ({
        scriptId: r.scriptId, scriptName: nameOf(p), scriptFullPath: p, version: r.version,
      }));
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
      const uploaded = expandExportZip(new Uint8Array(await (form.get('file') as Blob).arrayBuffer()));
      for (const s of uploaded) {
        archiveCurrent(s.path);
        const prev = remote[s.path];
        remote[s.path] = { scriptId: prev?.scriptId ?? `srv-${s.path}`, version: (prev?.version ?? 0) + 1, body: s.body, metadata: s.metadata };
      }
      return new Response(JSON.stringify({ importSummary: { ok: true } }), { status: 200 });
    }

    const versionMatch = url.match(/\/script\/([^/?]+)\/version\/(\d+)/);
    if (versionMatch) {
      const arc = archive[`${versionMatch[1]}@${versionMatch[2]}`];
      if (!arc) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify({ response: { scriptVersion: { scriptName: arc.scriptName, version: arc.version, content: arc.body } } }), { status: 200 });
    }

    const idMatch = url.match(/\/script\/([^/?]+)$/);
    if (idMatch) {
      const found = findByScriptId(idMatch[1]!);
      if (method === 'GET') {
        if (!found) return new Response('not found', { status: 404 });
        return new Response(JSON.stringify({ response: { script: scriptJson(found[0]) } }), { status: 200 });
      }
      if (method === 'PATCH') {
        const [path] = found!;
        const body = JSON.parse(init!.body as string) as { content: string };
        archiveCurrent(path);
        remote[path] = { ...remote[path]!, version: remote[path]!.version + 1, body: body.content };
        return new Response(JSON.stringify({ response: { script: scriptJson(path) } }), { status: 200 });
      }
      if (method === 'DELETE') {
        const [path] = found!;
        archiveCurrent(path);
        delete remote[path];
        return new Response(JSON.stringify({ response: { ok: true } }), { status: 200 });
      }
    }
    throw new Error(`unexpected ${method} ${url}`);
  };

  /** Simulate another developer editing a remote script: archive the current version, bump, replace. */
  const editRemote = (path: string, newBody: string) => {
    archiveCurrent(path);
    remote[path] = { ...remote[path]!, version: remote[path]!.version + 1, body: newBody };
  };

  return { fetch, imports, remote, editRemote };
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

describe('sync', () => {
  const bodyOf = async (path: string) =>
    (await readScriptTree(root)).find((s) => s.path === path)?.body;

  it('auto-merges non-overlapping changes on both sides', async () => {
    const b = fakeBuilder({ svc: { scriptId: 's1', version: 1, body: 'a\nb\nc' } });
    await pull(root, TICKET, BRANCH, { fetch: b.fetch, now: NOW });
    b.editRemote('svc', 'a\nb\nC');                       // remote changes line 3 -> v2
    await writeScript(root, { path: 'svc', body: 'A\nb\nc' }); // local changes line 1

    const r = await sync(root, TICKET, BRANCH, { fetch: b.fetch, now: NOW });

    expect(r.merged).toEqual(['svc']);
    expect(r.conflicted).toEqual([]);
    expect(await bodyOf('svc')).toBe('A\nb\nC');
    expect(b.remote.svc!.body).toBe('A\nb\nC'); // pushed merged result
    // settled: a follow-up status is clean
    const after = await syncStatus(root, TICKET, BRANCH, { fetch: b.fetch });
    expect(after.find((p) => p.path === 'svc')!.action).toBe('in-sync');
  });

  it('writes conflict markers and does not push on overlapping changes', async () => {
    const b = fakeBuilder({ svc: { scriptId: 's1', version: 1, body: 'x\ny\nz' } });
    await pull(root, TICKET, BRANCH, { fetch: b.fetch, now: NOW });
    b.editRemote('svc', 'x\nREMOTE\nz');
    await writeScript(root, { path: 'svc', body: 'x\nLOCAL\nz' });

    const r = await sync(root, TICKET, BRANCH, { fetch: b.fetch, now: NOW });

    expect(r.conflicted).toEqual(['svc']);
    expect(r.merged).toEqual([]);
    expect(await bodyOf('svc')).toContain('<<<<<<< local');
    expect(b.remote.svc!.body).toBe('x\nREMOTE\nz'); // remote untouched
    expect(b.remote.svc!.version).toBe(2);
  });

  it('treats identical both-side changes as converged (no push)', async () => {
    const b = fakeBuilder({ svc: { scriptId: 's1', version: 1, body: 'p' } });
    await pull(root, TICKET, BRANCH, { fetch: b.fetch, now: NOW });
    b.editRemote('svc', 'p2');
    await writeScript(root, { path: 'svc', body: 'p2' });

    const r = await sync(root, TICKET, BRANCH, { fetch: b.fetch, now: NOW });

    expect(r.converged).toEqual(['svc']);
    expect(r.merged).toEqual([]);
    expect(b.remote.svc!.version).toBe(2); // not pushed
    const after = await syncStatus(root, TICKET, BRANCH, { fetch: b.fetch });
    expect(after.find((p) => p.path === 'svc')!.action).toBe('in-sync');
  });

  it('deletes remote scripts only with allowDeletes', async () => {
    const b = fakeBuilder({ gone: { scriptId: 'g1', version: 1, body: 'd' } });
    await pull(root, TICKET, BRANCH, { fetch: b.fetch, now: NOW });
    await deleteScript(root, 'gone'); // local delete

    const guarded = await sync(root, TICKET, BRANCH, { fetch: b.fetch, now: NOW });
    expect(guarded.deletedRemote).toEqual([]);
    expect(b.remote.gone).toBeDefined();

    const allowed = await sync(root, TICKET, BRANCH, { fetch: b.fetch, now: NOW, allowDeletes: true });
    expect(allowed.deletedRemote).toEqual(['gone']);
    expect(b.remote.gone).toBeUndefined();
  });

  it('handles pull, push and in-sync together in one pass', async () => {
    const b = fakeBuilder({ both: { scriptId: 'b1', version: 1, body: 'same' } });
    await pull(root, TICKET, BRANCH, { fetch: b.fetch, now: NOW });      // 'both' now in sync
    b.remote.remoteOnly = { scriptId: 'r1', version: 1, body: 'r()' };   // appears remotely
    await writeScript(root, { path: 'localOnly', body: 'l()' });          // appears locally

    const r = await sync(root, TICKET, BRANCH, { fetch: b.fetch, now: NOW });

    expect(r.pulled).toEqual(['remoteOnly']);
    expect(r.pushed).toEqual(['localOnly']);
    expect(r.inSync).toContain('both');
    expect(b.remote.localOnly).toBeDefined(); // pushed to remote
  });
});
