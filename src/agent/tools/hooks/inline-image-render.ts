/**
 * Inline terminal image rendering via Kitty graphics protocol / iTerm2 protocol.
 *
 * Detects the active terminal emulator from environment variables and emits the
 * appropriate escape sequences to render an image inline. Falls back to a plain
 * path log when no supported protocol is detected or when AFK_INLINE_IMAGES=0.
 *
 * ## Protocol coverage
 *
 * - **Kitty graphics protocol** (APC `\x1b_G…\x1b\\`): supported by kitty,
 *   Ghostty, and WezTerm. Images are base64-encoded and chunked into ≤4096-byte
 *   payloads per the spec. PNG only (f=100).
 * - **iTerm2 inline images protocol** (OSC 1337): supported by iTerm2 and a
 *   handful of iTerm2-compatible terminals (e.g. Hyper with the right plugin).
 * - **Fallback**: prints the file path only — the pre-#2143 behaviour.
 *
 * ## References
 *
 * - https://sw.kovidgoyal.net/kitty/graphics-protocol/
 * - https://iterm2.com/documentation-images.html
 *
 * @module agent/tools/hooks/inline-image-render
 */

import * as fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { env } from '../../../config/env.js';
import { palette } from '../../../cli/palette.js';
import { sanitizeForDisplay } from '../../../utils/terminal-sanitize.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum chunk size (bytes of base64 text) per Kitty APC packet. */
const KITTY_CHUNK_SIZE = 4096;

/** Maximum file size rendered inline; larger files fall back to path log. */
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------
// EPIPE guard
// ---------------------------------------------------------------------------

let _stdoutErrorGuardInstalled = false;

function ensureStdoutErrorGuard(): void {
  if (_stdoutErrorGuardInstalled) return;
  _stdoutErrorGuardInstalled = true;
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') throw err;
  });
}

// ---------------------------------------------------------------------------
// Terminal detection
// ---------------------------------------------------------------------------

export type TerminalProtocol = 'kitty' | 'iterm2' | 'none';

/**
 * Detect which inline image protocol the active terminal supports.
 *
 * Detection is purely env-var based (no escape-sequence probing) to avoid
 * blocking I/O in a synchronous hook context. Ordered from most-specific to
 * least-specific so a terminal that supports multiple protocols is matched by
 * the one it natively implements.
 *
 * Reads from `process.env` via the `env` object only (ENV_REGISTRY contract).
 */
export function detectTerminalProtocol(): TerminalProtocol {
  const term = env.TERM ?? '';
  const termProgram = env.TERM_PROGRAM ?? '';

  // Kitty: TERM=xterm-kitty (canonical), or TERM_PROGRAM=ghostty / WezTerm.
  if (
    term === 'xterm-kitty' ||
    termProgram.toLowerCase() === 'ghostty' ||
    termProgram.toLowerCase() === 'wezterm'
  ) {
    return 'kitty';
  }

  // iTerm2: TERM_PROGRAM=iTerm.app. Also accept iTerm2 (older versions).
  // TERM_PROGRAM_VERSION is not checked — it carries a version string
  // (e.g. "3.4.23"), not the program name, so it is not a reliable signal.
  if (termProgram === 'iTerm.app' || termProgram === 'iTerm2') {
    return 'iterm2';
  }

  return 'none';
}

// ---------------------------------------------------------------------------
// Protocol emitters
// ---------------------------------------------------------------------------

/**
 * Emit a Kitty APC graphics sequence to render `imageB64` inline.
 *
 * PNG only (f=100). The payload is chunked into `KITTY_CHUNK_SIZE`-byte
 * slices. The first chunk carries `a=T` (transmit + display), `f=100` (PNG),
 * `m=1` (more chunks follow). Intermediate chunks carry `m=1`; the final
 * chunk carries `m=0`. When the whole image fits in one chunk, a single
 * packet with `m=0` is sent.
 *
 * Writes directly to `process.stdout` so the escape sequence lands on the raw
 * terminal before any readline/ink rendering pass can interfere.
 */
function emitKittyImage(imageB64: string): void {
  const chunks: string[] = [];
  for (let i = 0; i < imageB64.length; i += KITTY_CHUNK_SIZE) {
    chunks.push(imageB64.slice(i, i + KITTY_CHUNK_SIZE));
  }

  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const more = isLast ? 0 : 1;
    const header =
      i === 0
        ? `a=T,f=100,m=${more}`
        : `m=${more}`;
    process.stdout.write(`\x1b_G${header};${chunks[i]}\x1b\\`);
  }
  // Move to a new line so subsequent terminal output is not overlaid.
  process.stdout.write('\n');
}

/**
 * Emit an iTerm2 OSC 1337 inline image sequence for `imageB64`.
 *
 * The `inline=1` argument instructs iTerm2 to display the image in the
 * terminal stream rather than opening it in a preview pane.
 */
