import {
  buildImportZip,
  classifyScripts,
  computeSyncHash,
  expandExportZip,
  getOrCreateBranchState,
  merge3,
  removeBranchScript,
  upsertBranchScript,
  type BcSyncLocal,
  type ScriptStatus,
  type ZipScript,
} from '@braincloud/cloudsync-core';
import { readScriptTree, writeScript, deleteScript } from './fs-tree.js';
import {
  appIdFromBaseUrl,
  deleteRemoteScript,
  exportScriptsZip,
  getScriptVersionContent,
  importScriptsZip,
  listRemoteScripts,
  updateRemoteScript,
  type HttpOptions,
  type RemoteScript,
  type SyncTicket,
} from './http.js';
import {
  ensureGitignore,
  readConfig,
  readLocalState,
  writeConfig,
  writeLocalState,
  NO_GIT_BRANCH,
} from './state.js';

export interface SyncOptions extends HttpOptions {
  /** Apply deletions (delete-local on pull). Off by default — deletes always need opt-in. */
  allowDeletes?: boolean;
  /** Override the lastSynced timestamp (for deterministic tests). */
  now?: string;
  /**
   * Confirms the target app for a previously-synced folder that has no committed `.bcsync`
   * mapping to verify against (e.g. one synced by a pre-mapping helper). Must equal the ticket's
   * appName to proceed; otherwise the op refuses rather than risk syncing the wrong app.
   */
  confirmAppName?: string;
  /**
   * Confirms moving the no-git (`""`) sync state and app mapping onto the current git branch
   * (and dropping the `""` entry). Required when a folder was first synced without git and a real
   * branch has since appeared; without it the op refuses rather than orphan the prior state.
   */
  adoptNoGitBranch?: boolean;
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
  await maybeMigrateNoGit(rootDir, branch, options);
  await assertAppGuard(rootDir, branch, ticket, options);
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
  await recordBranchMapping(rootDir, branch, ticket);
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
  await recordBranchMapping(rootDir, branch, ticket);
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

export interface SyncResult {
  /** Remote → local (new or changed remote scripts written). */
  pulled: string[];
  /** Local → remote (new or changed local scripts uploaded, via one bulk import). */
  pushed: string[];
  /** Both sides changed and were auto-merged cleanly (written locally + pushed). */
  merged: string[];
  /** Both sides reached identical content independently; base updated, nothing transferred. */
  converged: string[];
  /** Unresolved conflicts — a conflict-marked file was written locally for the developer. */
  conflicted: string[];
  deletedLocal: string[];
  deletedRemote: string[];
  inSync: string[];
  /** The bulk-import summary, if any push/push-new scripts were uploaded. */
  importSummary: unknown;
}

/**
 * Full two-way sync for a branch: pulls non-conflicting remote changes, pushes non-conflicting
 * local changes, and 3-way-merges scripts changed on both sides. Cleanly-merged scripts are written
 * locally and pushed (version-locked); genuine conflicts are written with git-style markers and left
 * for the developer. Deletions are applied only when allowDeletes is set. Base state is settled from
 * a final remote listing so the next status is clean.
 */
export async function sync(
  rootDir: string,
  ticket: SyncTicket,
  branch: string,
  options: SyncOptions = {}
): Promise<SyncResult> {
  const plan = await syncStatus(rootDir, ticket, branch, options);
  await recordBranchMapping(rootDir, branch, ticket);
  const remoteMeta = byPathRemote(await listRemoteScripts(ticket, options));
  const localTree = byPath(await readScriptTree(rootDir));
  const local = await readLocalState(rootDir);
  const baseScripts = local[branch]?.scripts ?? {};

  // Remote bodies are only needed for pulls and conflict merges — fetch the export zip once.
  const needsRemoteBodies = plan.some((p) =>
    p.action === 'pull' || p.action === 'pull-new' || p.action === 'conflict'
  );
  const remoteBodies = needsRemoteBodies
    ? byPath(expandExportZip(await exportScriptsZip(ticket, options)))
    : new Map<string, ZipScript>();

  const result: SyncResult = {
    pulled: [], pushed: [], merged: [], converged: [], conflicted: [],
    deletedLocal: [], deletedRemote: [], inSync: [], importSummary: null,
  };
  const pushPaths: string[] = [];
  const settled = new Set<string>(); // paths whose base should be refreshed at the end

  for (const status of plan) {
    const path = status.path;
    switch (status.action) {
      case 'in-sync':
        result.inSync.push(path);
        break;

      case 'pull':
      case 'pull-new': {
        const rs = remoteBodies.get(path);
        if (rs) {
          await writeScript(rootDir, rs);
          result.pulled.push(path);
          settled.add(path);
        }
        break;
      }

      case 'push':
      case 'push-new':
        pushPaths.push(path); // applied together in one bulk import below
        break;

      case 'delete-local':
        if (options.allowDeletes) {
          await deleteScript(rootDir, path);
          removeBranchScript(local, branch, path);
          result.deletedLocal.push(path);
        }
        break;

      case 'delete-remote':
        if (options.allowDeletes) {
          const meta = remoteMeta.get(path);
          if (meta) {
            await deleteRemoteScript(ticket, meta.scriptId, meta.version, options);
            removeBranchScript(local, branch, path);
            result.deletedRemote.push(path);
          }
        }
        break;

      case 'conflict': {
        const localS = localTree.get(path);
        const remoteS = remoteBodies.get(path);
        const meta = remoteMeta.get(path);
        const baseRec = baseScripts[path];
        // delete/modify conflict (one side gone) — can't auto-merge; leave for the developer.
        if (!localS || !remoteS || !meta || !baseRec) {
          result.conflicted.push(path);
          break;
        }
        // Both sides changed to the same content → converged; settle base only.
        if (normalizeBody(localS.body) === normalizeBody(remoteS.body)) {
          result.converged.push(path);
          settled.add(path);
          break;
        }
        const baseContent = await getScriptVersionContent(
          ticket, baseRec.scriptId ?? meta.scriptId, baseRec.version, options
        );
        const m = merge3(localS.body, baseContent.body, remoteS.body, {
          local: 'local',
          remote: `brainCloud v${meta.version}`,
        });
        if (m.conflict) {
          // Write the conflict-marked file; do not push or settle — the developer resolves it.
          await writeScript(rootDir, { path, body: m.merged, metadata: localS.metadata });
          result.conflicted.push(path);
        } else {
          // Clean auto-merge: write locally and push version-locked to the remote we merged against.
          await writeScript(rootDir, { path, body: m.merged, metadata: localS.metadata });
          await updateRemoteScript(ticket, {
            scriptId: meta.scriptId, version: meta.version, scriptName: meta.scriptName, content: m.merged,
          }, options);
          result.merged.push(path);
          settled.add(path);
        }
        break;
      }

      default:
        break;
    }
  }

  // One bulk import for all plain pushes (addAndUpdateOnly never deletes).
  if (pushPaths.length > 0) {
    const zipScripts = pushPaths.map((p) => localTree.get(p)).filter((s): s is ZipScript => Boolean(s));
    result.importSummary = await importScriptsZip(ticket, buildImportZip(zipScripts), 'addAndUpdateOnly', options);
    result.pushed = pushPaths;
    pushPaths.forEach((p) => settled.add(p));
  }

  // Settle base for everything now in sync, from a fresh remote listing + on-disk content.
  if (settled.size > 0) {
    const freshRemote = byPathRemote(await listRemoteScripts(ticket, options));
    const freshTree = byPath(await readScriptTree(rootDir));
    for (const path of settled) {
      const meta = freshRemote.get(path);
      const localS = freshTree.get(path);
      if (meta && localS) {
        upsertBranchScript(local, branch, path, {
          scriptId: meta.scriptId,
          version: meta.version,
          sha256: computeSyncHash({ body: localS.body, metadata: localS.metadata ?? {} }),
        });
      }
    }
  }

  touch(local, branch, options);
  await writeLocalState(rootDir, local);
  return result;
}

// --------------------------------------------------------------------------------------------
// internals
// --------------------------------------------------------------------------------------------

function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, '\n').replace(/\s+$/, '');
}

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

