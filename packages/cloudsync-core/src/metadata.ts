import { CcjsBuildError, CcjsParseError } from "./errors";

/**
 * The exact marker line that begins a brainCloud cloud-code metadata block. The brainCloud
 * server writes this verbatim on export and splits on it (and on `// "scriptName"`) when
 * parsing an import. It MUST match byte-for-byte or the server won't recognise the block.
 *
 * Server reference: CloudCodeScriptImportService.parseScript / ScriptService metadata marker.
 */
export const META_MARKER =
  '//*** ------------- brainCloud meta-data begins now - do not hand-edit -----------------';

/**
 * Developer-authored fields. These sync both ways and participate in change detection — a
 * genuine change to one of these IS a push. (Folder placement is handled separately: see
 * {@link HASH_META_FIELDS}.)
 */
export const AUTHORITATIVE_FIELDS = [
  'clientCallable',
  's2sCallable',
  'peerCallable',
  'scriptTimeout',
  'description',
  'parms',
  'folderPath',
] as const;

/**
 * Server-owned fields. They may appear in the block for human readability, but they are never
 * authoritative on push and are excluded from the change-detection hash — they change on every
 * export, so counting them would make every pull look locally modified.
 */
export const BOOKKEEPING_FIELDS = [
  'version',
  'updatedAt',
  'author',
  'scriptId',
  'treeId',
] as const;

/**
 * The subset of metadata that feeds the change-detection hash, alongside the body. This is
 * deliberately NOT the whole authoritative set:
 *  - `scriptName` is excluded — a rename is a move (tracked by scriptId), not a content change.
 *  - `folderPath` is excluded — folder placement is represented by the on-disk directory tree
 *    (and tracked as a move), not by the file's content. Including it would double-count moves.
 */
export const HASH_META_FIELDS = [
  'clientCallable',
  's2sCallable',
  'peerCallable',
  'scriptTimeout',
  'description',
  'parms',
] as const;

/** Parsed metadata from a `.ccjs` block. Known keys are typed; unknown keys pass through. */
export interface ScriptMetadata {
  scriptName?: string;
  description?: string;
  clientCallable?: boolean;
  s2sCallable?: boolean;
  peerCallable?: boolean;
  scriptTimeout?: number;
  parms?: string;
  folderPath?: string;
  // bookkeeping (server-owned)
  version?: number;
  updatedAt?: number;
  author?: unknown;
  scriptId?: string;
  treeId?: string;
  [key: string]: unknown;
}

export interface ParsedCcjs {
  /** The script source, with the trailing metadata block (if any) and trailing blank lines removed. */
  body: string;
  /** Parsed metadata; `{}` when the file has no metadata block. */
  metadata: ScriptMetadata;
  /** True if a metadata block was present and parsed. */
  hasMetadataBlock: boolean;
}

/**
 * Split a `.ccjs` file into its script body and parsed metadata block. A file with no block
 * (e.g. content-only, as the legacy VS Code extension wrote) yields `{}` metadata.
 */
export function parseCcjs(fileContent: string): ParsedCcjs {
  const markerIndex = fileContent.indexOf(META_MARKER);
  if (markerIndex === -1) {
    return { body: stripTrailingBlank(fileContent), metadata: {}, hasMetadataBlock: false };
  }
  const body = stripTrailingBlank(fileContent.slice(0, markerIndex));
  const block = fileContent.slice(markerIndex + META_MARKER.length);
  return { body, metadata: parseMetadataBlock(block), hasMetadataBlock: true };
}

/**
 * Build a complete `.ccjs` file from a body and metadata. `scriptName` is required and is
 * emitted first (the server splits the block on `// "scriptName"`). The final metadata line
 * carries no trailing comma so the block is valid JSON once the server strips the `//` prefixes.
 */
export function buildCcjs(body: string, metadata: ScriptMetadata): string {
  if (!metadata.scriptName || !String(metadata.scriptName).trim()) {
    throw new CcjsBuildError('scriptName is required to build a .ccjs metadata block.');
  }

  const lines: string[] = [META_MARKER, metaLine('scriptName', metadata.scriptName)];
  for (const key of orderedMetadataKeys(metadata)) {
    if (key === 'scriptName' || metadata[key] === undefined) {
      continue;
    }
    lines.push(metaLine(key, metadata[key]));
  }
  // Strip the trailing comma from the last metadata line (the block parses as JSON).
  const lastIndex = lines.length - 1;
  lines[lastIndex] = lines[lastIndex]!.replace(/,\s*$/, '');

  return `${stripTrailingBlank(body)}\n\n${lines.join('\n')}\n`;
}

