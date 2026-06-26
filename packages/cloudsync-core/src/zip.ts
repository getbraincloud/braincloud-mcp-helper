import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { buildCcjs, parseCcjs, type ScriptMetadata } from './metadata';

/**
 * A script in its on-disk/logical form for zipping. `path` is the full logical path including the
 * script name, no extension, forward-slash separated (e.g. `"utils/game/saveProgress"`).
 */
export interface ZipScript {
  path: string;
  body: string;
  metadata?: ScriptMetadata;
}

const SCRIPT_EXTENSIONS = ['.cloudcode.js', '.ccjs', '.js'];

/**
 * Build a zip for the Builder bulk import (`POST /scripts`).
 *
 * Two things matter for correctness against the server's importer:
 *  - The server **discards zip entry folder paths** and places each script by the `folderPath`
 *    field in its metadata block. So we set `folderPath` (and `scriptName`) in every block from
 *    the script's logical path — the path is the source of truth.
 *  - We still name entries by the full path (`utils/game/saveProgress.ccjs`) so two scripts that
 *    share a bare name in different folders don't collide as flat entries. Folder names are
 *    lowercased to match the server/VS Code convention.
 */
export function buildImportZip(scripts: ZipScript[]): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const script of scripts) {
    const { folderPath, scriptName } = splitPath(script.path);
    const metadata: ScriptMetadata = {
      ...script.metadata,
      scriptName,
      ...(folderPath ? { folderPath } : {}),
    };
    if (!folderPath) {
      // Root script: ensure no stale folderPath rides along from the source metadata.
      delete metadata.folderPath;
    }
    const entryName = `${folderPath ? `${folderPath}/` : ''}${scriptName}.ccjs`;
    files[entryName] = strToU8(buildCcjs(script.body, metadata));
  }
  return zipSync(files);
}

/**
 * Expand an export zip (`GET /script?export=true`) into scripts. Each `.js` / `.ccjs` /
 * `.cloudcode.js` entry is parsed; the logical path is taken from the metadata block's
 * `folderPath` + `scriptName` when present, otherwise derived from the entry path. Directories,
 * hidden files and non-script entries are skipped.
 */
export function expandExportZip(data: Uint8Array): ZipScript[] {
  const entries = unzipSync(data);
  const scripts: ZipScript[] = [];

  for (const [entryName, bytes] of Object.entries(entries)) {
    if (entryName.endsWith('/')) {
      continue; // directory
    }
    const base = entryName.split('/').pop() ?? entryName;
    if (base.startsWith('.') || !hasScriptExtension(base)) {
      continue; // hidden or non-script file
    }

    const parsed = parseCcjs(strFromU8(bytes));
    const fromEntry = splitPath(stripExtension(entryName));
    const scriptName =
      typeof parsed.metadata.scriptName === 'string' && parsed.metadata.scriptName.trim()
        ? parsed.metadata.scriptName
        : fromEntry.scriptName;
    const folderPath =
      typeof parsed.metadata.folderPath === 'string'
        ? normalizeFolder(parsed.metadata.folderPath)
        : fromEntry.folderPath;

    scripts.push({
      path: folderPath ? `${folderPath}/${scriptName}` : scriptName,
      body: parsed.body,
      metadata: parsed.metadata,
    });
  }

  return scripts.sort((a, b) => a.path.localeCompare(b.path));
}

// --------------------------------------------------------------------------------------------
// internals
// --------------------------------------------------------------------------------------------

/** Split a logical path into a lowercased folder path and the (case-preserved) script name. */
function splitPath(path: string): { folderPath: string; scriptName: string } {
  const clean = path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const lastSlash = clean.lastIndexOf('/');
  if (lastSlash === -1) {
    return { folderPath: '', scriptName: clean };
  }
  return {
    folderPath: normalizeFolder(clean.slice(0, lastSlash)),
    scriptName: clean.slice(lastSlash + 1),
  };
}

/** Lowercase + trim slashes — folder names are lowercase by convention. */
function normalizeFolder(folder: string): string {
  return folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
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
