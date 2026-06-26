/** Thrown when a `.ccjs` file's metadata comment block cannot be parsed. */
export class CcjsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CcjsParseError";
  }
}

/** Thrown when a `.ccjs` file cannot be built from a body + metadata (e.g. missing scriptName). */
export class CcjsBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CcjsBuildError";
  }
}

/** Thrown when a `.bcsync` / `.bcsync.local` file cannot be parsed or is structurally invalid. */
export class BcSyncParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BcSyncParseError";
  }
}