// --------------------------------------------------------------------------------------------
// internals
// --------------------------------------------------------------------------------------------

/** One metadata line: `// "key": <value>,` — always with a trailing comma (stripped on the last). */
function metaLine(key: string, value: unknown): string {
  return `// ${JSON.stringify(key)}: ${escapeForBlock(JSON.stringify(value))},`;
}

/**
 * brainCloud metadata blocks are ECMAScript-escaped, and the server's importer runs an
 * ECMAScript-unescape ({@link ecmaUnescape}) before JSON-parsing. Doubling the backslashes in our
 * JSON token is the inverse of that unescape, so the value survives both the server's import and our
 * own round-trip read as valid JSON (e.g. a quote inside parms is written `\\"` → unescapes to `\"`).
 */
function escapeForBlock(jsonToken: string): string {
  return jsonToken.replace(/\\/g, '\\\\');
}

/**
 * Emit known fields in a stable, documented order (authoritative first, then bookkeeping), with
 * any unrecognised keys appended alphabetically. Deterministic output keeps git diffs minimal.
 */
function orderedMetadataKeys(metadata: ScriptMetadata): string[] {
  const known: string[] = [...AUTHORITATIVE_FIELDS, ...BOOKKEEPING_FIELDS];
  const ordered = known.filter((k) => k in metadata && metadata[k] !== undefined);
  const extras = Object.keys(metadata)
    .filter((k) => k !== 'scriptName' && !known.includes(k) && metadata[k] !== undefined)
    .sort();
  return [...ordered, ...extras];
}

/**
 * Parse the text following the marker into an object. Each line is `// "key": value,`; we strip
 * the leading `//`, drop blanks, remove the trailing comma, wrap in braces and JSON.parse.
 */
function parseMetadataBlock(block: string): ScriptMetadata {
  const inner = block
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\/\/\s?/, '').trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .replace(/,\s*$/, '');

  if (inner.length === 0) {
    return {};
  }
  try {
    // The block is ECMAScript-escaped (the server emits e.g. `\'` and `\\\"`, which plain JSON
    // rejects). Mirror the server's importer: ECMAScript-unescape, then JSON-parse.
    return JSON.parse(`{${ecmaUnescape(inner)}}`) as ScriptMetadata;
  } catch (err) {
    throw new CcjsParseError(
      `Failed to parse cloud-code metadata block: ${(err as Error).message}`
    );
  }
}

/**
 * Reverse ECMAScript string escaping, mirroring the brainCloud server's import step (Apache
 * Commons {@code StringEscapeUtils.unescapeEcmaScript}). Processes left-to-right so `\\` is consumed
 * before the character after it — this is what turns the on-disk `\\\"` / `\\"` into a JSON `\"`
 * (escaped quote preserved) while collapsing ECMAScript-only escapes like `\'` to `'`.
 */
function ecmaUnescape(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\\') {
      out += text[i];
      continue;
    }
    const next = text[i + 1];
    if (next === undefined) {
      out += '\\';
      break;
    }
    switch (next) {
      case '\\': out += '\\'; i++; break;
      case '"': out += '"'; i++; break;
      case "'": out += "'"; i++; break;
      case '/': out += '/'; i++; break;
      case 'b': out += '\b'; i++; break;
      case 'f': out += '\f'; i++; break;
      case 'n': out += '\n'; i++; break;
      case 'r': out += '\r'; i++; break;
      case 't': out += '\t'; i++; break;
      case 'u': {
        const hex = text.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 5;
        } else {
          out += next;
          i++;
        }
        break;
      }
      default: out += next; i++; break;
    }
  }
  return out;
}

/** Normalise CRLF→LF and remove trailing whitespace/newlines (kept out of bodies and blocks). */
function stripTrailingBlank(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\s+$/, '');
}
