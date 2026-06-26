import { createHash } from 'node:crypto';
import { HASH_META_FIELDS, type ParsedCcjs, type ScriptMetadata } from './metadata';

/**
 * Compute the change-detection hash for a script: a sha256 over the normalised body plus the
 * authoritative-but-positionless metadata ({@link HASH_META_FIELDS}). This is the signal stored
 * as `sha256` in `.bcsync.local` and compared on each sync to decide "did the local file change?".
 *
 * Deliberately git-robust and export-stable:
 *  - line endings normalised (CRLF/LF) and trailing whitespace trimmed, so checkout/clone/pull
 *    (which rewrite mtimes and can rewrite EOLs) don't register as edits;
 *  - server bookkeeping (version/updatedAt/author/scriptId/treeId) is excluded, so a plain
 *    re-export doesn't look like a change;
 *  - scriptName and folderPath are excluded (renames/moves are tracked structurally, not here).
 */
export function computeSyncHash(parsed: Pick<ParsedCcjs, 'body' | 'metadata'>): string {
  const canonical = canonicalString(parsed.body, parsed.metadata);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** The exact string fed to sha256 — exposed for tests and debugging. */
export function canonicalString(body: string, metadata: ScriptMetadata): string {
  const meta: Record<string, unknown> = {};
  for (const field of HASH_META_FIELDS) {
    if (metadata[field] !== undefined) {
      meta[field] = metadata[field];
    }
  }
  return JSON.stringify({ body: normalizeBody(body), meta });
}

/** Normalise line endings and trailing whitespace so cosmetic git churn isn't seen as a change. */
function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, '\n').replace(/\s+$/, '');
}
