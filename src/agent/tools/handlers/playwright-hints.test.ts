import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  PLAYWRIGHT_MISSING_HINTS,
  browserTimeoutFailureClass,
  decoratePlaywrightLaunchError,
  isPlaywrightMissing,
  playwrightInstallCommand,
  playwrightMissingHint,
  resetPlaywrightInstallCommandCache,
} from './playwright-hints.js';

describe('isPlaywrightMissing', () => {
  it('matches the package-not-installed signatures', () => {
    expect(isPlaywrightMissing('Cannot find package playwright')).toBe(true);
    expect(isPlaywrightMissing('Error [ERR_MODULE_NOT_FOUND]: ...')).toBe(true);
  });

  it("matches the chromium-binary-missing signature", () => {
    expect(
      isPlaywrightMissing("browserType.launch: Executable doesn't exist at /path/chrome"),
    ).toBe(true);
  });

  it('does not match unrelated provider errors', () => {
    expect(isPlaywrightMissing('provider init failed')).toBe(false);
    expect(isPlaywrightMissing('net::ERR_NAME_NOT_RESOLVED')).toBe(false);
  });

  it('follows the cause chain, so a wrapped launch failure still matches', () => {
    // A launch failure is often re-thrown wrapped by an intermediate layer,
    // putting the diagnostic substring on `cause` rather than `message`. The
    // pre-#721 shared detector took a pre-stringified message and missed these.
    const root = new Error("browserType.launch: Executable doesn't exist at /x/chrome");
    const wrapped = new Error('failed to open page', { cause: root });
    expect(isPlaywrightMissing(wrapped)).toBe(true);
    expect(isPlaywrightMissing(new Error('unrelated', { cause: new Error('also unrelated') }))).toBe(
      false,
    );
  });

  it('accepts an Error as well as a bare string', () => {
    expect(isPlaywrightMissing(new Error('Cannot find package playwright'))).toBe(true);
  });

  it('exposes all three hint substrings', () => {
    expect(PLAYWRIGHT_MISSING_HINTS).toContain('Cannot find package');
    expect(PLAYWRIGHT_MISSING_HINTS).toContain('ERR_MODULE_NOT_FOUND');
    expect(PLAYWRIGHT_MISSING_HINTS).toContain("Executable doesn't exist");
  });
});

describe('playwrightMissingHint', () => {
  it('tells the user to install the package when it is absent', () => {
    const hint = playwrightMissingHint('Cannot find package playwright');
    expect(hint).toMatch(/pnpm add playwright/);
  });

  it('tells the user to install chromium when only the binary is missing', () => {
    const hint = playwrightMissingHint("Executable doesn't exist at /ms-playwright/chromium/chrome");
    expect(hint).toMatch(/install chromium/);
    // Must NOT mis-direct the user to reinstall a package that is already present.
    expect(hint).not.toMatch(/pnpm add playwright/);
  });

  it('includes a "Do NOT use npx" warning in the chromium-missing hint text (issue #1998)', () => {
    // The hint explicitly calls out `npx playwright install chromium` as the command
    // to AVOID, so users know why we emit a different command. npx resolves LATEST
    // playwright whose pinned chromium revision can differ from this build's.
    const hint = playwrightMissingHint("Executable doesn't exist at /ms-playwright/chromium/chrome");
    expect(hint).toMatch(/npx playwright install chromium/);
    expect(hint).toMatch(/Do NOT use/);
  });

  it('includes a "Do NOT use npx" warning in the package-missing hint text (issue #1998)', () => {
    // Same rationale: name the forbidden command so users understand the version-skew risk.
    const hint = playwrightMissingHint('Cannot find package playwright');
    expect(hint).toMatch(/npx playwright install chromium/);
    expect(hint).toMatch(/Do NOT use/);
  });
});

// ---------------------------------------------------------------------------
// Latch reset advice (issue #722 review follow-up)
//
// Naming the install command without naming the reset is an incomplete
// remediation: a caller that installs chromium and retries `browser_open`
// fast-fails on the identical latched error forever. The advice is opt-in
// because non-latching callers exist (`afk browser login` launches chromium
// directly, and the `browser_close` handler would be told to call itself).
// ---------------------------------------------------------------------------

