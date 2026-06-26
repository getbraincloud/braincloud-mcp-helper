#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

/** Entry point: run the helper as a local stdio MCP server. */
async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The process stays alive on the stdio transport until the client disconnects.
}

main().catch((err) => {
  // stderr only — stdout is the MCP JSON-RPC channel and must not be polluted.
  console.error('braincloud-mcp-helper failed to start:', err);
  process.exit(1);
});
