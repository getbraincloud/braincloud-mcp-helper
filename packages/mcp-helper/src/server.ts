import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { currentBranch, resolveSyncRoot } from './state.js';
import { pull, push, sync, syncStatus, type SyncOptions } from './operations.js';
import type { SyncTicket } from './http.js';

export const HELPER_VERSION = '0.3.0-dev.1';

/**
 * The sync ticket, as vended by the hosted braincloud-mcp's `getSyncTicket` tool. The helper
 * never mints this itself — the AI obtains it from the hosted MCP and passes it through.
 */
const ticketSchema = z
  .object({
    baseUrl: z.string().describe('App-scoped Builder base URL (from getSyncTicket).'),
    authorization: z.string().describe('Authorization header value (from getSyncTicket).'),
    appName: z.string().describe('Target app name (from getSyncTicket).'),
    expiresAt: z.string().optional().describe('ISO-8601 ticket expiry (from getSyncTicket).'),
  })
  .describe('Short-lived ticket from the hosted MCP getSyncTicket tool.');

const rootDirField = z
  .string()
  .optional()
  .describe(
    'Absolute path to the local cloud-code sync folder (the .ccjs tree + .bcsync). Optional: if ' +
      'omitted, the helper discovers the nearest .bcsync folder at or above its working directory. ' +
      'Pass it explicitly for a brand-new folder, before its first sync.'
  );
const branchField = z
  .string()
  .optional()
  .describe(
    'Git branch to sync. Defaults to the current branch from .git/HEAD; if the folder is not a ' +
      'git repo, a reserved no-branch key is used and can later be adopted onto a real branch.'
  );
const adoptNoGitBranchField = z
  .boolean()
  .optional()
  .describe(
    'Confirm moving the no-git sync state and app mapping onto the current git branch (dropping ' +
      'the no-branch entry). Needed once, when a folder first synced without git is now on a real ' +
      'branch; the tool asks for it rather than orphaning the prior state.'
  );
const confirmAppNameField = z
  .string()
  .optional()
  .describe(
    "Safety confirmation. Only needed for a previously-synced folder that has no committed " +
      ".bcsync app mapping (e.g. synced by an older helper): set this to the ticket's appName to " +
      "confirm you intend to sync this folder with that app. Once .bcsync exists it is not needed."
  );

