import { BcSyncParseError } from './errors';

/**
 * `.bcsync` — the committed, team-shared sync config. Maps each git branch to the brainCloud app
 * it targets (dev/staging/prod), so sync always acts on the right stage for the current branch.
 */
export interface BranchMapping {
  appId: string;
  appName?: string;
}

export interface BcSyncConfig {
  gitRemote?: string;
  relativeFolder?: string;
  localFolder?: string;
  branchMappings: Record<string, BranchMapping>;
  /** Unknown top-level fields are preserved on round-trip. */
  [key: string]: unknown;
}

/**
 * `.bcsync.local` — the gitignored, per-machine sync state, keyed by branch name. Each branch
 * carries the VS Code `scriptVersions` map (kept for cross-tool compatibility) plus the richer
 * MCP `scripts` map (scriptId + version + sha256) used for 3-way-merge change detection.
 */
export interface ScriptSyncRecord {
  /** brainCloud scriptId — robust rename/move tracking. */
  scriptId?: string;
  /** brainCloud version at last sync — the optimistic-lock counter / merge BASE. */
  version: number;
  /** Hash of the synced content at last sync (see computeSyncHash) — git-robust change signal. */
  sha256: string;
}

/**
 * `.bcsync.local` format version, shared with the brainCloud VS Code extension. Version 2 means the
 * per-script hashes are body-hashes (computeSyncHash) — which the helper and the extension compute
 * identically — so the two tools can read each other's base hashes. Below 2 are legacy raw-file
 * hashes and are not cross-compatible (a tool re-baselines rather than trust them).
 */
export const LOCAL_FORMAT_VERSION = 2;

export interface BranchSyncState {
  lastSynced?: string;
  /** `.bcsync.local` format version; {@link LOCAL_FORMAT_VERSION} (2) = body-hash content hashes. */
  formatVersion?: number;
  /** path → version. Kept in sync with `scripts` so the VS Code extension keeps working. */
  scriptVersions: Record<string, number>;
  /**
   * path → sha256 body-hash — the VS Code extension's hash map. Written alongside `scripts` (same
   * values as `scripts[path].sha256`) so a folder the helper syncs is readable by the extension.
   */
  contentHashes?: Record<string, string>;
  /** path → richer base record. The MCP source of truth for change detection. */
  scripts: Record<string, ScriptSyncRecord>;
  /** Unknown per-branch fields (e.g. ones a future VS Code version adds) are preserved. */
  [key: string]: unknown;
}

/** Top-level keys are branch names. */
export type BcSyncLocal = Record<string, BranchSyncState>;

// --------------------------------------------------------------------------------------------
// .bcsync (committed config)
// --------------------------------------------------------------------------------------------

export function parseBcSync(json: string): BcSyncConfig {
  const root = parseJsonObject(json, '.bcsync');

  const rawMappings = root.branchMappings;
  const branchMappings: Record<string, BranchMapping> = {};
  if (rawMappings !== undefined) {
    if (!isPlainObject(rawMappings)) {
      throw new BcSyncParseError('.bcsync: "branchMappings" must be an object.');
    }
    for (const [branch, mapping] of Object.entries(rawMappings)) {
      if (!isPlainObject(mapping) || typeof mapping.appId !== 'string' || !mapping.appId.trim()) {
        throw new BcSyncParseError(
          `.bcsync: branchMappings["${branch}"] must have a non-empty string "appId".`
        );
      }
      branchMappings[branch] = {
        appId: mapping.appId,
        ...(typeof mapping.appName === 'string' ? { appName: mapping.appName } : {}),
      };
    }
  }

  return { ...root, branchMappings };
}

