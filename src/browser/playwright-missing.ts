/**
 * Shared Playwright-availability detection, install-command resolution, and
 * launch-failure decoration.
 *
 * This module is the single source of truth for "Playwright (or its chromium
 * binary) is missing" messaging. It lives under `src/browser/` rather than
 * `src/agent/tools/handlers/` so the low-level launcher can use it without
 * importing upward into the tool layer.
 *
 * History: the chromium-missing hint was originally centralized in
 * `src/agent/tools/handlers/playwright-hints.ts` and wired into each
 * `browser_*` handler's provider-CONSTRUCTION catch. But constructing a
 * provider never launches chromium — the launch happens later, inside
 * `BrowserLauncher.ensureBrowser()` — so a real launch failure surfaced in the
 * provider-METHOD catch, which had no hint check. The hint was structurally
 * unreachable for the exact failure it was written for (issue #721), and a
 * second hand-rolled copy had already drifted into `web-scrape.ts`. The fix
 * decorates the error at the single launch site instead of at ten catch
 * blocks, so every current and future browser consumer inherits it.
 *
 * @module browser/playwright-missing
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * Substrings in a thrown error message that indicate the Playwright package —
 * or its chromium browser binary — is unavailable.
 */
export const PLAYWRIGHT_MISSING_HINTS = [
  'Cannot find package',
  'ERR_MODULE_NOT_FOUND',
  "Executable doesn't exist",
] as const;

/** Fallback when the bundled Playwright CLI cannot be located (see `playwrightInstallCommand`). */
const STATIC_INSTALL_COMMAND = 'pnpm exec playwright install chromium';

/** Depth limit when walking `error.cause` — guards against a self-referential chain. */
const MAX_CAUSE_DEPTH = 4;

/**
 * Flatten an error (or bare string) into searchable text, following the
 * `cause` chain.
 *
 * Contract: accepts `unknown` so callers may pass either a raw thrown value or
 * an already-stringified message. Playwright's launch failure is frequently
 * re-thrown wrapped by an intermediate layer, which puts the diagnostic
 * substring on a `cause` rather than the top-level `message` — matching only
 * against `message` silently misses those.
 */
function flattenErrorText(err: unknown): string {
  if (typeof err === 'string') return err;

  const messages: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < MAX_CAUSE_DEPTH && cur instanceof Error; i++) {
    messages.push(cur.message);
    cur = (cur as Error & { cause?: unknown }).cause;
  }

  return messages.length > 0 ? messages.join(' | ') : String(err);
}

/**
 * True when `err` indicates Playwright (the package or its chromium binary) is
 * missing. Accepts a thrown value or a pre-stringified message.
 */
export function isPlaywrightMissing(err: unknown): boolean {
  const text = flattenErrorText(err);
  return PLAYWRIGHT_MISSING_HINTS.some((hint) => text.includes(hint));
}

// Resolution touches the filesystem, so memoize it — the hint can be built on
// any number of failed launches.
let cachedInstallCommand: string | undefined;

/**
 * Resolve the absolute path of the *bundled* Playwright CLI and return a
 * runnable install command for it.
 *
 * Invariant: resolution goes through `playwright/package.json`, never
 * `playwright/cli.js`. Playwright's `exports` map is a closed allowlist that
 * publishes `.`, `./package.json`, and specific `./lib/*` subpaths — it does
 * NOT publish `./cli.js` and has no wildcard fallback. A deep resolve of
 * `playwright/cli.js` therefore throws `ERR_PACKAGE_PATH_NOT_EXPORTED`
 * (verified against playwright 1.60.0). `./package.json` IS exported, so
 * resolving it and joining its own `bin` value reaches the CLI without
 * violating the allowlist.
 *
 * Why the bundled CLI and not `npx playwright install`: `npx --yes` resolves
 * the LATEST playwright, whose pinned chromium revision may differ from the
 * revision this build expects. That mismatch is what produced the original
 * incident — a browser cache holding `chromium_headless_shell-<rev>` but no
 * `chromium-<rev>`. Invoking the bundled CLI cannot version-skew.
 *
 * Returns `undefined` if anything is unresolvable, so callers fall back to a
 * static string rather than throwing. This code runs *inside an error path*,
 * where a secondary throw would replace an actionable message with a crash.
 */