/** Build the configured helper MCP server (transport-agnostic; the CLI attaches stdio). */
export function createServer(): McpServer {
  const server = new McpServer({ name: 'braincloud-mcp-helper', version: HELPER_VERSION });

  server.registerTool(
    'status',
    {
      title: 'Cloud-code sync status',
      description:
        'Dry-run: classify every cloud-code script for the branch (in-sync / pull / push / ' +
        'conflict / pull-new / push-new / delete-local / delete-remote). Always safe — no writes. ' +
        'Use a "read" ticket from getSyncTicket.',
      inputSchema: {
        rootDir: rootDirField,
        ticket: ticketSchema,
        branch: branchField,
        confirmAppName: confirmAppNameField,
        adoptNoGitBranch: adoptNoGitBranchField,
      },
    },
    guard(async ({ rootDir, ticket, branch, confirmAppName, adoptNoGitBranch }) => {
      const root = await resolveSyncRoot(rootDir);
      const resolvedBranch = await resolveBranch(root, branch);
      const plan = await syncStatus(root, ticket as SyncTicket, resolvedBranch, {
        confirmAppName,
        adoptNoGitBranch,
      });
      return { rootDir: root, branch: resolvedBranch, plan };
    })
  );

  server.registerTool(
    'pull',
    {
      title: 'Pull cloud-code to local',
      description:
        'Apply brainCloud → local for non-conflicting changes (pull / pull-new). Conflicts and ' +
        'local-only changes are left untouched and reported in "skipped". Local deletes only happen ' +
        'with allowDeletes=true. Use a "read" ticket from getSyncTicket.',
      inputSchema: {
        rootDir: rootDirField,
        ticket: ticketSchema,
        branch: branchField,
        confirmAppName: confirmAppNameField,
        adoptNoGitBranch: adoptNoGitBranchField,
        allowDeletes: z
          .boolean()
          .optional()
          .describe('Delete local files for scripts removed on brainCloud (default false).'),
      },
    },
    guard(async ({ rootDir, ticket, branch, allowDeletes, confirmAppName, adoptNoGitBranch }) => {
      const root = await resolveSyncRoot(rootDir);
      const resolvedBranch = await resolveBranch(root, branch);
      const options: SyncOptions = { allowDeletes: allowDeletes ?? false, confirmAppName, adoptNoGitBranch };
      const result = await pull(root, ticket as SyncTicket, resolvedBranch, options);
      return { rootDir: root, branch: resolvedBranch, ...result };
    })
  );

  server.registerTool(
    'push',
    {
      title: 'Push local cloud-code to brainCloud',
      description:
        'Apply local → brainCloud for non-conflicting changes (push / push-new) via one bulk ' +
        'import (mode addAndUpdateOnly — never deletes). Conflicts and remote-only changes are left ' +
        'untouched and reported in "skipped". Requires a "write" ticket from getSyncTicket (the ' +
        'hosted MCP refuses a write ticket for a live-locked app).',
      inputSchema: {
        rootDir: rootDirField,
        ticket: ticketSchema,
        branch: branchField,
        confirmAppName: confirmAppNameField,
        adoptNoGitBranch: adoptNoGitBranchField,
      },
    },
    guard(async ({ rootDir, ticket, branch, confirmAppName, adoptNoGitBranch }) => {
      const root = await resolveSyncRoot(rootDir);
      const resolvedBranch = await resolveBranch(root, branch);
      const result = await push(root, ticket as SyncTicket, resolvedBranch, { confirmAppName, adoptNoGitBranch });
      return { rootDir: root, branch: resolvedBranch, ...result };
    })
  );

  server.registerTool(
    'sync',
    {
      title: 'Two-way sync cloud-code with brainCloud',
      description:
        'Full bidirectional sync for the branch: pulls non-conflicting remote changes, pushes ' +
        'non-conflicting local changes, and 3-way-merges scripts changed on BOTH sides (using ' +
        'brainCloud version history for the merge base). Cleanly-merged scripts are written locally ' +
        'and pushed; genuine conflicts get git-style <<<<<<< markers written into the file and are ' +
        'reported in "conflicted" for you to resolve, then re-run sync. Deletions (delete-local / ' +
        'delete-remote) are applied only when allowDeletes=true. Requires a "write" ticket from ' +
        'getSyncTicket (refused for a live-locked app).',
      inputSchema: {
        rootDir: rootDirField,
        ticket: ticketSchema,
        branch: branchField,
        confirmAppName: confirmAppNameField,
        adoptNoGitBranch: adoptNoGitBranchField,
        allowDeletes: z
          .boolean()
          .optional()
          .describe('Apply deletions in both directions (default false).'),
      },
    },
    guard(async ({ rootDir, ticket, branch, allowDeletes, confirmAppName, adoptNoGitBranch }) => {
      const root = await resolveSyncRoot(rootDir);
      const resolvedBranch = await resolveBranch(root, branch);
      const options: SyncOptions = { allowDeletes: allowDeletes ?? false, confirmAppName, adoptNoGitBranch };
      const result = await sync(root, ticket as SyncTicket, resolvedBranch, options);
      return { rootDir: root, branch: resolvedBranch, ...result };
    })
  );

  return server;
}

// --------------------------------------------------------------------------------------------
// internals
// --------------------------------------------------------------------------------------------

async function resolveBranch(rootDir: string, provided?: string): Promise<string> {
  if (provided && provided.trim()) {
    return provided.trim();
  }
  // No explicit branch: use the git branch if there is one, else the reserved no-git ("") key.
  // "" can never be a real branch name, so it never collides; it can later be adopted onto a
  // real branch (see maybeMigrateNoGit) once the folder becomes a git repo.
  return (await currentBranch(rootDir)) ?? '';
}

/** Wrap a handler so its return value is serialised, and errors become an MCP error result. */
function guard<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      const data = await fn(args);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  };
}
