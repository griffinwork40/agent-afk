/**
 * `afk browser` command group — give the agent web hands.
 *
 * Subcommands:
 *   afk browser connect      — wire Google's `chrome-devtools-mcp` (--autoConnect)
 *                              into ~/.afk/config/mcp.json + print setup steps
 *   afk browser disconnect   — remove the chrome-devtools server entry
 *   afk browser login <url>  — open a headed browser, let the human log in, and
 *                              save the session to a vault profile the agent's
 *                              native browser tools reuse across unattended runs
 *   afk browser profiles     — list saved session-vault profiles
 *
 * Why an MCP server and not a native browser provider:
 *   Driving the user's real, logged-in default Chrome profile is impossible via
 *   Playwright. Chrome 136+ refuses --remote-debugging-port on the default
 *   profile, and Chrome M144's sanctioned `--autoConnect` consent flow needs
 *   Puppeteer's `handleDevToolsAsPage` option, which Playwright lacks
 *   (microsoft/playwright#40027). Google's `chrome-devtools-mcp` vendors
 *   Puppeteer and implements exactly this flow, so we wire it in via the
 *   existing MCP client rather than reimplementing it. The agent then drives
 *   the real tab through `mcp__chrome-devtools__*` tools.
 *
 * Security model (intentionally human-gated — we cannot bypass it):
 *   The user must enable remote debugging once at chrome://inspect, then click
 *   "Allow" on a per-session prompt; Chrome shows a "being controlled" banner
 *   while active. This command only writes config + prints the steps.
 *
 * @module cli/commands/browser
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { randomBytes } from 'crypto';
import { createInterface } from 'node:readline';
import { palette } from '../palette.js';
import { handleCommandError } from '../errors/index.js';
import { getMcpConfigPath, type McpConfigFile } from '../../agent/mcp/config-loader.js';
import type { McpServerConfig } from '../../agent/mcp/types.js';
import {
  assertSafeBrowserProfile,
  getBrowserProfileStateDir,
  getBrowserStateRoot,
  getBrowserStorageStatePath,
} from '../../paths.js';

/**
 * Block until the operator presses Enter. Used by `login` to know the human has
 * finished authenticating before we capture the session. We capture from the
 * live context (the human must NOT close the window themselves).
 */
function waitForEnter(prompt: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<void>((resolve) => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

/** MCP server key written into mcpServers. Stable so connect/disconnect agree. */
export const CHROME_DEVTOOLS_SERVER_NAME = 'chrome-devtools';

const VALID_CHANNELS = ['stable', 'beta', 'canary', 'dev'] as const;
type ChromeChannel = (typeof VALID_CHANNELS)[number];

/**
 * Build the mcpServers entry for chrome-devtools-mcp.
 *
 * Always runs via `npx …@latest --autoConnect`. A non-stable channel is
 * appended as `--channel <channel>` so autoConnect attaches to that channel's
 * running profile (autoConnect targets the channel's default user-data-dir).
 */
export function buildChromeDevtoolsEntry(channel: ChromeChannel = 'stable'): McpServerConfig {
  const args = ['chrome-devtools-mcp@latest', '--autoConnect'];
  if (channel !== 'stable') {
    args.push('--channel', channel);
  }
  return { command: 'npx', args };
}

/**
 * Read + normalize the user-global mcp.json. Returns `{ mcpServers: {} }` when
 * absent. Throws a clear error on malformed JSON rather than clobbering a file
 * the user may have hand-edited.
 */
export function readMcpConfigFile(path: string): McpConfigFile {
  if (!existsSync(path)) return { mcpServers: {} };

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to read MCP config at ${path}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`MCP config at ${path} is not valid JSON. Fix or remove it, then retry.`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`MCP config at ${path} must be a JSON object.`);
  }

  const cfg = parsed as McpConfigFile;
  // An array passes `typeof === 'object'`, so guard it explicitly: a string-keyed
  // assignment onto an array is silently dropped by JSON.stringify, which would make
  // `connect` report success while persisting nothing. Refuse rather than clobber a
  // hand-edited file (mirrors the top-level array check above).
  if (Array.isArray(cfg.mcpServers)) {
    throw new Error(`MCP config at ${path} has an invalid "mcpServers" (must be a JSON object, not an array).`);
  }
  if (cfg.mcpServers === undefined || typeof cfg.mcpServers !== 'object' || cfg.mcpServers === null) {
    cfg.mcpServers = {};
  }
  return cfg;
}

