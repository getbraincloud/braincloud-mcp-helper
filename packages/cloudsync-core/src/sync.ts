/**
 * Three-way sync classification. For each script we compare three states — exactly like a
 * 3-way merge — and decide one action:
 *
 *   LOCAL  — the working-tree .ccjs (its content hash; see computeSyncHash)
 *   BASE   — the last-synced state from .bcsync.local (brainCloud version + sha256)
 *   REMOTE — the current brainCloud script (current version; content hash when available)
 *
 * Change detection is cheap: remote-changed = `remote.version !== base.version` (one version
 * list call), local-changed = `local.hash !== base.sha256`. Remote content is only needed to tell
 * a true CONFLICT from a CONVERGED (both sides changed to the same thing).
 */

export type SyncAction =
  | 'in-sync'
  | 'pull'
  | 'push'
  | 'pull-new'
  | 'push-new'
  | 'converged'
  | 'conflict'
  | 'delete-local'
  | 'delete-remote';

export interface ScriptComparison {
  path: string;
  /** Present when a local file exists. */
  local?: { hash: string };
  /** Present when the script is recorded in .bcsync.local (i.e. was synced before). */
  base?: { version: number; sha256: string };
  /** Present when the script exists on brainCloud. `hash` is only known if remote content was fetched. */
  remote?: { version: number; hash?: string };
}

export interface ScriptStatus {
  path: string;
  action: SyncAction;
  /** Short human-readable explanation, for the `status` dry-run output. */
  reason: string;
}

/**
 * Classify a single script into a sync action. When both sides changed, a definitive
 * CONVERGED verdict requires `remote.hash`; without it we conservatively report CONFLICT
 * (the caller can fetch remote content and re-classify to confirm).
 */
export function classifyScript(cmp: ScriptComparison): ScriptStatus {
  const { path, local, base, remote } = cmp;
  const status = (action: SyncAction, reason: string): ScriptStatus => ({ path, action, reason });

  // --- No BASE: never synced before; presence decides. -------------------------------------
  if (!base) {
    if (local && remote) {
      if (remote.hash !== undefined && remote.hash === local.hash) {
        return status('converged', 'new on both sides with identical content; adopt base');
      }
      return status('conflict', 'new on both local and remote with no common base');
    }
    if (local) {
      return status('push-new', 'new local script; create on brainCloud');
    }
    if (remote) {
      return status('pull-new', 'new remote script; create local file');
    }
    return status('in-sync', 'nothing to do');
  }

  // --- BASE exists. ------------------------------------------------------------------------
  const remoteChanged = remote ? remote.version !== base.version : undefined;
  const localChanged = local ? local.hash !== base.sha256 : undefined;

  // Both deleted since base — base is stale; nothing to transfer.
  if (!local && !remote) {
    return status('in-sync', 'deleted on both sides; clear base record');
  }

  // Remote deleted.
  if (!remote) {
    return localChanged
      ? status('conflict', 'deleted on brainCloud but modified locally (delete/modify)')
      : status('delete-local', 'deleted on brainCloud; remove local file');
  }

  // Local deleted.
  if (!local) {
    return remoteChanged
      ? status('conflict', 'deleted locally but modified on brainCloud (delete/modify)')
      : status('delete-remote', 'deleted locally; remove from brainCloud');
  }

  // Both present.
  if (!remoteChanged && !localChanged) {
    return status('in-sync', 'unchanged on both sides');
  }
  if (remoteChanged && !localChanged) {
    return status('pull', 'changed on brainCloud; pull to local');
  }
  if (!remoteChanged && localChanged) {
    return status('push', 'changed locally; push to brainCloud');
  }
  // Both changed.
  if (remote.hash !== undefined && remote.hash === local.hash) {
    return status('converged', 'changed on both sides to identical content; update base only');
  }
  return status('conflict', 'changed on both local and brainCloud; needs 3-way merge');
}

/**
 * Classify every script across the union of local files, base records and remote scripts.
 * Results are returned in stable (sorted-by-path) order.
 */
export function classifyScripts(input: {
  local: Record<string, { hash: string }>;
  base: Record<string, { version: number; sha256: string }>;
  remote: Record<string, { version: number; hash?: string }>;
}): ScriptStatus[] {
  const paths = new Set<string>([
    ...Object.keys(input.local),
    ...Object.keys(input.base),
    ...Object.keys(input.remote),
  ]);

  return [...paths].sort().map((path) =>
    classifyScript({
      path,
      local: input.local[path],
      base: input.base[path],
      remote: input.remote[path],
    })
  );
}