describe('playwrightMissingHint — latch reset advice', () => {
  const EXEC_MISSING = "Executable doesn't exist at /ms-playwright/chromium/chrome";

  it('names the browser_close reset when the caller latched the failure', () => {
    const hint = playwrightMissingHint(EXEC_MISSING, { headless: false, latched: true });
    expect(hint).toMatch(/install chromium/);
    expect(hint).toMatch(/call browser_close once to retry/);
  });

  it('OMITS the reset advice by default, so non-latching callers are not misled', () => {
    // `afk browser login` and the per-operation handler catches reach this hint
    // with no latch in play; telling them to call browser_close would be wrong.
    expect(playwrightMissingHint(EXEC_MISSING, { headless: false })).not.toMatch(/browser_close/);
    expect(playwrightMissingHint(EXEC_MISSING)).not.toMatch(/browser_close/);
    expect(playwrightMissingHint(EXEC_MISSING, { headless: false, latched: false })).not.toMatch(
      /browser_close/,
    );
  });

  it('also names the reset on the package-missing branch, which latches too', () => {
    const hint = playwrightMissingHint('Cannot find package playwright', { latched: true });
    expect(hint).toMatch(/pnpm add playwright/);
    expect(hint).toMatch(/call browser_close once to retry/);
  });

  it('decoratePlaywrightLaunchError defaults to NOT latched', () => {
    const err = decoratePlaywrightLaunchError(new Error(EXEC_MISSING), false);
    expect((err as Error).message).toMatch(/install chromium/);
    expect((err as Error).message).not.toMatch(/browser_close/);
  });

  it('decoratePlaywrightLaunchError adds the reset when told the caller latches', () => {
    const err = decoratePlaywrightLaunchError(new Error(EXEC_MISSING), false, true);
    expect((err as Error).message).toMatch(/call browser_close once to retry/);
  });
});

// ---------------------------------------------------------------------------
// Install-command resolution (issue #721)
// ---------------------------------------------------------------------------

describe('playwrightInstallCommand', () => {
  beforeEach(() => {
    resetPlaywrightInstallCommandCache();
  });

  it('resolves the BUNDLED playwright CLI, not a package-manager-relative command', () => {
    const cmd = playwrightInstallCommand();
    expect(cmd).toMatch(/install chromium$/);

    // `playwright` is a real dependency of this repo, so resolution must
    // succeed here and yield an absolute path to the bundled CLI. A
    // `pnpm exec`-style command would be wrong for a global install, and
    // `npx --yes playwright` would fetch LATEST playwright — whose pinned
    // chromium revision can differ from the one this build expects (issue #1998).
    //
    // Command format: `PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=<ms> node <cli> install chromium`
    const m = /^PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=\d+ node (?:"([^"]+)"|(\S+)) install chromium$/.exec(cmd);
    expect(m, `expected a bundled-CLI command with timeout prefix, got: ${cmd}`).not.toBeNull();
    const cliPath = m?.[1] ?? m?.[2] ?? '';
    expect(isAbsolute(cliPath)).toBe(true);
    expect(existsSync(cliPath)).toBe(true);
    expect(cliPath).toMatch(/cli\.js$/);
  });

  it('prefixes the command with PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT (issue #1998)', () => {
    // Playwright's default download timeout is 30 s — too short for the ~200 MB
    // chromium binary on slow connections. The advertised command must override it.
    const cmd = playwrightInstallCommand();
    expect(cmd).toMatch(/^PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=\d+/);
    const ms = Number(/PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=(\d+)/.exec(cmd)?.[1]);
    expect(ms).toBeGreaterThanOrEqual(120_000);
  });

  it('does NOT include npx in the install command (issue #1998 — version skew)', () => {
    // `npx playwright install` resolves LATEST playwright, whose pinned chromium
    // revision can differ from what this build expects.
    expect(playwrightInstallCommand()).not.toMatch(/npx/);
  });

  it('memoizes the resolved command', () => {
    expect(playwrightInstallCommand()).toBe(playwrightInstallCommand());
  });
});

