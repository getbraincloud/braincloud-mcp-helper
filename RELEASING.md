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

## Internal dependency is pinned exact

`@braincloud/mcp-helper` pins `@braincloud/cloudsync-core` to the **exact** version
being released (not a `^` range), because a `^0.1.0` range does NOT match a prerelease
like `0.1.0-dev.0` — the `@dev` helper would fail to resolve core. So on every release,
bump **four** spots in lockstep:

1. `packages/cloudsync-core/package.json` → `version`
2. `packages/mcp-helper/package.json` → `version`
3. `packages/mcp-helper/package.json` → `dependencies["@braincloud/cloudsync-core"]` (exact)
4. `packages/mcp-helper/src/server.ts` → `HELPER_VERSION` (reported in the MCP `initialize`
   handshake and used for the hosted MCP's compatibility check — keep it equal to the package version)

Then run `npm install` so `package-lock.json` matches (the publish workflow's `npm ci` requires it).
