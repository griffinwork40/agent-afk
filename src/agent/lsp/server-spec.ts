/**
 * Frozen cross-lane contract for #4272 (LSP auto-detect, auto-install,
 * persistent servers, refactor tools).
 *
 * Contract: this file is TYPES ONLY plus no runtime logic. Three work lanes
 * build against it in parallel and must not change it without coordination:
 *
 *   - Registry lane  (src/agent/lsp/registry*.ts) produces `ServerDefinition`s
 *     and implements `ResolveServerFn`.
 *   - Pool lane      (src/agent/lsp/client*.ts, pool*.ts) consumes a
 *     `ServerSpec` and owns the live server process + JSON-RPC connection.
 *   - Install lane   (src/agent/lsp/install*.ts) consumes a `ServerDefinition`
 *     whose `install` recipe is set and implements `EnsureInstalledFn`.
 *
 * Install locations come from `src/paths.lsp.ts`, never hand-joined.
 *
 * @module agent/lsp/server-spec
 */

/** Install recipe. v1 supports npm only (covers typescript-language-server and pyright). */
export interface NpmInstallRecipe {
  readonly kind: 'npm';
  /** Packages passed to `npm install --prefix <getLspLanguageInstallDir(language)>`. */
  readonly packages: readonly string[];
}

export type InstallRecipe = NpmInstallRecipe;

/**
 * Static registry entry: everything known about a language server before
 * anything is resolved on disk.
 */
export interface ServerDefinition {
  /** Lowercase registry key, e.g. 'typescript', 'python'. Also the install-dir key. */
  readonly language: string;
  /** File extension (with dot, lowercase) to LSP `languageId` for `didOpen`. */
  readonly languageIds: Readonly<Record<string, string>>;
  /** Files/dirs whose presence marks a workspace root for this language, nearest wins. */
  readonly rootMarkers: readonly string[];
  /** Executable name looked up in the AFK install dir, then on PATH. */
  readonly binName: string;
  /** Arguments for stdio mode, e.g. ['--stdio']. */
  readonly args: readonly string[];
  /** How to install when missing. Absent = AFK never installs this server. */
  readonly install?: InstallRecipe;
  /** Sent as `initializationOptions` in `initialize`. */
  readonly initializationOptions?: unknown;
  /**
   * Answer for server-to-client `workspace/configuration` requests, keyed by
   * section name. Missing sections are answered with `null`.
   */
  readonly settings?: Readonly<Record<string, unknown>>;
}

/** A definition resolved to a runnable command. This is what the pool spawns. */
export interface ServerSpec {
  readonly definition: ServerDefinition;
  /** Absolute path when found in the AFK install dir; bare name when found on PATH. */
  readonly command: string;
  readonly args: readonly string[];
  /** Where the command was found. 'override' = injected (tests, env). */
  readonly source: 'afk-install' | 'path' | 'override';
}

export type ResolveResult =
  /** Runnable server found; `root` is the workspace root for this file. */
  | { readonly kind: 'resolved'; readonly spec: ServerSpec; readonly root: string }
  /** Language known, server not installed anywhere. Caller may offer install. */
  | { readonly kind: 'missing'; readonly definition: ServerDefinition; readonly root: string }
  /** No registry entry handles this file. */
  | { readonly kind: 'unsupported' };

/**
 * Resolve the server for `filePath`. `sessionRoot` bounds the upward
 * root-marker walk (never walk above it); when no marker is found the root is
 * `sessionRoot` (or the file's directory if absent). Never throws.
 */
export type ResolveServerFn = (filePath: string, sessionRoot?: string) => Promise<ResolveResult>;

/** Who is asking, so install policy can refuse on unattended surfaces. */
export interface InstallContext {
  /** True for REPL / Telegram with a human reachable; false for daemon, cron, one-shot, subagents. */
  readonly interactive: boolean;
  /**
   * Ask the human to approve a first install. Resolve true to approve.
   * Absent or resolving false = declined. Never called when a grant already exists.
   */
  readonly askConsent?: (prompt: string) => Promise<boolean>;
  readonly signal?: AbortSignal;
}

export type EnsureInstalledResult =
  | { readonly kind: 'installed'; readonly command: string; readonly freshInstall: boolean }
  | { readonly kind: 'declined' }
  /** Unattended surface with no stored grant. */
  | { readonly kind: 'refused-unattended' }
  | { readonly kind: 'no-recipe' }
  | { readonly kind: 'failed'; readonly reason: string };

/** Install the server for `definition` if missing. Never throws. */
export type EnsureInstalledFn = (
  definition: ServerDefinition,
  ctx: InstallContext,
) => Promise<EnsureInstalledResult>;