export function serializeBcSync(config: BcSyncConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * The brainCloud app a given branch targets, or `undefined` if the branch has no mapping.
 * Callers must refuse to sync (rather than guess an app) when this returns `undefined`.
 */
export function resolveBranchApp(config: BcSyncConfig, branch: string): BranchMapping | undefined {
  return config.branchMappings[branch];
}

// --------------------------------------------------------------------------------------------
// .bcsync.local (per-machine state)
// --------------------------------------------------------------------------------------------

export function parseBcSyncLocal(json: string): BcSyncLocal {
  const root = parseJsonObject(json, '.bcsync.local');
  const local: BcSyncLocal = {};
  for (const [branch, state] of Object.entries(root)) {
    if (!isPlainObject(state)) {
      throw new BcSyncParseError(`.bcsync.local: branch "${branch}" must be an object.`);
    }
    local[branch] = normalizeBranchState(state);
  }
  return local;
}

export function serializeBcSyncLocal(local: BcSyncLocal): string {
  return `${JSON.stringify(local, null, 2)}\n`;
}

/** Get a branch's state, creating an empty one (with empty maps) if absent. Mutates `local`. */
export function getOrCreateBranchState(local: BcSyncLocal, branch: string): BranchSyncState {
  let state = local[branch];
  if (!state) {
    state = { scriptVersions: {}, scripts: {} };
    local[branch] = state;
  }
  return state;
}

/**
 * Record a script's synced state, keeping the richer `scripts` map and the VS Code-compat
 * `scriptVersions` map consistent. Mutates `local`.
 */
export function upsertBranchScript(
  local: BcSyncLocal,
  branch: string,
  scriptPath: string,
  record: ScriptSyncRecord
): void {
  const state = getOrCreateBranchState(local, branch);
  state.scripts[scriptPath] = record;
  state.scriptVersions[scriptPath] = record.version;
  // Mirror the hash into the VS Code extension's contentHashes map (+ format version) so a folder
  // the helper syncs is readable by the extension without re-baselining. See LOCAL_FORMAT_VERSION.
  (state.contentHashes ??= {})[scriptPath] = record.sha256;
  state.formatVersion = LOCAL_FORMAT_VERSION;
}

/** Remove a script from all maps for a branch (e.g. after a delete sync). Mutates `local`. */
export function removeBranchScript(local: BcSyncLocal, branch: string, scriptPath: string): void {
  const state = local[branch];
  if (!state) {
    return;
  }
  delete state.scripts[scriptPath];
  delete state.scriptVersions[scriptPath];
  if (state.contentHashes) {
    delete state.contentHashes[scriptPath];
  }
}

// --------------------------------------------------------------------------------------------
// internals
// --------------------------------------------------------------------------------------------

/** Coerce a parsed branch entry into a BranchSyncState, defaulting maps and preserving extras. */
function normalizeBranchState(state: Record<string, unknown>): BranchSyncState {
  const scriptVersions: Record<string, number> = {};
  if (isPlainObject(state.scriptVersions)) {
    for (const [path, version] of Object.entries(state.scriptVersions)) {
      if (typeof version === 'number') {
        scriptVersions[path] = version;
      }
    }
  }

  const contentHashes: Record<string, string> = {};
  if (isPlainObject(state.contentHashes)) {
    for (const [path, hash] of Object.entries(state.contentHashes)) {
      if (typeof hash === 'string') {
        contentHashes[path] = hash;
      }
    }
  }

  const scripts: Record<string, ScriptSyncRecord> = {};
  if (isPlainObject(state.scripts)) {
    for (const [path, rec] of Object.entries(state.scripts)) {
      if (isPlainObject(rec) && typeof rec.version === 'number' && typeof rec.sha256 === 'string') {
        scripts[path] = {
          version: rec.version,
          sha256: rec.sha256,
          ...(typeof rec.scriptId === 'string' ? { scriptId: rec.scriptId } : {}),
        };
      }
    }
  }

  // Cross-tool bridge: a `.bcsync.local` written by the VS Code extension carries its base hashes in
  // `contentHashes` (+ formatVersion 2) and no `scripts` map. Those are the same body-hashes the
  // helper uses, so backfill the richer `scripts` map for any path the extension recorded but we
  // don't have — letting the helper trust the extension's base. scriptId is unknown here; the helper
  // recovers it from the live remote when it needs a merge base (baseRec.scriptId ?? meta.scriptId).
  const formatVersion = typeof state.formatVersion === 'number' ? state.formatVersion : undefined;
  if (formatVersion === LOCAL_FORMAT_VERSION) {
    for (const [path, sha256] of Object.entries(contentHashes)) {
      if (!scripts[path]) {
        scripts[path] = { version: scriptVersions[path] ?? 0, sha256 };
      }
    }
  }

  return {
    ...state,
    scriptVersions,
    scripts,
    ...(Object.keys(contentHashes).length > 0 ? { contentHashes } : {}),
    ...(formatVersion !== undefined ? { formatVersion } : {}),
  };
}

function parseJsonObject(json: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new BcSyncParseError(`${label}: invalid JSON — ${(err as Error).message}`);
  }
  if (!isPlainObject(parsed)) {
    throw new BcSyncParseError(`${label}: expected a JSON object at the top level.`);
  }
  return parsed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