function emitIterm2Image(imageB64: string, filename: string): void {
  const name = Buffer.from(filename).toString('base64');
  const size = Buffer.from(imageB64, 'base64').length;
  const args = `inline=1;name=${name};size=${size};preserveAspectRatio=1`;
  process.stdout.write(`\x1b]1337;File=${args}:${imageB64}\x07\n`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RenderInlineImageOptions {
  /** Absolute path to the image file on disk. */
  filePath: string;
  /** Tool that produced the image (for the fallback log label). */
  toolName: string;
  /**
   * The agent's effective working directory, threaded from `agentOptions?.cwd`
   * at hook-registration time. Used to compute the path allowlist so it tracks
   * the agent's workspace rather than the process working directory.
   */
  agentCwd?: string | undefined;
}

/**
 * Render an image inline in the terminal when the terminal supports it, or
 * log the file path as a fallback.
 *
 * Returns immediately when:
 * - `AFK_INLINE_IMAGES=0` / `=false` (user opt-out)
 * - The file cannot be read (logs a warning and falls through to path log)
 * - No supported protocol detected (falls through to path log)
 *
 * Never throws — all errors are swallowed so a rendering failure never aborts
 * the hook dispatch or the tool result delivery.
 */
export async function renderInlineImage(opts: RenderInlineImageOptions): Promise<void> {
  const { filePath, toolName, agentCwd } = opts;

  // Respect the opt-out flag. Only '1', 'true', or unset (undefined) are
  // treated as enabled; any other value (including arbitrary strings) disables.
  const flag = env.AFK_INLINE_IMAGES;
  if (flag !== undefined && flag !== '1' && flag !== 'true') {
    return;
  }

  // Install EPIPE guard so a broken pipe on stdout does not throw.
  ensureStdoutErrorGuard();

  // Validate path: must resolve to within tmpdir or the agent's cwd.
  // Use agentCwd (threaded from agentOptions?.cwd at registration) rather than
  // process.cwd() so the gate tracks the agent's workspace, not the process's.
  const resolved = path.resolve(filePath);
  const allowedPrefixes = [
    realpathSync.native(os.tmpdir()) + path.sep,
    path.resolve(agentCwd ?? process.cwd()) + path.sep,
  ];
  const isAllowed = allowedPrefixes.some((prefix) => resolved.startsWith(prefix));
  if (!isAllowed) {
    process.stdout.write(
      `${palette.fileRef(sanitizeForDisplay(filePath))}  ${palette.meta(`(${toolName} — path outside allowed directories)`)}\n`,
    );
    return;
  }

  const protocol = detectTerminalProtocol();

  // On unsupported terminals just print the path — that is the pre-#2143
  // behaviour and avoids polluting non-graphical terminals with garbage bytes.
  if (protocol === 'none') {
    process.stdout.write(
      `${palette.fileRef(sanitizeForDisplay(filePath))}  ${palette.meta(`(${toolName})`)}\n`,
    );
    return;
  }

  // Kitty protocol only supports PNG (f=100). Reject other formats early.
  const ext = path.extname(filePath).toLowerCase();
  if (protocol === 'kitty' && ext !== '.png') {
    process.stdout.write(
      `${palette.fileRef(sanitizeForDisplay(filePath))}  ${palette.meta(`(${toolName} — non-PNG not rendered inline via Kitty)`)}\n`,
    );
    return;
  }

  // Stat the file: confirm it is a regular file and reject oversized files.
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      process.stdout.write(
        `${palette.fileRef(sanitizeForDisplay(filePath))}  ${palette.meta(`(${toolName} — not a regular file)`)}\n`,
      );
      return;
    }
    if (stat.size > MAX_INLINE_IMAGE_BYTES) {
      process.stdout.write(`${palette.fileRef(sanitizeForDisplay(filePath))}  ${palette.meta(`(${toolName} — file exceeds 2 MiB, not rendered inline)`)}\n`);
      return;
    }
  } catch {
    // stat failed (ENOENT, EACCES, ELOOP, etc.) — do not proceed to readFile,
    // which would bypass the isFile() and size-cap guards above.
    return;
  }

  // Read the image bytes.
  let imageB64: string;
  try {
    const buf = await fs.readFile(resolved);
    imageB64 = buf.toString('base64');
  } catch {
    // File unreadable — fall back to path log.
    process.stdout.write(
      `${palette.fileRef(sanitizeForDisplay(filePath))}  ${palette.meta(`(${toolName} — could not read file)`)}\n`,
    );
    return;
  }

  // Emit the appropriate protocol sequence.
  if (process.stdout.destroyed) return;
  try {
    if (protocol === 'kitty') {
      emitKittyImage(imageB64);
    } else {
      // iterm2
      const filename = filePath.split('/').pop() ?? 'image';
      emitIterm2Image(imageB64, filename);
    }
    // Print the path below the image so the user knows where it was saved.
    process.stdout.write(`  ${palette.fileRef(sanitizeForDisplay(filePath))}  ${palette.meta(`(${toolName})`)}\n`);
  } catch {
    // Emit failed — stream errors (EPIPE etc.) are handled by the error guard.
  }
}
