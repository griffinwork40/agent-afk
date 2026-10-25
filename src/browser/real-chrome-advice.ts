/**
 * Turn a {@link RealChromeProbeResult} into operator-facing advice. Shared by
 * `afk browser connect` (printed once after writing config) and the in-session
 * MCP error hint (appended to a failed chrome-devtools tool result), so both
 * surfaces always give the same diagnosis.
 *
 * @module browser/real-chrome-advice
 */

import { chromeAppName, type RealChromeProbeResult } from './real-chrome-probe.js';

export const REMOTE_DEBUGGING_URL = 'chrome://inspect/#remote-debugging';

/** Opens System Settings at Privacy & Security > Files & Folders (macOS). */
export const MAC_FILES_AND_FOLDERS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders';

export interface RealChromeAdvice {
  /** One-line diagnosis. */
  headline: string;
  /** Ordered fix steps (empty when nothing is needed). */
  steps: string[];
  /** A URL worth opening for the user on macOS, when one applies. */
  openUrl?: string;
}

const ENABLE_STEP =
  `In Chrome, open ${REMOTE_DEBUGGING_URL} and tick "Allow remote debugging for this browser instance" ` +
  '(the page then shows "Server running at 127.0.0.1:9222"; a 404 from /json/version on that port is normal).';

function blockedAdvice(probe: RealChromeProbeResult): RealChromeAdvice {
  const app = chromeAppName(probe.channel);
  const bundleHint =
    probe.terminalBundleId !== undefined
      ? ` This process reports ${probe.terminalBundleId}; under tmux or screen it is the app that started the multiplexer server.`
      : '';

  // On macOS 27+, TCC silently denies the terminal app access to Chrome's
  // profile folder (EPERM, no prompt — ChromeDevTools/chrome-devtools-mcp#3089).
  // On Linux/Windows EPERM/EACCES are ordinary permission errors; telling
  // those users to open macOS System Settings would be actively misleading.
  if (probe.platform === 'darwin') {
    return {
      headline:
        `macOS is blocking access to ${app}'s profile folder (${probe.errorCode ?? 'EPERM'}), so chrome-devtools-mcp ` +
        'cannot read DevToolsActivePort and wrongly reports it as missing (ChromeDevTools/chrome-devtools-mcp#3089).',
      steps: [
        `System Settings > Privacy & Security > Files & Folders > the terminal app that launched afk > enable "${app}". ` +
          `It applies immediately.${bundleHint}`,
        'If that app is not listed, add it under Full Disk Access instead (broader).',
        `Also make sure remote debugging is on: ${REMOTE_DEBUGGING_URL}.`,
      ],
      openUrl: MAC_FILES_AND_FOLDERS_URL,
    };
  }

  // Non-macOS: generic permission advice.
  return {
    headline:
      `Access to ${app}'s profile folder was denied (${probe.errorCode ?? 'EPERM'}), so chrome-devtools-mcp ` +
      'cannot read DevToolsActivePort.',
    steps: [
      `Ensure the terminal app that launched afk has read permission for ${app}'s profile folder.${bundleHint}`,
      `Also make sure remote debugging is on: ${REMOTE_DEBUGGING_URL}.`,
    ],
  };
}

/** Advice for a probe result. Pure: no I/O. */
export function adviseRealChrome(probe: RealChromeProbeResult): RealChromeAdvice {
  const app = chromeAppName(probe.channel);
  switch (probe.state) {
    case 'ok':
      return {
        headline: `${app} has remote debugging on and afk can reach it.`,
        steps: ['The first time the agent drives Chrome in a session, click "Allow" on Chrome\'s prompt.'],
      };
    case 'missing':
      return {
        headline: `${app} is not running with remote debugging enabled (no DevToolsActivePort).`,
        steps: [ENABLE_STEP, 'Keep Chrome running while the agent uses it.'],
        ...(probe.platform === 'darwin' ? { openUrl: REMOTE_DEBUGGING_URL } : {}),
      };
    case 'blocked':
      return blockedAdvice(probe);
    case 'unknown':
      return {
        headline:
          probe.userDataDir === null
            ? `Could not locate ${app}'s profile folder on this platform.`
            : `Could not check ${app}'s DevToolsActivePort (${probe.errorCode ?? 'unknown error'}).`,
        steps: [
          ENABLE_STEP,
          `On macOS 27+, also grant the terminal app "${app}" under System Settings > Privacy & Security > Files & Folders.`,
        ],
      };
  }
}

/** Render advice as plain text lines (no styling), for tool results. */
export function formatRealChromeAdvice(advice: RealChromeAdvice): string {
  return [advice.headline, ...advice.steps.map((s, i) => `${i + 1}. ${s}`)].join('\n');
}
