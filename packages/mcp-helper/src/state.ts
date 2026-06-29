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
 * absolute path). Otherwise the folder is discovered by walking up from `startDir` (default the
 * helper's working directory) to the nearest folder holding a `.bcsync` / `.bcsync.local` — the
 * same "find the repo root" pattern git uses — so a client launched inside a synced folder need
 * not repeat the path. Throws an actionable error when neither is available (e.g. a brand-new
 * folder, before its first sync, which has no `.bcsync` yet).
 */
export async function resolveSyncRoot(rootDir?: string, startDir: string = process.cwd()): Promise<string> {
  if (rootDir && rootDir.trim()) {
    return path.resolve(rootDir.trim());
  }
  const found = await findSyncRoot(startDir);
  if (found) {
    return found;
  }
  throw new Error(
    `No rootDir given and no .bcsync sync folder found at or above ${path.resolve(startDir)}. ` +
      `Pass rootDir (an absolute path to the sync folder), or run the client from inside a synced ` +
      `folder. A brand-new folder has no .bcsync until its first sync — pass rootDir that first time.`
  );
}

/** Walk up from `startDir` to the nearest folder containing `.bcsync` or `.bcsync.local`. */
async function findSyncRoot(startDir: string): Promise<string | undefined> {
  let current = path.resolve(startDir);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (
      (await statOpt(path.join(current, BCSYNC)))?.isFile() ||
      (await statOpt(path.join(current, BCSYNC_LOCAL)))?.isFile()
    ) {
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
