/**
 * @braincloud/cloudsync-core
 *
 * Host-agnostic format + sync logic for brainCloud cloud-code, shared by the local helper MCP
 * (@braincloud/mcp-helper) and the VS Code extension (braincloud-vscode-fsprovider). Contains no
 * `vscode` or MCP dependencies — pure data in, data out.
 */
export {
  META_MARKER,
  AUTHORITATIVE_FIELDS,
  BOOKKEEPING_FIELDS,
  HASH_META_FIELDS,
  parseCcjs,
  buildCcjs,
  type ScriptMetadata,
  type ParsedCcjs,
} from './metadata';

export { computeSyncHash, canonicalString } from './hash';

export { merge3, type Merge3Labels, type Merge3Result } from './merge';

export {
  parseBcSync,
  serializeBcSync,
  resolveBranchApp,
  parseBcSyncLocal,
  serializeBcSyncLocal,
  getOrCreateBranchState,
  upsertBranchScript,
  removeBranchScript,
  type BranchMapping,
  type BcSyncConfig,
  type ScriptSyncRecord,
  type BranchSyncState,
  type BcSyncLocal,
} from './bcsync';

export {
  classifyScript,
  classifyScripts,
  type SyncAction,
  type ScriptComparison,
  type ScriptStatus,
} from './sync';

export { buildImportZip, expandExportZip, type ZipScript } from './zip';

export { CcjsParseError, CcjsBuildError, BcSyncParseError } from './errors';
