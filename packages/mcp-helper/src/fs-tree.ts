import { promises as fs, type Dirent } from 'node:fs';
import * as path from 'node:path';
import { buildCcjs, parseCcjs, type ScriptMetadata, type ZipScript } from '@braincloud/cloudsync-core';

/**
 * Node filesystem I/O for a local cloud-code tree. This lives in the helper (not cloudsync-core)
 * because it is host-specific: the helper uses `node:fs`, whereas the VS Code extension uses its
 * own `vscode.workspace.fs`. Both share the format logic via cloudsync-core.
 *
 * On-disk model: the directory tree mirrors the cloud folder tree; each script is a `.ccjs` file
 * whose logical path is its location relative to the sync root, minus the extension. The directory
 * is the source of truth for placement — a stale `folderPath` in a file's block is ignored on read
 * (and rewritten on the next write); this is why the change-detection hash excludes folderPath.
 */

const SCRIPT_EXTENSIONS = ['.cloudcode.js', '.ccjs', '.js'];

/** Recursively read every script file under `rootDir` into ZipScripts, sorted by path. */
export async function readScriptTree(rootDir: string): Promise<ZipScript[]> {
  const scripts: ZipScript[] = [];
  await walk(rootDir, rootDir, scripts);
  return scripts.sort((a, b) => a.path.localeCompare(b.path));
}

/** Write one script to `rootDir`, creating folders as needed. Returns the absolute file path. */
export async function writeScript(rootDir: string, script: ZipScript): Promise<string> {
  const { folderPath, scriptName } = splitPath(script.path);
  const metadata: ScriptMetadata = { ...script.metadata, scriptName };
  if (folderPath) {
    metadata.folderPath = folderPath;
  } else {
    delete metadata.folderPath;
  }

  const fullPath = path.join(rootDir, ...toSegments(script.path)) + '.ccjs';
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, buildCcjs(script.body, metadata), 'utf8');
  return fullPath;
}

/** Write many scripts. */
export async function writeScriptTree(rootDir: string, scripts: ZipScript[]): Promise<void> {
  for (const script of scripts) {
    await writeScript(rootDir, script);
  }
}

/** Delete a script file by logical path and prune any folders left empty (up to the root). */
export async function deleteScript(rootDir: string, scriptPath: string): Promise<void> {
  const fullPath = path.join(rootDir, ...toSegments(scriptPath)) + '.ccjs';
  await fs.rm(fullPath, { force: true });
  await pruneEmptyDirs(path.dirname(fullPath), rootDir);
}

// --------------------------------------------------------------------------------------------
// internals
// --------------------------------------------------------------------------------------------

async function walk(dir: string, rootDir: string, out: ZipScript[]): Promise<void> {
  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // missing root → empty tree
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue; // hidden files/dirs and .bcsync/.bcsync.local
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, rootDir, out);
    } else if (entry.isFile() && hasScriptExtension(entry.name)) {
      const content = await fs.readFile(full, 'utf8');
      const parsed = parseCcjs(content);
      const rel = path.relative(rootDir, full).split(path.sep).join('/');
      out.push({ path: stripExtension(rel), body: parsed.body, metadata: parsed.metadata });
    }
  }
}

async function pruneEmptyDirs(dir: string, rootDir: string): Promise<void> {
  const root = path.resolve(rootDir);
  let current = path.resolve(dir);
  while (current.startsWith(root) && current !== root) {
    try {
      const remaining = await fs.readdir(current);
      if (remaining.length > 0) {
        return;
      }
      await fs.rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

/** Split a logical path into a lowercased folder path and the case-preserved script name. */
function splitPath(logicalPath: string): { folderPath: string; scriptName: string } {
  const clean = logicalPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const lastSlash = clean.lastIndexOf('/');
  if (lastSlash === -1) {
    return { folderPath: '', scriptName: clean };
  }
  return {
    folderPath: clean.slice(0, lastSlash).toLowerCase(),
    scriptName: clean.slice(lastSlash + 1),
  };
}

/** Logical path → OS path segments (folders lowercased, name case-preserved). */
function toSegments(logicalPath: string): string[] {
  const { folderPath, scriptName } = splitPath(logicalPath);
  return folderPath ? [...folderPath.split('/'), scriptName] : [scriptName];
}

function hasScriptExtension(name: string): boolean {
  return SCRIPT_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));
}

function stripExtension(name: string): string {
  const lower = name.toLowerCase();
  for (const ext of SCRIPT_EXTENSIONS) {
    if (lower.endsWith(ext)) {
      return name.slice(0, name.length - ext.length);
    }
  }
  return name;
}
