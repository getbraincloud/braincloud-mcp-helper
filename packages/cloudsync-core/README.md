# @braincloud/cloudsync-core

Host-agnostic format and sync logic for brainCloud cloud-code. Shared by the local helper MCP
(`@braincloud/mcp-helper`) and the VS Code extension (`braincloud-vscode-fsprovider`) so the
on-disk contract lives in exactly one place.

**No host dependencies** — no `vscode`, no MCP SDK. Pure data in, data out. File I/O and UI are
the consuming host's job.

## On-disk contract

- `.ccjs` — a script: its body followed by an optional brainCloud metadata comment block.
- `.bcsync` — committed, team-shared: maps each git branch to the brainCloud app it targets.
- `.bcsync.local` — gitignored, per-machine: last-synced version + content hash per script.

## API

### Metadata block (`.ccjs`)

```ts
import { parseCcjs, buildCcjs } from '@braincloud/cloudsync-core';

const { body, metadata, hasMetadataBlock } = parseCcjs(fileContent);
const fileContent = buildCcjs(body, { scriptName: 'doThing', clientCallable: true, scriptTimeout: 30 });
```

`buildCcjs` emits the server-exact marker, `scriptName` first (the server splits on it), no
trailing comma on the last line, and `scriptTimeout` (not `scriptTimeoutSecs`). `parseCcjs`
returns `{}` metadata for content-only files.

Field classes: `AUTHORITATIVE_FIELDS` (synced both ways), `BOOKKEEPING_FIELDS` (server-owned;
never authoritative on push), `HASH_META_FIELDS` (the subset that feeds change detection).

### Change detection

```ts
import { computeSyncHash } from '@braincloud/cloudsync-core';

const sha256 = computeSyncHash({ body, metadata });
```

Git-robust: line endings/trailing whitespace normalised; server bookkeeping
(`version`/`updatedAt`/…) and positional fields (`scriptName`/`folderPath`) excluded, so a plain
re-export, a checkout, or a rename/move is not mistaken for a content edit.

### Sync state

```ts
import { classifyScripts } from '@braincloud/cloudsync-core';

const statuses = classifyScripts({ local, base, remote });
// → [{ path, action, reason }], action ∈
//   in-sync | pull | push | pull-new | push-new | converged | conflict | delete-local | delete-remote
```

Cheap diff: remote-changed = `remote.version !== base.version`; local-changed =
`local.hash !== base.sha256`. Remote content is only needed to distinguish `conflict` from
`converged`.

### Config files

```ts
import { parseBcSync, resolveBranchApp, parseBcSyncLocal, upsertBranchScript } from '@braincloud/cloudsync-core';

const cfg = parseBcSync(text);
const app = resolveBranchApp(cfg, currentBranch); // undefined ⇒ caller must refuse, never guess
```

`upsertBranchScript` keeps the richer `scripts` map and the VS Code-compat `scriptVersions` map
consistent; unknown fields written by other tools are preserved on round-trip.

### Zip (bulk import / export)

```ts
import { buildImportZip, expandExportZip } from '@braincloud/cloudsync-core';

const zip = buildImportZip([{ path: 'utils/game/saveProgress', body, metadata }]); // → POST /scripts
const scripts = expandExportZip(downloadedZipBytes);                               // ← GET /script?export
```

Entries are named by full path (collision-free), but folder placement is driven by the
`folderPath` field written into each block — the server discards zip entry folder paths.

## Develop

```bash
npm install
npm test --workspace @braincloud/cloudsync-core
npm run build --workspace @braincloud/cloudsync-core
```
