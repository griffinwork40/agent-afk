/**
 * Real-Chrome readiness probe for `chrome-devtools-mcp --autoConnect`.
 *
 * `--autoConnect` finds the running Chrome by reading `DevToolsActivePort` in
 * the channel's default user-data-dir. When that read fails for ANY reason the
 * server reports "Could not find DevToolsActivePort", which conflates two very
 * different blockers:
 *
 *   - the file genuinely does not exist (Chrome not running, or remote
 *     debugging not enabled at chrome://inspect/#remote-debugging), and
 *   - macOS 27 TCC denying the terminal app access to Chrome's profile folder
 *     (EPERM, silently, no prompt — ChromeDevTools/chrome-devtools-mcp#3089).
 *
 * This probe distinguishes them. afk runs under the same responsible terminal
 * app as the MCP server it spawns, so its own access attempt gets the same TCC
 * verdict the server would.
 *
 * Contract: the probe only OPENS and immediately CLOSES `DevToolsActivePort`.
 * It never reads the file's contents or touches any other file in the profile
 * directory, which holds cookies and credentials.
 *
 * @module browser/real-chrome-probe
 */

import { closeSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { env } from '../config/env.js';

/** MCP server key written into mcpServers by `afk browser connect`. */
export const CHROME_DEVTOOLS_SERVER_NAME = 'chrome-devtools';

export const REAL_CHROME_CHANNELS = ['stable', 'beta', 'canary', 'dev'] as const;
export type RealChromeChannel = (typeof REAL_CHROME_CHANNELS)[number];

/**
 * - `ok`: `DevToolsActivePort` exists and is readable; only Chrome's per-session
 *   "Allow" prompt remains.
 * - `missing`: the file does not exist (Chrome not running, or remote debugging off).
 * - `blocked`: the OS denied access (EPERM/EACCES). On macOS 27 this is TCC
 *   protecting Chrome's profile folder; whether debugging is on is unknowable.
 * - `unknown`: the user-data-dir could not be resolved, or another error occurred.
 */
export type RealChromeState = 'ok' | 'missing' | 'blocked' | 'unknown';

export interface RealChromeProbeResult {
  state: RealChromeState;
  channel: RealChromeChannel;
  platform: NodeJS.Platform;
  /** Chrome's default user-data-dir for the channel, or null when unresolvable. */
  userDataDir: string | null;
  /** Error code from the access attempt (`ENOENT`, `EPERM`, …), when one occurred. */
  errorCode?: string;
  /** macOS bundle id of the app this process inherits permissions from (a hint only). */
  terminalBundleId?: string;
}

export interface RealChromeProbeOptions {
  channel?: RealChromeChannel;
  platform?: NodeJS.Platform;
  home?: string;
  localAppData?: string;
  /**
   * Linux: overrides the config-base dir (highest priority, mirrors Puppeteer).
   * @remarks Linux-only; ignored on darwin and win32.
   */
  chromeConfigHome?: string;
  /**
   * Linux: XDG base-dir override (second priority after chromeConfigHome).
   * @remarks Linux-only; ignored on darwin and win32.
   */
  xdgConfigHome?: string;
  terminalBundleId?: string;
  /** Test seam: open-then-close the file, throwing a Node errno error on failure. */
  touchFile?: (file: string) => void;
}

const MAC_DIRS: Record<RealChromeChannel, string> = {
  stable: 'Chrome',
  beta: 'Chrome Beta',
  canary: 'Chrome Canary',
  dev: 'Chrome Dev',
};

const LINUX_DIRS: Record<RealChromeChannel, string> = {
  stable: 'google-chrome',
  beta: 'google-chrome-beta',
  canary: 'google-chrome-canary',
  dev: 'google-chrome-unstable',
};

const WIN_DIRS: Record<RealChromeChannel, string> = {
  stable: 'Chrome',
  beta: 'Chrome Beta',
  canary: 'Chrome SxS',
  dev: 'Chrome Dev',
};

/** Human-facing app name, as it appears in macOS Files & Folders. */
export function chromeAppName(channel: RealChromeChannel): string {
  return channel === 'stable' ? 'Google Chrome' : `Google ${MAC_DIRS[channel]}`;
}

/**
 * Resolve Chrome's default user-data-dir for a channel. Mirrors the locations
 * `--autoConnect` looks in (Puppeteer's default-user-data-dir resolution),
 * including the Linux `CHROME_CONFIG_HOME` / `XDG_CONFIG_HOME` overrides.
 *
 * Priority on Linux (same as Puppeteer / chrome-devtools-mcp):
 *   1. `$CHROME_CONFIG_HOME/<channel-dir>`
 *   2. `$XDG_CONFIG_HOME/<channel-dir>`
 *   3. `$HOME/.config/<channel-dir>`
 */
export function resolveChromeUserDataDir(
  channel: RealChromeChannel,
  platform: NodeJS.Platform,
  home: string,
  localAppData: string | undefined,
  chromeConfigHome?: string | undefined,
  xdgConfigHome?: string | undefined,
): string | null {
  if (platform === 'darwin') {
    return path.posix.join(home, 'Library', 'Application Support', 'Google', MAC_DIRS[channel]);
  }
  if (platform === 'linux') {
    const configBase =
      (chromeConfigHome !== undefined && chromeConfigHome !== '')
        ? chromeConfigHome
        : (xdgConfigHome !== undefined && xdgConfigHome !== '')
          ? xdgConfigHome
          : path.posix.join(home, '.config');
    return path.posix.join(configBase, LINUX_DIRS[channel]);
  }
  if (platform === 'win32') {
    if (localAppData === undefined || localAppData === '') return null;
    return path.win32.join(localAppData, 'Google', WIN_DIRS[channel], 'User Data');
  }
  return null;
}

function defaultTouchFile(file: string): void {
  closeSync(openSync(file, 'r'));
}

function classify(code: string | undefined): RealChromeState {
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
  if (code === 'EPERM' || code === 'EACCES') return 'blocked';
  return 'unknown';
}

/** Probe whether `--autoConnect` can find the running Chrome. Never throws. */
export function probeRealChrome(opts: RealChromeProbeOptions = {}): RealChromeProbeResult {
  const channel = opts.channel ?? 'stable';
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  const userDataDir = resolveChromeUserDataDir(
    channel,
    platform,
    home,
    opts.localAppData ?? env.LOCALAPPDATA,
    opts.chromeConfigHome ?? env.CHROME_CONFIG_HOME,
    opts.xdgConfigHome ?? env.XDG_CONFIG_HOME,
  );
  const bundleId = platform === 'darwin' ? (opts.terminalBundleId ?? env.__CFBundleIdentifier) : undefined;
  const base = {
    channel,
    platform,
    userDataDir,
    ...(bundleId !== undefined && bundleId !== '' ? { terminalBundleId: bundleId } : {}),
  };
  if (userDataDir === null) return { ...base, state: 'unknown' };

  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  try {
    (opts.touchFile ?? defaultTouchFile)(join(userDataDir, 'DevToolsActivePort'));
    return { ...base, state: 'ok' };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return { ...base, state: classify(code), ...(code !== undefined ? { errorCode: code } : {}) };
  }
}

/** Parse the `--channel` value out of a chrome-devtools-mcp args list. */
export function channelFromArgs(args: readonly string[] | undefined): RealChromeChannel {
  if (args === undefined) return 'stable';
  // Look for either `--channel` (standalone) or `--channel=<value>` (equals form).
  const i = findChannelIndex(args);
  const value = i >= 0 ? extractChannelValue(args, i) : undefined;
  return (REAL_CHROME_CHANNELS as readonly string[]).includes(value ?? '')
    ? (value as RealChromeChannel)
    : 'stable';
}

/** Find the index of `--channel` or `--channel=<value>` in the args list. */
function findChannelIndex(args: readonly string[]): number {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    // Exact match: --channel.
    if (arg === '--channel') return i;
    // Equals form: --channel=<value>.
    if (arg.startsWith('--channel=')) return i;
  }
  return -1;
}

/** Extract the channel value from either `--channel value` or `--channel=value`. */
function extractChannelValue(args: readonly string[], index: number): string {
  const arg = args[index]!;
  // Handle --channel=value form (e.g. --channel=canary).
  const eqIdx = arg.indexOf('=');
  if (eqIdx >= 0) return arg.slice(eqIdx + 1);
  // Handle --channel value form.
  return args[index + 1] ?? '';
}