function resolveBundledInstallCommand(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    const pkgJsonPath = req.resolve('playwright/package.json');

    const parsed: unknown = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;

    const bin = (parsed as { bin?: unknown }).bin;
    const relative =
      typeof bin === 'string'
        ? bin
        : typeof bin === 'object' && bin !== null
          ? (bin as Record<string, unknown>)['playwright']
          : undefined;
    if (typeof relative !== 'string' || relative.length === 0) return undefined;

    const cli = join(dirname(pkgJsonPath), relative);
    if (!existsSync(cli)) return undefined;

    // Quote defensively: a global install can sit under a path with spaces.
    const arg = /\s/.test(cli) ? `"${cli}"` : cli;
    return `node ${arg} install chromium`;
  } catch {
    return undefined;
  }
}

/**
 * The install command to advertise, preferring the bundled Playwright CLI and
 * degrading to `pnpm exec playwright install chromium` when it cannot be found.
 */
export function playwrightInstallCommand(): string {
  cachedInstallCommand ??= resolveBundledInstallCommand() ?? STATIC_INSTALL_COMMAND;
  return cachedInstallCommand;
}

/** Test-only: drop the memoized command so a test can exercise resolution again. */
export function resetPlaywrightInstallCommandCache(): void {
  cachedInstallCommand = undefined;
}

/**
 * True when `text` already carries an install remediation.
 *
 * Callers that append their own hint to an error message must check this first:
 * `BrowserLauncher` decorates a chromium-missing launch failure at its source,
 * so by the time an outer layer sees the message the remediation may already be
 * present. Appending unconditionally double-prints it.
 */
export function hasPlaywrightInstallHint(text: string): boolean {
  return text.includes('install chromium');
}

/** Which chromium artifact a launch needed. Headed and headless use different downloads. */
export interface PlaywrightHintOptions {
  /**
   * The `headless` value the failed launch requested. When supplied, the hint
   * names the specific missing artifact — headed needs the full `chromium-*`
   * build, headless only needs `chromium_headless_shell-*`, and a cache that
   * satisfies one does NOT satisfy the other.
   */
  headless?: boolean;
}

/**
 * Returns the install hint appropriate to which half of the dependency is
 * absent. Assumes `isPlaywrightMissing(err)` already returned true.
 */
export function playwrightMissingHint(err: unknown, opts?: PlaywrightHintOptions): string {
  const text = flattenErrorText(err);

  if (text.includes("Executable doesn't exist")) {
    // Package is installed; the chromium browser binary was never downloaded.
    let artifactNote = '';
    if (opts?.headless === true) {
      artifactNote =
        ' This launch was headless, which needs the `chromium_headless_shell-*` build.';
    } else if (opts?.headless === false) {
      artifactNote =
        ' This launch was headed, which needs the full `chromium-*` build — ' +
        'the headless shell alone does not satisfy it.';
    }
    return (
      'browser tools require the Playwright chromium binary. ' +
      `Install via: ${playwrightInstallCommand()}.${artifactNote}`
    );
  }

  // The `playwright` package itself is not installed.
  return (
    'browser tools require the optional `playwright` peer dependency. ' +
    `Install via: pnpm add playwright (then ${playwrightInstallCommand()}). ` +
    'Or pick a different tool.'
  );
}

/**
 * Attach a remediation hint to a chromium launch failure, preserving the
 * original error as `cause`.
 *
 * Invariant: non-Playwright failures are returned by IDENTITY — the same object
 * reference, message untouched. Downstream consumers classify on the raw
 * message (`browserTimeoutFailureClass` matches `TimeoutError` / "Timeout Nms
 * exceeded") and the witness trace records it verbatim, so decorating
 * unconditionally would corrupt timeout classification and trace payloads.
 * Only a confirmed Playwright-missing error is ever rewritten.
 */
export function decoratePlaywrightLaunchError(err: unknown, headless: boolean): unknown {
  if (!isPlaywrightMissing(err)) return err;

  const base = err instanceof Error ? err.message : String(err);
  return new Error(`${base}\n\n${playwrightMissingHint(err, { headless })}`, { cause: err });
}