// ---------------------------------------------------------------------------
// Windows / PowerShell env-prefix syntax (issue #2758)
//
// The POSIX `VAR=value cmd` inline-prefix form is not valid PowerShell.
// On win32 the install command must use `$env:VAR=value; cmd` instead.
// Tests inject `platform` so they run portably on macOS/Linux CI without
// a real Windows host (POSIX-guard convention: never skip on win32, make
// tests portable by injecting platform).
// ---------------------------------------------------------------------------

describe('playwrightInstallCommand — Windows PowerShell syntax (issue #2758)', () => {
  beforeEach(() => {
    resetPlaywrightInstallCommandCache();
  });

  it('uses POSIX VAR=value prefix on non-win32', () => {
    const cmd = playwrightInstallCommand('linux');
    // Must start with the bare env-var name (POSIX inline-prefix form).
    expect(cmd).toMatch(/^PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=\d+/);
    // Must NOT use PowerShell $env: syntax on POSIX.
    expect(cmd).not.toMatch(/\$env:/);
  });

  it('uses PowerShell $env: prefix on win32', () => {
    const cmd = playwrightInstallCommand('win32');
    // Must use the PowerShell assignment form, NOT the bare `VAR=value` prefix.
    expect(cmd).toMatch(/^\$env:PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=\d+;/);
    // Must NOT use the POSIX inline-prefix form (no bare `VAR=` at the start).
    expect(cmd).not.toMatch(/^PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=/);
  });

  it('win32 command still sets the timeout to >= 120000 ms', () => {
    const cmd = playwrightInstallCommand('win32');
    const ms = Number(/PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=(\d+)/.exec(cmd)?.[1]);
    expect(ms).toBeGreaterThanOrEqual(120_000);
  });

  it('win32 command still ends with "install chromium"', () => {
    expect(playwrightInstallCommand('win32')).toMatch(/install chromium$/);
  });

  it('win32 command does NOT include npx (issue #1998)', () => {
    expect(playwrightInstallCommand('win32')).not.toMatch(/npx/);
  });

  it('memoizes per-platform so win32 and linux produce independent cached values', () => {
    const linux = playwrightInstallCommand('linux');
    const win32 = playwrightInstallCommand('win32');
    // Same call twice returns the cached string by identity.
    expect(playwrightInstallCommand('linux')).toBe(linux);
    expect(playwrightInstallCommand('win32')).toBe(win32);
    // The two platforms produce syntactically different strings.
    expect(linux).not.toBe(win32);
  });
});

describe('playwrightMissingHint — Windows PowerShell syntax (issue #2758)', () => {
  const BIN_MISSING = "Executable doesn't exist at /ms-playwright/chromium/chrome";
  const PKG_MISSING = 'Cannot find package playwright';

  it('emits $env: prefix in the chromium-missing hint on win32', () => {
    const hint = playwrightMissingHint(BIN_MISSING, { platform: 'win32' });
    expect(hint).toMatch(/\$env:PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=\d+;/);
    expect(hint).not.toMatch(/^PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=/);
  });

  it('emits $env: prefix in the package-missing hint on win32', () => {
    const hint = playwrightMissingHint(PKG_MISSING, { platform: 'win32' });
    expect(hint).toMatch(/\$env:PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=\d+;/);
  });

  it('still emits POSIX prefix on linux', () => {
    const hint = playwrightMissingHint(BIN_MISSING, { platform: 'linux' });
    expect(hint).toMatch(/PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=\d+ node/);
    expect(hint).not.toMatch(/\$env:/);
  });

  it('win32 hint still contains "install chromium"', () => {
    const hint = playwrightMissingHint(BIN_MISSING, { platform: 'win32' });
    expect(hint).toMatch(/install chromium/);
  });

  it('win32 hint still contains the "Do NOT use npx" warning', () => {
    const hint = playwrightMissingHint(BIN_MISSING, { platform: 'win32' });
    expect(hint).toMatch(/Do NOT use/);
    expect(hint).toMatch(/npx playwright install chromium/);
  });

  it('decoratePlaywrightLaunchError emits PowerShell syntax on win32', () => {
    const original = new Error(BIN_MISSING);
    const decorated = decoratePlaywrightLaunchError(original, false, false, 'win32');
    expect(decorated).toBeInstanceOf(Error);
    const msg = (decorated as Error).message;
    expect(msg).toMatch(/\$env:PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=\d+;/);
    expect(msg).not.toMatch(/^PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=/);
  });
});

