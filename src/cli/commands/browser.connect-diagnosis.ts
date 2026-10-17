/**
 * `afk browser connect` helpers: pin the chrome-devtools-mcp version, and run
 * a one-shot readiness diagnosis after the config is written.
 *
 * Split out of `browser.ts` (350-code-line ceiling). `browser.ts` keeps its
 * public surface; this module owns everything that touches the network, the
 * Chrome profile folder, or `open(1)`, so command tests can mock it wholesale.
 *
 * @module cli/commands/browser.connect-diagnosis
 */

import { execFileSync } from 'node:child_process';
import { palette } from '../palette.js';
import { adviseRealChrome } from '../../browser/real-chrome-advice.js';
import { chromeAppName, probeRealChrome, type RealChromeChannel } from '../../browser/real-chrome-probe.js';

/**
 * Known-good version written when the registry lookup fails (offline, npm
 * missing). Bump when a newer release has been verified with `--autoConnect`.
 */
export const CHROME_DEVTOOLS_MCP_FALLBACK_VERSION = '1.11.0';

const SEMVER = /^\d+\.\d+\.\d+$/;

/**
 * Resolve the current chrome-devtools-mcp version ONCE, at connect time, so the
 * persisted entry is pinned instead of re-resolving `@latest` on every session
 * start. Rationale: the server gets full control of the user's logged-in
 * browser, so an upgrade should be an explicit act (re-running `connect`), not
 * a silent per-session fetch. Never throws; falls back on any failure.
 */
export function resolveChromeDevtoolsMcpVersion(): string {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['view', 'chrome-devtools-mcp', 'version'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    return SEMVER.test(out) ? out : CHROME_DEVTOOLS_MCP_FALLBACK_VERSION;
  } catch {
    return CHROME_DEVTOOLS_MCP_FALLBACK_VERSION;
  }
}

function openForUser(url: string, channel: RealChromeChannel, platform: NodeJS.Platform): boolean {
  if (platform !== 'darwin') return false;
  // chrome:// URLs have no system handler; they must be opened IN Chrome.
  const args = url.startsWith('chrome://') ? ['-a', chromeAppName(channel), url] : [url];
  try {
    execFileSync('open', args, { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe Chrome once and print the matching next step. When `open` is true and
 * a fix lives behind a URL (chrome://inspect, the Files & Folders pane), open
 * it for the user on macOS. Never throws.
 */
export function printConnectDiagnosis(
  channel: RealChromeChannel,
  open: boolean,
  platform: NodeJS.Platform = process.platform,
): void {
  const probe = probeRealChrome({ channel, platform });
  const advice = adviseRealChrome(probe);

  console.log('');
  console.log(palette.heading('Readiness check:'));
  const mark = probe.state === 'ok' ? palette.success('✓') : palette.warning('⚠');
  console.log(`  ${mark} ${advice.headline}`);
  advice.steps.forEach((step, i) => console.log(palette.meta(`    ${i + 1}. ${step}`)));

  if (open && advice.openUrl !== undefined && openForUser(advice.openUrl, channel, platform)) {
    console.log(palette.meta(`    Opened ${advice.openUrl} for you.`));
  }
  if (probe.state !== 'ok') {
    console.log(palette.meta('    Re-run `afk browser connect` after the fix to re-check.'));
  }
}