/**
 * Atomically persist mcp.json (temp-file + POSIX rename) so a crash mid-write
 * never leaves a truncated config. Mirrors the pattern in schedule-store.ts.
 */
export function writeMcpConfigFileAtomic(path: string, cfg: McpConfigFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.mcp.json.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, 'utf-8');
  renameSync(tmp, path);
}

/**
 * Best-effort detection of the installed Chrome major version, so `connect`
 * can warn when autoConnect (Chrome ≥ 144) won't work. Returns null when no
 * Chrome is found — a soft note, never a hard failure.
 */
function detectChromeMajorVersion(): number | null {
  const candidates =
    process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
          '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
        ]
      : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];

  for (const bin of candidates) {
    try {
      const out = execFileSync(bin, ['--version'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      });
      const m = out.match(/(\d+)\.\d+\.\d+/);
      if (m !== null && m[1] !== undefined) return parseInt(m[1], 10);
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function printSetupGuidance(): void {
  const major = detectChromeMajorVersion();

  console.log('');
  console.log(chalk.bold('Drive your real Chrome — one-time setup:'));
  if (major === null) {
    console.log(palette.meta('  • Chrome not detected. autoConnect requires Chrome ≥ 144.'));
  } else if (major < 144) {
    console.log(chalk.yellow(`  • Detected Chrome ${major} — autoConnect requires ≥ 144. Please update Chrome.`));
  } else {
    console.log(palette.meta(`  • Detected Chrome ${major} ✓ (autoConnect needs ≥ 144)`));
  }
  console.log(palette.meta('  1. In Chrome, open chrome://inspect/#remote-debugging and enable it (one time).'));
  console.log(palette.meta('  2. The first time the agent drives Chrome, click "Allow" on the prompt.'));
  console.log(palette.meta('  3. Chrome shows a "being controlled by automated test software" banner while active.'));
  console.log('');
  console.log(palette.meta('The agent gains mcp__chrome-devtools__* tools (navigate, click, fill, take_snapshot, …)'));
  console.log(palette.meta('driving your REAL, logged-in profile. Run `/mcp` in the REPL to confirm it connected.'));
  console.log(palette.meta('Undo anytime with `afk browser disconnect`.'));
}

export function registerBrowserCommand(program: Command): void {
  const browser = program
    .command('browser')
    .description('Give the agent web hands: connect your real Chrome, or save a login it reuses');

  browser
    .command('connect')
    .description('Wire chrome-devtools-mcp (--autoConnect) so the agent can drive your real, logged-in Chrome')
    .option('--channel <channel>', `Chrome channel autoConnect targets (${VALID_CHANNELS.join('|')})`, 'stable')
    .action((opts: { channel?: string }) => {
      try {
        const channel = (opts.channel ?? 'stable').toLowerCase();
        if (!(VALID_CHANNELS as readonly string[]).includes(channel)) {
          throw new Error(`--channel must be one of ${VALID_CHANNELS.join(', ')} (got "${opts.channel}")`);
        }

        const path = getMcpConfigPath();
        const cfg = readMcpConfigFile(path);
        if (cfg.mcpServers === undefined) cfg.mcpServers = {};

        const entry = buildChromeDevtoolsEntry(channel as ChromeChannel);
        const existing = cfg.mcpServers[CHROME_DEVTOOLS_SERVER_NAME];

        if (existing !== undefined && JSON.stringify(existing) === JSON.stringify(entry)) {
          console.log(chalk.green(`✓ "${CHROME_DEVTOOLS_SERVER_NAME}" already configured`));
          console.log(palette.meta(`  Config: ${path}`));
        } else {
          cfg.mcpServers[CHROME_DEVTOOLS_SERVER_NAME] = entry;
          writeMcpConfigFileAtomic(path, cfg);
          const verb = existing === undefined ? 'Added' : 'Updated';
          console.log(chalk.green(`✓ ${verb} "${CHROME_DEVTOOLS_SERVER_NAME}" MCP server`));
          console.log(palette.meta(`  Config: ${path}`));
          console.log(palette.meta(`  Runs:   npx ${entry.args?.join(' ') ?? ''}`));
        }

        printSetupGuidance();
      } catch (err) {
        handleCommandError(err);
      }
    });

  browser
    .command('disconnect')
    .description('Remove the chrome-devtools server from your MCP config')
    .action(() => {
      try {
        const path = getMcpConfigPath();
        if (!existsSync(path)) {
          console.log(chalk.yellow(`⚠ No MCP config at ${path} — nothing to remove.`));
          return;
        }
        const cfg = readMcpConfigFile(path);
        if (cfg.mcpServers === undefined || cfg.mcpServers[CHROME_DEVTOOLS_SERVER_NAME] === undefined) {
          console.log(chalk.yellow(`⚠ "${CHROME_DEVTOOLS_SERVER_NAME}" is not configured — nothing to remove.`));
          return;
        }
        delete cfg.mcpServers[CHROME_DEVTOOLS_SERVER_NAME];
        writeMcpConfigFileAtomic(path, cfg);
        console.log(chalk.green(`✓ Removed "${CHROME_DEVTOOLS_SERVER_NAME}" from ${path}`));
      } catch (err) {
        handleCommandError(err);
      }
    });

  browser
    .command('login <url>')
    .description("Open a headed browser, log in manually, and save the session to a vault profile the agent's native browser tools reuse")
    .option('--profile <name>', 'Vault profile name to save the session under', 'default')
    .action(async (url: string, opts: { profile?: string }) => {
      try {
        const profile = (opts.profile ?? 'default').trim();
        assertSafeBrowserProfile(profile);

        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          throw new Error(`Invalid URL: ${url}`);
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error(`login URL must be http(s), got: ${parsed.protocol}`);
        }

        const statePath = getBrowserStorageStatePath(profile);

        // Dynamic import: Playwright is heavy; only load it when login actually runs.
        const { chromium } = await import('playwright');
        console.log(palette.meta(`Launching a browser for profile "${profile}"…`));
        const browserInstance = await chromium.launch({ headless: false });
        // Restore an existing session if present, so re-running login refreshes
        // the same profile rather than starting from a logged-out state.
        const context = await browserInstance.newContext(
          existsSync(statePath) ? { storageState: statePath } : {},
        );
        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'load' }).catch(() => {
          // Non-fatal — the user can navigate manually if the initial load fails.
        });

        console.log('');
        console.log(chalk.bold('Log in to the site in the opened browser window.'));
        console.log(palette.meta('When fully logged in, return here and press Enter to save the session.'));
        console.log(palette.meta('(Do NOT close the browser window yourself — this command closes it for you.)'));
        await waitForEnter('Press Enter to save the session… ');

        const state = await context.storageState();
        mkdirSync(getBrowserProfileStateDir(profile), { recursive: true });
        // Atomic 0600 write (temp in the same dir → no EXDEV, then POSIX rename):
        // the vault is never observed truncated or at looser perms, closing the
        // write-then-chmod window on freshly-written credentials.
        const tmp = join(
          dirname(statePath),
          `.${basename(statePath)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
        );
        writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
        chmodSync(tmp, 0o600);
        renameSync(tmp, statePath);
        await browserInstance.close().catch(() => undefined);

        console.log(chalk.green(`✓ Saved session for profile "${profile}"`));
        console.log(palette.meta(`  Vault: ${statePath} (0600 — treat as a credential)`));
        console.log(palette.meta('  Point the agent at it:'));
        console.log(palette.meta(`    export AFK_BROWSER_DEFAULT_PROFILE=${profile}`));
      } catch (err) {
        handleCommandError(err);
      }
    });

  browser
    .command('profiles')
    .description('List saved browser session-vault profiles')
    .action(() => {
      try {
        const root = getBrowserStateRoot();
        const dirs = existsSync(root)
          ? readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
          : [];
        if (dirs.length === 0) {
          console.log(palette.meta('No saved profiles. Create one with `afk browser login <url> --profile <name>`.'));
          return;
        }
        console.log(chalk.bold('Saved browser profiles:'));
        for (const d of dirs) {
          const hasState = existsSync(join(root, d.name, 'storageState.json'));
          const marker = hasState ? chalk.green('●') : palette.meta('○');
          const note = hasState ? '' : palette.meta(' (no saved session)');
          console.log(`  ${marker} ${d.name}${note}`);
        }
        console.log('');
        console.log(palette.meta('Use one:  export AFK_BROWSER_DEFAULT_PROFILE=<name>'));
      } catch (err) {
        handleCommandError(err);
      }
    });
}
