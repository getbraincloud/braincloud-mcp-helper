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
| `sync` | write | Full two-way sync: pull + push + **3-way merge** for scripts changed on both sides (merge base recovered from brainCloud version history). Clean merges are applied + pushed; real conflicts get git-style `<<<<<<<` markers written locally and reported in `conflicted`. Deletes both ways only with `allowDeletes`. |

All take `rootDir` (the local sync folder), `ticket` (from `getSyncTicket`), and an optional
`branch` (defaults to the current git branch from `.git/HEAD`). `pull`/`status` work with a `read`
ticket; `push`/`sync` need a `write` ticket. In `pull`/`push`, conflicts and opposite-direction
changes are never auto-applied — only `sync` reconciles both directions and merges.

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