// ---------------------------------------------------------------------------
// Headed vs headless artifact naming (issue #721)
// ---------------------------------------------------------------------------

describe('playwrightMissingHint — missing-artifact naming', () => {
  const BIN_MISSING =
    "browserType.launch: Executable doesn't exist at /ms-playwright/chromium-1234/chrome";

  it('names the full chromium build when the failed launch was headed', () => {
    const hint = playwrightMissingHint(BIN_MISSING, { headless: false });
    expect(hint).toMatch(/headed/);
    expect(hint).toMatch(/chromium-\*/);
    expect(hint).not.toMatch(/chromium_headless_shell/);
  });

  it('names the headless shell when the failed launch was headless', () => {
    const hint = playwrightMissingHint(BIN_MISSING, { headless: true });
    expect(hint).toMatch(/chromium_headless_shell-\*/);
  });

  it('omits artifact detail when the launch mode is unknown', () => {
    const hint = playwrightMissingHint(BIN_MISSING);
    expect(hint).not.toMatch(/chromium_headless_shell/);
    expect(hint).not.toMatch(/headed/);
    expect(hint).toMatch(/install chromium/);
  });
});

// ---------------------------------------------------------------------------
// Launch-error decoration (issue #721)
// ---------------------------------------------------------------------------

describe('decoratePlaywrightLaunchError', () => {
  it('adds the hint and preserves the original error as cause', () => {
    const original = new Error(
      "browserType.launch: Executable doesn't exist at /ms-playwright/chromium-1234/chrome",
    );
    const decorated = decoratePlaywrightLaunchError(original, false);

    expect(decorated).toBeInstanceOf(Error);
    expect(decorated).not.toBe(original);
    const msg = (decorated as Error).message;
    expect(msg).toContain("Executable doesn't exist");
    expect(msg).toMatch(/install chromium/);
    expect(msg).toMatch(/chromium-\*/);
    expect((decorated as Error & { cause?: unknown }).cause).toBe(original);
  });

  it('returns a NON-playwright error by identity, message untouched', () => {
    // Invariant under test: downstream code classifies on the raw message
    // (timeout detection) and the witness trace records it verbatim, so
    // anything that is not a Playwright-missing error must pass through
    // completely unchanged — same object, same message.
    const timeout = new Error('page.goto: Timeout 30000ms exceeded.');
    timeout.name = 'TimeoutError';
    expect(decoratePlaywrightLaunchError(timeout, true)).toBe(timeout);
    expect(browserTimeoutFailureClass(decoratePlaywrightLaunchError(timeout, true))).toBe('timeout');

    const generic = new Error('browser crashed');
    expect(decoratePlaywrightLaunchError(generic, false)).toBe(generic);
    expect((generic as Error).message).toBe('browser crashed');
  });

  it('handles a non-Error thrown value without throwing', () => {
    expect(decoratePlaywrightLaunchError('a plain string', true)).toBe('a plain string');
    expect(decoratePlaywrightLaunchError(undefined, true)).toBeUndefined();
  });
});

describe('browserTimeoutFailureClass', () => {
  it("classifies a Playwright TimeoutError (by name) as 'timeout'", () => {
    const err = new Error('page.goto: Timeout 30000ms exceeded.');
    err.name = 'TimeoutError';
    expect(browserTimeoutFailureClass(err)).toBe('timeout');
  });

  it("classifies the timeout message shape as 'timeout' even without the name", () => {
    expect(browserTimeoutFailureClass(new Error('Timeout 30000ms exceeded.'))).toBe('timeout');
    expect(browserTimeoutFailureClass(new Error('locator.click: Timeout 5000 ms exceeded'))).toBe(
      'timeout',
    );
  });

  it('returns undefined for non-timeout errors (left unclassified → still a real failure)', () => {
    expect(browserTimeoutFailureClass(new Error('net::ERR_NAME_NOT_RESOLVED'))).toBeUndefined();
    expect(browserTimeoutFailureClass(new Error('boom'))).toBeUndefined();
    expect(browserTimeoutFailureClass('a plain string')).toBeUndefined();
    expect(browserTimeoutFailureClass(undefined)).toBeUndefined();
  });
});
