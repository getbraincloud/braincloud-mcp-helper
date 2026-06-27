import { merge } from 'node-diff3';

export interface Merge3Labels {
  /** Label for the local side in conflict markers (default "local"). */
  local?: string;
  /** Label for the brainCloud side in conflict markers (default "brainCloud"). */
  remote?: string;
}

export interface Merge3Result {
  /** The merged text. On conflict, contains git-style `<<<<<<< / ======= / >>>>>>>` markers. */
  merged: string;
  /** True if any hunk overlapped and could not be auto-merged. */
  conflict: boolean;
}

/**
 * Three-way merge of cloud-code script bodies:
 *   local  — the working-tree body
 *   base   — the last-synced body (recovered from brainCloud version history)
 *   remote — the current brainCloud body
 *
 * Non-overlapping edits on each side merge cleanly. Identical edits on both sides collapse to one
 * (no false conflict). Only genuinely overlapping hunks become conflicts, marked git-style for the
 * developer to resolve. Comparison is line-based and CRLF-normalised so cosmetic EOL differences
 * don't manufacture conflicts.
 */
export function merge3(
  local: string,
  base: string,
  remote: string,
  labels: Merge3Labels = {}
): Merge3Result {
  const result = merge(toLines(local), toLines(base), toLines(remote), {
    excludeFalseConflicts: true,
    label: { a: labels.local ?? 'local', b: labels.remote ?? 'brainCloud' },
  });
  return { merged: result.result.join('\n'), conflict: result.conflict };
}

function toLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n');
}
