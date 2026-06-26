import {
  buildImportZip,
  classifyScripts,
  computeSyncHash,
  expandExportZip,
  getOrCreateBranchState,
  removeBranchScript,
  upsertBranchScript,
  type BcSyncLocal,
  type ScriptStatus,
  type ZipScript,
} from '@braincloud/cloudsync-core';
import { readScriptTree, writeScript, deleteScript } from './fs-tree.js';
import {
  exportScriptsZip,
  importScriptsZip,
  listRemoteScripts,
  type HttpOptions,
  type RemoteScript,
  type SyncTicket,
} from './http.js';
import { readLocalState, writeLocalState } from './state.js';

export interface SyncOptions extends HttpOptions {
  /** Apply deletions (delete-local on pull). Off by default — deletes always need opt-in. */
  allowDeletes?: boolean;
  /** Override the lastSynced timestamp (for deterministic tests). */
  now?: string;
}

export interface PullResult {
  pulled: string[];
  deleted: string[];
  skipped: ScriptStatus[];
}

export interface PushResult {
  pushed: string[];
  importSummary: unknown;
  skipped: ScriptStatus[];
}

/**
 * Dry-run: classify every script (in-sync / pull / push / conflict / new / delete) without
 * touching disk or brainCloud beyond the cheap version listing. Always safe.
 */
export async function syncStatus(
  rootDir: string,
  ticket: SyncTicket,
  branch: string,
  options: SyncOptions = {}
): Promise<ScriptStatus[]> {
  const local = await localHashes(rootDir);
  const base = (await readLocalState(rootDir))[branch]?.scripts ?? {};
  const remote = remoteVersionMap(await listRemoteScripts(ticket, options));
  return classifyScripts({ local, base, remote });
}

/**
 * Apply remote → local for non-conflicting changes (pull / pull-new, and delete-local when
 * allowDeletes). Conflicts and local-only changes are left untouched and reported in `skipped`.
 */
export async function pull(
  rootDir: string,
  ticket: SyncTicket,
  branch: string,
  options: SyncOptions = {}
): Promise<PullResult> {
  const plan = await syncStatus(rootDir, ticket, branch, options);
  const toPull = new Set(plan.filter((p) => p.action === 'pull' || p.action === 'pull-new').map((p) => p.path));
  const toDelete = new Set(
    options.allowDeletes ? plan.filter((p) => p.action === 'delete-local').map((p) => p.path) : []
  );

  const local = await readLocalState(rootDir);
  const pulled: string[] = [];
  const deleted: string[] = [];

  if (toPull.size > 0) {
    const remoteContent = byPath(expandExportZip(await exportScriptsZip(ticket, options)));
    const remoteMeta = byPathRemote(await listRemoteScripts(ticket, options));
    for (const path of toPull) {
      const script = remoteContent.get(path);
      if (!script) {
        continue; // listed but absent from export — skip rather than write a blank
      }
      await writeScript(rootDir, script);
      upsertBranchScript(local, branch, path, {
        scriptId: remoteMeta.get(path)?.scriptId,
        version: remoteMeta.get(path)?.version ?? versionFromMeta(script),
        sha256: computeSyncHash({ body: script.body, metadata: script.metadata ?? {} }),
      });
      pulled.push(path);
    }
  }

  for (const path of toDelete) {
    await deleteScript(rootDir, path);
    removeBranchScript(local, branch, path);
    deleted.push(path);
  }

  touch(local, branch, options);
  await writeLocalState(rootDir, local);

  const applied = new Set([...pulled, ...deleted]);
  return { pulled, deleted, skipped: plan.filter((p) => !applied.has(p.path)) };
}

/**
 * Apply local → remote for non-conflicting changes (push / push-new) via a single bulk import
 * with mode `addAndUpdateOnly` (which never deletes). Conflicts, remote-only and remote-delete
 * cases are left untouched and reported in `skipped`.
 */
export async function push(
  rootDir: string,
  ticket: SyncTicket,
  branch: string,
  options: SyncOptions = {}
): Promise<PushResult> {
  const plan = await syncStatus(rootDir, ticket, branch, options);
  const toPush = plan.filter((p) => p.action === 'push' || p.action === 'push-new').map((p) => p.path);
  if (toPush.length === 0) {
    return { pushed: [], importSummary: null, skipped: plan };
  }

  const tree = byPath(await readScriptTree(rootDir));
  const zipScripts = toPush.map((path) => tree.get(path)).filter((s): s is ZipScript => Boolean(s));
  const importSummary = await importScriptsZip(ticket, buildImportZip(zipScripts), 'addAndUpdateOnly', options);

  // Versions change after import — re-list to capture the new base.
  const remoteMeta = byPathRemote(await listRemoteScripts(ticket, options));
  const local = await readLocalState(rootDir);
  const pushed: string[] = [];
  for (const path of toPush) {
    const script = tree.get(path);
    const meta = remoteMeta.get(path);
    if (!script || !meta) {
      continue;
    }
    upsertBranchScript(local, branch, path, {
      scriptId: meta.scriptId,
      version: meta.version,
      sha256: computeSyncHash({ body: script.body, metadata: script.metadata ?? {} }),
    });
    pushed.push(path);
  }

  touch(local, branch, options);
  await writeLocalState(rootDir, local);

  const applied = new Set(pushed);
  return { pushed, importSummary, skipped: plan.filter((p) => !applied.has(p.path)) };
}

// --------------------------------------------------------------------------------------------
// internals
// --------------------------------------------------------------------------------------------

async function localHashes(rootDir: string): Promise<Record<string, { hash: string }>> {
  const out: Record<string, { hash: string }> = {};
  for (const script of await readScriptTree(rootDir)) {
    out[script.path] = { hash: computeSyncHash({ body: script.body, metadata: script.metadata ?? {} }) };
  }
  return out;
}

function remoteVersionMap(scripts: RemoteScript[]): Record<string, { version: number }> {
  const out: Record<string, { version: number }> = {};
  for (const script of scripts) {
    out[script.path] = { version: script.version };
  }
  return out;
}

function byPath(scripts: ZipScript[]): Map<string, ZipScript> {
  return new Map(scripts.map((s) => [s.path, s]));
}

function byPathRemote(scripts: RemoteScript[]): Map<string, RemoteScript> {
  return new Map(scripts.map((s) => [s.path, s]));
}

function versionFromMeta(script: ZipScript): number {
  const v = script.metadata?.version;
  return typeof v === 'number' ? v : 0;
}

function touch(local: BcSyncLocal, branch: string, options: SyncOptions): void {
  getOrCreateBranchState(local, branch).lastSynced = options.now ?? new Date().toISOString();
}
