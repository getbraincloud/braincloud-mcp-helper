/**
 * Minimal ambient types for the parts of `node-diff3` we use.
 *
 * node-diff3 v3 is a dual package whose types are declared only via its `exports` map, which
 * classic `moduleResolution: node` does not honour — so tsc can't find them. The runtime `require`
 * still resolves to its CommonJS build; this shim just supplies the types for `merge`.
 */
declare module 'node-diff3' {
  export interface MergeResult {
    conflict: boolean;
    result: string[];
  }

  export interface MergeOptions {
    excludeFalseConflicts?: boolean;
    stringSeparator?: string | RegExp;
    label?: { a?: string; o?: string; b?: string };
  }

  export function merge(
    a: string[] | string,
    o: string[] | string,
    b: string[] | string,
    options?: MergeOptions
  ): MergeResult;
}
