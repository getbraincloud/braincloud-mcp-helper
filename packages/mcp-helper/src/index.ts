/**
 * @braincloud/mcp-helper
 *
 * Local stdio MCP server that gives AI clients filesystem access for brainCloud cloud-code sync.
 * It never authenticates to brainCloud on its own — every Builder call is driven by a short-lived
 * ticket vended by the hosted braincloud-mcp (`getSyncTicket`). The CLI entry point is `cli.ts`;
 * the exports below allow programmatic embedding and testing.
 */
export { createServer, HELPER_VERSION } from './server.js';
export { syncStatus, pull, push, type SyncOptions, type PullResult, type PushResult } from './operations.js';
export {
  listRemoteScripts,
  importScriptsZip,
  exportScriptsZip,
  type SyncTicket,
  type ImportMode,
  type RemoteScript,
} from './http.js';
export { readScriptTree, writeScript, writeScriptTree, deleteScript } from './fs-tree.js';
export { readConfig, writeConfig, readLocalState, writeLocalState, currentBranch } from './state.js';
