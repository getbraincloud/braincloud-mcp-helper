# Releasing

Two packages publish together to npm under the `@braincloud` scope:

- `@braincloud/cloudsync-core` — format + sync logic
- `@braincloud/mcp-helper` — the local MCP server (depends on core)

## Channels

npm **dist-tags** give two parallel, installable channels:

| Channel | Branch | dist-tag | Install |
|---------|--------|----------|---------|
| Stable  | `main` | `latest` | `npx braincloud-mcp-helper` |
| Preview | `develop` | `dev` | `npx braincloud-mcp-helper@dev` |

Both stay available at once; stable users never pick up a preview build.

## How a release happens

Publishing is automated by `.github/workflows/publish.yml` on a pushed version tag.
The tag's shape picks the dist-tag:

- `vX.Y.Z`        → published under **`latest`** (stable)
- `vX.Y.Z-dev.N`  → published under **`dev`** (preview)

### Stable release (from `main`)
1. Bump `version` in **both** package.json files to `X.Y.Z` (keep them in lockstep).
2. Merge `develop` → `main`.
3. `git tag vX.Y.Z && git push origin vX.Y.Z`

### Preview release (from `develop`)
1. Bump both versions to `X.Y.Z-dev.N` (e.g. `0.2.0-dev.0`).
2. `git tag vX.Y.Z-dev.N && git push origin vX.Y.Z-dev.N`

## One-time setup

- Add an **`NPM_TOKEN`** repo secret (an npm automation/granular token with publish rights to the `@braincloud` scope).
- Packages publish with **provenance** (`--provenance`), which requires this public GitHub repo + the workflow's `id-token: write` permission — it adds a verified supply-chain attestation on npmjs.com.

## Manual publish (fallback)

```bash
npm login
npm run build && npm test
npm publish -w @braincloud/cloudsync-core --access public            # latest
npm publish -w @braincloud/mcp-helper     --access public            # latest
# or preview:
npm publish -w @braincloud/cloudsync-core --access public --tag dev
npm publish -w @braincloud/mcp-helper     --access public --tag dev
```

> Keeping the two package versions in lockstep is manual for now; consider
> [changesets](https://github.com/changesets/changesets) if release volume grows.
