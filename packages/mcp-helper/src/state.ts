import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  parseBcSync,
  serializeBcSync,
  parseBcSyncLocal,
  serializeBcSyncLocal,
  type BcSyncConfig,
  type BcSyncLocal,
} from '@braincloud/cloudsync-core';

const BCSYNC = '.bcsync';
const BCSYNC_LOCAL = '.bcsync.local';

/**
 * Folder names the downstream probe is allowed to descend into when the upward walk finds no
 * `.bcsync`. Matched case- and separator-insensitively (see {@link normalizeFolderName}), so
 * `cloud_code`, `cloudCode` and `CloudCode` all collapse to one entry. This deliberately bounds
 * the downward search to the handful of conventional cloud-code locations instead of scanning the
 * whole tree — e.g. a project whose scripts live at `cloud_code/scripts/.bcsync` while the helper
 * is launched from the project root.
 */
const DOWNSTREAM_FOLDER_NAMES = new Set(['scripts', 'cloudcode', 'braincloud', 'bc']);

/** How many allowlisted folders deep the downstream probe will descend before giving up. */
const DOWNSTREAM_MAX_DEPTH = 5;

/**
 * Branch key used when a folder is not a git repo. MUST stay equal to the brainCloud VS Code
 * extension's sentinel ("__default__") so the shared `.bcsync` branch→app mapping interoperates
 * across both tools on the same folder. (Defined here for now; a future cloudsync-core release
 * should own this as part of converging the on-disk contract — see BCLOUD-14117.)
 */
export const NO_GIT_BRANCH = '__default__';

/** Read the committed `.bcsync` config, or `undefined` if absent. */
export async function readConfig(rootDir: string): Promise<BcSyncConfig | undefined> {
  const text = await readFileOpt(path.join(rootDir, BCSYNC));
  return text === undefined ? undefined : parseBcSync(text);
}

export async function writeConfig(rootDir: string, config: BcSyncConfig): Promise<void> {
  await fs.writeFile(path.join(rootDir, BCSYNC), serializeBcSync(config), 'utf8');
}

/** Read the per-machine `.bcsync.local` state, or an empty object if absent. */
export async function readLocalState(rootDir: string): Promise<BcSyncLocal> {
  const text = await readFileOpt(path.join(rootDir, BCSYNC_LOCAL));
  return text === undefined ? {} : parseBcSyncLocal(text);
}

export async function writeLocalState(rootDir: string, local: BcSyncLocal): Promise<void> {
  await fs.writeFile(path.join(rootDir, BCSYNC_LOCAL), serializeBcSyncLocal(local), 'utf8');
}

/**
 * Ensure the sync folder's `.gitignore` lists `.bcsync.local`, so the per-machine sync state is
 * never committed. Idempotent: appends the entry only if absent, preserving any existing content.
 */
export async function ensureGitignore(rootDir: string): Promise<void> {
  const file = path.join(rootDir, '.gitignore');
  const existing = (await readFileOpt(file)) ?? '';
  const present = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  if (present.has(BCSYNC_LOCAL)) {
    return;
  }
  const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  await fs.writeFile(file, `${existing}${sep}${BCSYNC_LOCAL}\n`, 'utf8');
}

/**
 * Resolve the sync folder for an operation. An explicit `rootDir` always wins (resolved to an
 * absolute path). Otherwise the folder is discovered in two passes from `startDir` (default the
 * helper's working directory):
 *
 *  1. Walk *up* to the nearest folder holding a `.bcsync` / `.bcsync.local` — the same "find the
 *     repo root" pattern git uses — so a client launched inside a synced folder need not repeat
 *     the path.
 *  2. If nothing is found above, probe *down* through conventional cloud-code folder names
 *     ({@link DOWNSTREAM_FOLDER_NAMES}) — so a helper launched at the project root still finds a
 *     sync folder nested at e.g. `cloud_code/scripts/.bcsync`.
 *
 * Throws an actionable error when neither pass finds a folder (e.g. a brand-new folder, before its
 * first sync, which has no `.bcsync` yet), or when the downward probe is ambiguous (two distinct
 * sync folders at the same shallowest depth).
 */