/**
 * Guard run before every op: ensure the ticket's app is the right one for this folder/branch.
 *
 *  - Committed `.bcsync` maps the branch to a *different* app than the ticket → refuse (the stray-
 *    ticket guard).
 *  - Committed `.bcsync` maps the branch to the ticket's app → verified, proceed.
 *  - No committed mapping but the folder has local sync history for the branch (e.g. synced by a
 *    pre-mapping helper) → the app cannot be verified, so refuse UNTIL the caller confirms it by
 *    passing confirmAppName equal to the ticket's appName. A confirmed op then re-establishes
 *    `.bcsync` (via recordBranchMapping), so the confirmation is a one-time, self-healing step.
 *  - No committed mapping and no local history → a brand-new folder/branch; the ticket is the
 *    source of truth for the first-time binding, no confirmation needed.
 *
 * No-op when the ticket's app id can't be derived from its base URL.
 */
async function assertAppGuard(
  rootDir: string,
  branch: string,
  ticket: SyncTicket,
  options: SyncOptions
): Promise<void> {
  const appId = appIdFromBaseUrl(ticket.baseUrl);
  if (!appId) {
    return;
  }
  const existing = (await readConfig(rootDir))?.branchMappings[branch];
  if (existing) {
    if (existing.appId !== appId) {
      throw appMismatchError(branch, existing.appId, existing.appName, appId, ticket.appName);
    }
    return;
  }
  const base = (await readLocalState(rootDir))[branch]?.scripts ?? {};
  const previouslySynced = Object.keys(base).length > 0;
  if (previouslySynced && options.confirmAppName !== ticket.appName) {
    throw unverifiedAppError(branch, appId, ticket.appName);
  }
}

