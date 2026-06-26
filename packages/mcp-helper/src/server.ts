import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { currentBranch } from './state.js';
import { pull, push, syncStatus, type SyncOptions } from './operations.js';
import type { SyncTicket } from './http.js';

export const HELPER_VERSION = '0.1.0';

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
  .describe('Absolute path to the local cloud-code sync folder (the .ccjs tree + .bcsync).');
const branchField = z
  .string()
  .optional()
  .describe('Git branch to sync. Defaults to the current branch resolved from .git/HEAD.');

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
      inputSchema: { rootDir: rootDirField, ticket: ticketSchema, branch: branchField },
    },
    guard(async ({ rootDir, ticket, branch }) => {
      const resolvedBranch = await resolveBranch(rootDir, branch);
      const plan = await syncStatus(rootDir, ticket as SyncTicket, resolvedBranch);
      return { branch: resolvedBranch, plan };
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
        allowDeletes: z
          .boolean()
          .optional()
          .describe('Delete local files for scripts removed on brainCloud (default false).'),
      },
    },
    guard(async ({ rootDir, ticket, branch, allowDeletes }) => {
      const resolvedBranch = await resolveBranch(rootDir, branch);
      const options: SyncOptions = { allowDeletes: allowDeletes ?? false };
      const result = await pull(rootDir, ticket as SyncTicket, resolvedBranch, options);
      return { branch: resolvedBranch, ...result };
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
      inputSchema: { rootDir: rootDirField, ticket: ticketSchema, branch: branchField },
    },
    guard(async ({ rootDir, ticket, branch }) => {
      const resolvedBranch = await resolveBranch(rootDir, branch);
      const result = await push(rootDir, ticket as SyncTicket, resolvedBranch);
      return { branch: resolvedBranch, ...result };
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
  const branch = await currentBranch(rootDir);
  if (!branch) {
    throw new Error(
      'Could not determine the git branch (detached HEAD or not a git repo). Pass "branch" explicitly.'
    );
  }
  return branch;
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