export async function resolveSyncRoot(rootDir?: string, startDir: string = process.cwd()): Promise<string> {
  if (rootDir && rootDir.trim()) {
    return path.resolve(rootDir.trim());
  }
  const above = await findSyncRoot(startDir);
  if (above) {
    return above;
  }
  const below = await findSyncRootDownstream(startDir);
  if (below) {
    return below;
  }
  throw new Error(
    `No rootDir given and no .bcsync sync folder found at or above ${path.resolve(startDir)}, ` +
      `nor in a conventional cloud-code subfolder below it (${[...DOWNSTREAM_FOLDER_NAMES].join(', ')}). ` +
      `Pass rootDir (an absolute path to the sync folder), or run the client from inside a synced ` +
      `folder. A brand-new folder has no .bcsync until its first sync — pass rootDir that first time.`
  );
}

/** Walk up from `startDir` to the nearest folder containing `.bcsync` or `.bcsync.local`. */
async function findSyncRoot(startDir: string): Promise<string | undefined> {
  let current = path.resolve(startDir);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (await hasSyncMarker(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

/**
 * Probe *down* from `startDir` for a sync folder, descending only into folders whose name is in
 * {@link DOWNSTREAM_FOLDER_NAMES}. Breadth-first so the shallowest match wins; throws if two
 * distinct sync folders are found at that same shallowest depth (ambiguous — caller should pass an
 * explicit `rootDir`). Returns `undefined` if nothing is found within {@link DOWNSTREAM_MAX_DEPTH}.
 */
async function findSyncRootDownstream(startDir: string): Promise<string | undefined> {
  let frontier = [path.resolve(startDir)];
  for (let depth = 0; depth < DOWNSTREAM_MAX_DEPTH && frontier.length > 0; depth++) {
    const allowedChildren = (
      await Promise.all(frontier.map((dir) => allowedSubdirs(dir)))
    ).flat();

    const hits: string[] = [];
    for (const dir of allowedChildren) {
      if (await hasSyncMarker(dir)) {
        hits.push(dir);
      }
    }
    if (hits.length === 1) {
      return hits[0];
    }
    if (hits.length > 1) {
      throw new Error(
        `Ambiguous .bcsync sync folders found below ${path.resolve(startDir)}:\n` +
          hits.map((h) => `  - ${h}`).join('\n') +
          `\nPass rootDir (an absolute path) to choose one.`
      );
    }
    frontier = allowedChildren;
  }
  return undefined;
}

/** True if `dir` holds a `.bcsync` or `.bcsync.local` file. */
async function hasSyncMarker(dir: string): Promise<boolean> {
  return (
    (await statOpt(path.join(dir, BCSYNC)))?.isFile() === true ||
    (await statOpt(path.join(dir, BCSYNC_LOCAL)))?.isFile() === true
  );
}

/** Absolute paths of `dir`'s immediate subdirectories whose name is in the downstream allowlist. */
async function allowedSubdirs(dir: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && DOWNSTREAM_FOLDER_NAMES.has(normalizeFolderName(e.name)))
    .map((e) => path.join(dir, e.name));
}

/** Lower-case and strip separators so `cloud_code`, `cloudCode` and `CloudCode` all match. */
function normalizeFolderName(name: string): string {
  return name.toLowerCase().replace(/[-_\s]/g, '');
}

/**
 * Resolve the current git branch by reading `.git/HEAD` (no git binary needed). Walks up from
 * `startDir` to find the repo. Returns `undefined` if not in a repo or in detached-HEAD state.
 */
export async function currentBranch(startDir: string): Promise<string | undefined> {
  const gitDir = await findGitDir(startDir);
  if (!gitDir) {
    return undefined;
  }
  const head = await readFileOpt(path.join(gitDir, 'HEAD'));
  const match = head?.match(/^ref:\s*refs\/heads\/(.+)\s*$/m);
  return match ? match[1]!.trim() : undefined;
}

// --------------------------------------------------------------------------------------------
// internals
// --------------------------------------------------------------------------------------------

async function findGitDir(startDir: string): Promise<string | undefined> {
  let current = path.resolve(startDir);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = path.join(current, '.git');
    const stat = await statOpt(candidate);
    if (stat?.isDirectory()) {
      return candidate;
    }
    if (stat?.isFile()) {
      // Worktree/submodule: ".git" is a file containing "gitdir: <path>".
      const text = (await readFileOpt(candidate)) ?? '';
      const m = text.match(/^gitdir:\s*(.+)\s*$/m);
      if (m) {
        return path.resolve(current, m[1]!.trim());
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

async function readFileOpt(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

async function statOpt(filePath: string): Promise<import('node:fs').Stats | undefined> {
  try {
    return await fs.stat(filePath);
  } catch {
    return undefined;
  }
}
