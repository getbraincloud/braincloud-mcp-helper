# @braincloud/mcp-helper

A **local stdio MCP server** that gives AI clients (Claude Code, Cursor, Codex, …) filesystem
access for brainCloud cloud-code sync.

It is deliberately **trustless**: it never authenticates to brainCloud on its own and stores no
credential. Every Builder API call is driven by a short-lived, app-scoped **ticket** the AI obtains
from the hosted `braincloud-mcp`'s `getSyncTicket` tool and passes in. Bulk script data flows
helper → Builder API directly — never through the AI's context.

Format and sync logic come from [`@braincloud/cloudsync-core`](../cloudsync-core); this package is
the Node filesystem + MCP shell around it.

## Tools

| Tool | Ticket | What it does |
|------|--------|--------------|
| `status` | read | Dry-run: classify every script (in-sync / pull / push / conflict / new / delete). No writes. |
| `pull` | read | Apply brainCloud → local for non-conflicting changes. Local deletes only with `allowDeletes`. |
| `push` | write | Apply local → brainCloud for non-conflicting changes via one bulk import (`addAndUpdateOnly`). |

All three take `rootDir` (the local sync folder), `ticket` (from `getSyncTicket`), and an optional
`branch` (defaults to the current git branch from `.git/HEAD`). Conflicts and changes in the other
direction are never auto-applied — they're reported in the result for the AI/developer to resolve.

## Configure as an MCP server

```jsonc
{
  "mcpServers": {
    "braincloud-helper": {
      "command": "npx",
      "args": ["-y", "@braincloud/mcp-helper@latest"]
    }
  }
}
```

`npx @latest` keeps the helper current on each launch; pin a version for CI. Pair it with the hosted
`braincloud-mcp` (which vends the tickets and runs the live-lock policy).

## Develop

```bash
npm install
npm run build --workspace @braincloud/cloudsync-core   # helper depends on the built core
npm test  --workspace @braincloud/mcp-helper
npm run build --workspace @braincloud/mcp-helper
```