/**
 * Record this branch → app mapping in the committed `.bcsync` (creating the file if needed) and
 * ensure `.bcsync.local` is gitignored. `.bcsync` is the team-shared, committable record of which
 * brainCloud app a branch targets — the VS Code extension and a teammate's checkout both resolve
 * the app from it, so a folder the helper seeds must carry it. Idempotent: only writes when the
 * mapping is new or its appName changed, avoiding spurious diffs on every sync.
 */
async function recordBranchMapping(rootDir: string, branch: string, ticket: SyncTicket): Promise<void> {
  const appId = appIdFromBaseUrl(ticket.baseUrl);
  if (!appId) {
    return;
  }
  const config = (await readConfig(rootDir)) ?? { branchMappings: {} };
  const existing = config.branchMappings[branch];
  if (existing && existing.appId !== appId) {
    throw appMismatchError(branch, existing.appId, existing.appName, appId, ticket.appName);
  }
  if (!existing || existing.appName !== ticket.appName) {
    config.branchMappings[branch] = {
      appId,
      ...(ticket.appName ? { appName: ticket.appName } : {}),
    };
    await writeConfig(rootDir, config);
  }
  await ensureGitignore(rootDir);
}

function appMismatchError(
  branch: string,
  mappedAppId: string,
  mappedAppName: string | undefined,
  ticketAppId: string,
  ticketAppName: string
): Error {
  const mapped = mappedAppName ? `${mappedAppName} (${mappedAppId})` : mappedAppId;
  const ticketApp = ticketAppName ? `${ticketAppName} (${ticketAppId})` : ticketAppId;
  return new Error(
    `.bcsync binds branch "${branch}" to app ${mapped}, but the sync ticket is for app ${ticketApp}. ` +
      `Refusing to sync — use a ticket for ${mapped}, or fix the branch mapping in .bcsync.`
  );
}

/**
 * Handle the no-git → git transition. A folder first synced without a git repo tracks its state
 * under the reserved `""` key (an empty string can never be a real git branch name, so it never
 * collides). When a real branch later appears and has no state of its own, but `""` state exists,
 * the op refuses until the caller confirms with adoptNoGitBranch=true — then the `""` mapping and
 * base state are moved onto the branch and the `""` entry dropped. Composes with assertAppGuard:
 * after adoption the branch carries the old `""` app, so a mismatched ticket is still caught.
 *
 * No-op when: branch is the `""` key itself; the branch already has state; or there is no `""`
 * state to adopt (a genuinely brand-new branch — the normal first-time-binding case).
 */
async function maybeMigrateNoGit(rootDir: string, branch: string, options: SyncOptions): Promise<void> {
  if (!branch || branch === NO_GIT_BRANCH) {
    return;
  }
  const config = (await readConfig(rootDir)) ?? { branchMappings: {} };
  const local = await readLocalState(rootDir);
  const branchEstablished =
    config.branchMappings[branch] !== undefined ||
    Object.keys(local[branch]?.scripts ?? {}).length > 0;
  if (branchEstablished) {
    return;
  }
  const noGitMapping = config.branchMappings[NO_GIT_BRANCH];
  const noGitState = local[NO_GIT_BRANCH];
  const hasNoGitState = noGitMapping !== undefined || Object.keys(noGitState?.scripts ?? {}).length > 0;
  if (!hasNoGitState) {
    return;
  }
  if (options.adoptNoGitBranch !== true) {
    throw migrateNoGitPrompt(branch, noGitMapping?.appId, noGitMapping?.appName);
  }
  if (noGitMapping !== undefined) {
    config.branchMappings[branch] = noGitMapping;
    delete config.branchMappings[NO_GIT_BRANCH];
    await writeConfig(rootDir, config);
  }
  if (noGitState !== undefined) {
    local[branch] = noGitState;
    delete local[NO_GIT_BRANCH];
    await writeLocalState(rootDir, local);
  }
}

function migrateNoGitPrompt(branch: string, appId?: string, appName?: string): Error {
  const app = appId ? (appName ? `${appName} (${appId})` : appId) : 'an app';
  return new Error(
    `This folder was synced without git (under the no-branch key) for ${app}, and you are now on ` +
      `git branch "${branch}". Re-run with adoptNoGitBranch=true to move that sync state and app ` +
      `mapping onto "${branch}" and drop the no-git entry. To keep them separate, or to use a ` +
      `different app for this branch, pass branch explicitly instead.`
  );
}

function unverifiedAppError(branch: string, ticketAppId: string, ticketAppName: string): Error {
  const app = ticketAppName ? `${ticketAppName} (${ticketAppId})` : ticketAppId;
  return new Error(
    `This folder has local sync history for branch "${branch}" but no committed .bcsync app mapping, ` +
      `so the target app cannot be verified (it may have been synced by an older helper). The ticket ` +
      `is for app ${app}. If that is the correct app for this folder, re-run with ` +
      `confirmAppName="${ticketAppName}" to confirm; otherwise use a ticket for the right app.`
  );
}
