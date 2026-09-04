/**
 * Handlers for the `clipboard_write` and `clipboard_read` built-in tools.
 *
 * clipboard_write — copies text to the system clipboard, reusing the
 * `copyToClipboard` primitive from `src/cli/clipboard.ts` (platform
 * detection: pbcopy / clip / wl-copy / xclip / xsel, OSC 52 fallback).
 * Best-effort: headless / SSH / CI boxes where no clipboard utility is
 * available return a graceful failure instead of throwing.
 *
 * clipboard_read — reads clipboard contents as text, then runs the result
 * through the `redactSecrets` pipeline before returning it to the model.
 * A mandatory operator-confirmation gate (via elicitation) fires on every
 * call because the clipboard may contain passwords, tokens, or other
 * sensitive material.  The gate is non-skippable: a decline/cancel aborts
 * the read.
 *
 * env-access note: the clipboard utilities do not read process.env directly.
 * spawnSync is used to probe available system utilities; graceful-failure
 * behaviour covers headless, SSH-only, and CI environments without needing
 * env-variable detection.
 *
 * @module agent/tools/handlers/clipboard
 */

import { spawnSync } from 'node:child_process';
import { copyToClipboard } from '../../../cli/clipboard.js';
import { redactSecrets } from '../../redact-secrets.js';
import { elicitationRouter } from '../../elicitation-router.js';
import type { ToolHandler } from '../types.js';

// ── Types ────────────────────────────────────────────────────────────────────

/** Seam for reading the system clipboard. Injected in tests to avoid spawning. */
export type ClipboardReadFn = () => string | null;

/** Seam for writing the system clipboard. Injected in tests. */
export type ClipboardWriteFn = (text: string) => boolean;

export interface ClipboardHandlerOpts {
  readFn?: ClipboardReadFn;
  writeFn?: ClipboardWriteFn;
}

// ── Platform clipboard read ───────────────────────────────────────────────────

/**
 * Platform-specific read tool list.  Mirrors the write-side logic in
 * `clipboardToolsFor` but for reading.
 */
interface ReadTool {
  cmd: string;
  args: string[];
  checkStderr?: boolean; // true only for tools that signal error via stderr on exit 0
}

function clipboardReadToolsFor(platform: NodeJS.Platform): ReadTool[] {
  switch (platform) {
    case 'darwin':
      return [{ cmd: 'pbpaste', args: [] }];
    case 'win32':
      // PowerShell on Windows can read the clipboard via Get-Clipboard.
      return [
        {
          cmd: 'powershell',
          args: ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard'],
        },
      ];
    default:
      // Linux/BSD: prefer Wayland (wl-paste), then X11 (xclip -o, xsel -ob).
      return [
        { cmd: 'wl-paste', args: ['--no-newline'], checkStderr: true },
        { cmd: 'xclip', args: ['-selection', 'clipboard', '-o'] },
        { cmd: 'xsel', args: ['--clipboard', '--output'] },
      ];
  }
}

/**
 * Read the system clipboard using native platform utilities.
 * Returns the clipboard text on success, or `null` when no suitable utility
 * is available (headless, SSH-only, CI, etc.).
 *
 * Injectable via `clipboardReadFn` seam for testing.
 */
export function readFromClipboard(
  platform: NodeJS.Platform = process.platform,
): string | null {
  for (const tool of clipboardReadToolsFor(platform)) {
    try {
      const res = spawnSync(tool.cmd, tool.args, { encoding: 'utf8', timeout: 5_000 });
      if (!res.error && res.status === 0 && res.signal === null && (!tool.checkStderr || !res.stderr?.trim())) {
        return res.stdout ?? '';
      }
    } catch {
      // Defensive: try the next tool on any unexpected throw.
    }
  }
  return null;
}

// ── clipboard_write handler ───────────────────────────────────────────────────

export function createClipboardWriteHandler(
  opts: ClipboardHandlerOpts = {},
): ToolHandler {
  const writeFn: ClipboardWriteFn =
    opts.writeFn ?? ((text: string) => copyToClipboard(text));

  return async (input, _signal) => {
    if (!input || typeof input !== 'object') {
      return { content: 'Invalid input: expected an object', isError: true };
    }
    const obj = input as Record<string, unknown>;
    const text = obj['text'];
    if (typeof text !== 'string') {
      return { content: 'Invalid input: text must be a string', isError: true };
    }
    let succeeded: boolean;
    try {
      succeeded = writeFn(text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Clipboard write threw an error: ${msg}`, isError: true };
    }
    if (!succeeded) {
      return {
        content:
          'Clipboard write failed: no clipboard utility available in this environment ' +
          '(headless, SSH-only, or CI). The text was not written to the clipboard.',
        isError: true,
      };
    }
    return { content: 'Text copied to clipboard successfully.' };
  };
}

/** Default singleton — uses the real copyToClipboard. */
export const clipboardWriteHandler: ToolHandler =
  createClipboardWriteHandler();

// ── clipboard_read handler ────────────────────────────────────────────────────

export function createClipboardReadHandler(
  opts: ClipboardHandlerOpts = {},
): ToolHandler {
  const readFn: ClipboardReadFn = opts.readFn ?? (() => readFromClipboard());

  return async (_input, signal, context) => {
    // ── Operator confirmation gate ────────────────────────────────────────
    // The clipboard may contain passwords, tokens, or other sensitive material.
    // Require explicit operator approval on every call; decline or cancel aborts.
    const confirmation = await elicitationRouter.route(
      {
        serverName: 'agent',
        origin: 'agent',
        message:
          'The model wants to read your clipboard contents. ' +
          'Clipboard may contain passwords, tokens, or other sensitive data. ' +
          'Allow the model to read the clipboard?',
        type: 'confirm',
      },
      {
        signal,
        ...(context?.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
      },
    );

    if (confirmation.action !== 'accept' || confirmation.content?.['value'] !== true) {
      return {
        content: 'Clipboard read was not approved by the operator.',
        isError: true,
        failureClass: 'elicitation-declined' as const,
      };
    }

    // ── Read ──────────────────────────────────────────────────────────────
    const raw = readFn();
    if (raw === null) {
      return {
        content:
          'Clipboard read failed: no clipboard utility available in this environment ' +
          '(headless, SSH-only, or CI). No content was returned.',
        isError: true,
      };
    }

    // ── Secret redaction ─────────────────────────────────────────────────
    // Redact secrets from the raw string BEFORE any truncation so that a
    // secret whose bytes straddle the 100 KB boundary cannot evade redaction
    // by being split across the cut point.
    const redacted = redactSecrets(raw);

    // ── Size cap ─────────────────────────────────────────────────────────
    const CLIPBOARD_CAP_BYTES = 100_000;
    const redactedBytes = Buffer.byteLength(redacted, 'utf8');
    const truncated = redactedBytes > CLIPBOARD_CAP_BYTES;
    const capped = (() => {
      if (!truncated) return redacted;
      const buf = Buffer.from(redacted, 'utf8');
      let end = CLIPBOARD_CAP_BYTES;
      // Walk backward past any UTF-8 continuation bytes (0x80–0xBF) so we never
      // cut in the middle of a multi-byte sequence (would produce U+FFFD).
      while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
      return buf.slice(0, end).toString('utf8');
    })();

    return { content: capped, ...(truncated ? { truncated: true } : {}) };
  };
}

/** Default singleton — uses the real platform read and real elicitation. */
export const clipboardReadHandler: ToolHandler = createClipboardReadHandler();
