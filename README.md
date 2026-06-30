# braincloud-mcp-helper

A local, trustless MCP server that lets AI coding assistants (Claude Code, Cursor, Codex, …) sync
brainCloud cloud-code scripts to and from your filesystem and git repo.

It never authenticates to brainCloud on its own and stores no credentials. Every Builder API call
is driven by a short-lived, app-scoped **ticket** that the AI obtains from the hosted
`braincloud-mcp`'s `getSyncTicket` tool and passes in — script content flows helper → Builder API
directly, never through the AI's context.

## Packages

This is an npm workspace with two packages:

| Package | What it is |
|---|---|
| [`@braincloud/mcp-helper`](packages/mcp-helper) | The MCP server itself — `status` / `pull` / `push` / `sync` tools, installable via `npx -y @braincloud/mcp-helper@latest`. |
| [`@braincloud/cloudsync-core`](packages/cloudsync-core) | Host-agnostic sync/format logic (the `.ccjs` / `.bcsync` / `.bcsync.local` on-disk contract) shared with the VS Code extension. |

See each package's README for tool details, configuration, and the on-disk format.

## Learn more

Full setup and usage guide: [Syncing cloud code to local files with the brainCloud MCP helper](https://help.getbraincloud.com/en/articles/15695153-syncing-cloud-code-to-local-files-with-the-braincloud-mcp-helper)

## Develop

```bash
npm install
npm run build   # builds all workspaces
npm test        # tests all workspaces
```

See [RELEASING.md](RELEASING.md) for the release process.
