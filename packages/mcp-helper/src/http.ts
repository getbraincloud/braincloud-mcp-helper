/**
 * Ticketed HTTP client for the brainCloud Builder API.
 *
 * The helper never authenticates on its own. Every call is driven by a {@link SyncTicket} the AI
 * obtained from the hosted braincloud-mcp's `getSyncTicket` tool — the helper just presents the
 * ticket's `authorization` header verbatim. A ticket is single-app-scoped and short-lived; the
 * helper refuses an expired one rather than make a doomed call.
 */

export interface SyncTicket {
  /** App-scoped Builder base, e.g. `https://host/builder/v1/team/<teamId>/app/<appId>`. */
  baseUrl: string;
  /** Full Authorization header value minted by the hosted MCP (e.g. `"Basic …"` / `"Bearer …"`). */
  authorization: string;
  /** App name — required by the bulk import endpoint. Supplied by the hosted MCP. */
  appName: string;
  /** ISO-8601 expiry. The helper refuses to use the ticket past this instant. */
  expiresAt?: string;
}

/** Bulk-import collision modes (Builder `BuilderImportMode`). */
export type ImportMode = 'addOnlyIgnoreDups' | 'addOnly' | 'addAndUpdateOnly' | 'fullSync';

export interface RemoteScript {
  scriptId: string;
  scriptName: string;
  /** Folder path, `''` for root. */
  folderPath: string;
  /** Logical path: `folderPath + '/' + scriptName` (or just `scriptName` at root). */
  path: string;
  version: number;
}

/** Minimal fetch shape so callers (and tests) can inject an implementation. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  fetch?: FetchLike;
}

/** List remote scripts (metadata only) for the cheap version-based diff. */
export async function listRemoteScripts(
  ticket: SyncTicket,
  options: HttpOptions = {}
): Promise<RemoteScript[]> {
  assertNotExpired(ticket);
  const fetchFn = options.fetch ?? globalThis.fetch;
  const res = await fetchFn(`${trimSlash(ticket.baseUrl)}/script?versionOnly=true`, {
    method: 'GET',
    headers: { Authorization: ticket.authorization },
  });
  const body = await readJson(res, 'GET /script');
  return parseRemoteScripts(body);
}

/** Push: POST a zip to the bulk-import endpoint. Returns the server's import summary. */
export async function importScriptsZip(
  ticket: SyncTicket,
  zip: Uint8Array,
  mode: ImportMode,
  options: HttpOptions = {}
): Promise<unknown> {
  assertNotExpired(ticket);
  const fetchFn = options.fetch ?? globalThis.fetch;

  const form = new FormData();
  form.append('appName', ticket.appName);
  form.append('mode', mode);
  form.append('path', '');
  form.append('file', new Blob([zip], { type: 'application/zip' }), 'scripts.zip');

  const res = await fetchFn(`${trimSlash(ticket.baseUrl)}/scripts`, {
    method: 'POST',
    headers: { Authorization: ticket.authorization },
    body: form,
  });
  return readJson(res, 'POST /scripts');
}

/** Pull: download the export zip for the whole app. */
export async function exportScriptsZip(
  ticket: SyncTicket,
  options: HttpOptions = {}
): Promise<Uint8Array> {
  assertNotExpired(ticket);
  const fetchFn = options.fetch ?? globalThis.fetch;
  const res = await fetchFn(`${trimSlash(ticket.baseUrl)}/script?export=true`, {
    method: 'GET',
    headers: { Authorization: ticket.authorization },
  });
  if (!res.ok) {
    throw new Error(`Builder API GET /script?export → ${res.status}: ${await safeText(res)}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

// --------------------------------------------------------------------------------------------
// internals
// --------------------------------------------------------------------------------------------

export function parseRemoteScripts(body: unknown): RemoteScript[] {
  const root = isObject(body) && isObject(body.response) ? body.response : body;
  const scripts = isObject(root) ? root.scripts : undefined;
  if (!Array.isArray(scripts)) {
    return [];
  }

  const out: RemoteScript[] = [];
  for (const entry of scripts) {
    if (!isObject(entry)) {
      continue;
    }
    const scriptId = String(entry.scriptId ?? '');
    const scriptName = String(entry.scriptName ?? '');
    const version = typeof entry.version === 'number' ? entry.version : Number(entry.version);
    if (!scriptId || !scriptName || Number.isNaN(version)) {
      continue;
    }
    const fullPath = typeof entry.scriptFullPath === 'string' ? entry.scriptFullPath : scriptName;
    const path = fullPath.replace(/^\/+|\/+$/g, '');
    const lastSlash = path.lastIndexOf('/');
    const folderPath = lastSlash === -1 ? '' : path.slice(0, lastSlash);
    out.push({ scriptId, scriptName, folderPath, path, version });
  }
  return out;
}

function assertNotExpired(ticket: SyncTicket): void {
  if (!ticket.expiresAt) {
    return;
  }
  const expiry = Date.parse(ticket.expiresAt);
  if (!Number.isNaN(expiry) && expiry <= Date.now()) {
    throw new Error(
      `Sync ticket expired at ${ticket.expiresAt}. Request a fresh ticket from the hosted MCP (getSyncTicket).`
    );
  }
}

async function readJson(res: Response, label: string): Promise<unknown> {
  if (!res.ok) {
    throw new Error(`Builder API ${label} → ${res.status}: ${await safeText(res)}`);
  }
  const text = await res.text();
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Builder API ${label}: response was not JSON: ${text.slice(0, 200)}`);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '<no body>';
  }
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
