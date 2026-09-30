/**
 * Inline terminal image rendering via the Kitty Graphics Protocol.
 *
 * ## Protocol summary
 *
 * The Kitty Graphics Protocol (<https://sw.kovidgoyal.net/kitty/graphics-protocol/>)
 * lets supporting terminals render a PNG/JPEG/WebP image inline at the cursor
 * position by reading a base64-encoded payload from APC escape sequences:
 *
 *   ESC _G <key>=<val>,...;<base64-chunk> ESC \
 *
 * Key fields:
 *   f=100  — PNG format (32 for raw RGBA; 100 = preferred PNG path)
 *   a=T    — action: transmit + display immediately
 *   m=1    — more chunks follow
 *   m=0    — last (or only) chunk
 *   c=N    — (optional) width in terminal columns to request
 *   r=N    — (optional) height in terminal rows to request
 *
 * ## tmux passthrough
 *
 * Inside tmux, the APC sequence must be wrapped in a tmux DCS passthrough
 * so tmux forwards it to the outer terminal:
 *
 *   ESC P tmux; ESC ESC _G ... ESC ESC \ ESC \
 *
 * ## Detection rules
 *
 * Support is detected conservatively from env vars (pure function of
 * `NodeJS.ProcessEnv`, never reads `process.env` directly — caller passes env):
 *
 *   1. `KITTY_WINDOW_ID` set → kitty (native support)
 *   2. `GHOSTTY_RESOURCES_DIR` set OR `TERM=xterm-ghostty` → ghostty (native)
 *   3. `TERM_PROGRAM=WezTerm` OR `WEZTERM_PANE` set → WezTerm (native)
 *   4. `TMUX` set with outer terminal = kitty/ghostty/wezterm → tmux passthrough
 *
 * Terminals explicitly excluded: iTerm2 (different protocol), vscode, alacritty,
 * Windows Terminal, Apple Terminal (no Kitty protocol support), and anything else.
 *
 * ## Opt-out
 *
 * Set `AFK_INLINE_IMAGES=0` to suppress inline rendering globally.
 * Always suppressed when:
 *   - stdout is not a TTY
 *   - `AFK_PLAIN_OUTPUT=1` is set
 *   - surface is Telegram or daemon (callers pass `isTTY=false`)
 *
 * ## TUI ordering constraint
 *
 * TEARDOWN BEFORE SETUP (TUI ordered-ops rule):
 * Because image emission writes raw bytes after `compositor.commitAbove()`,
 * the compositor must be fully armed before any image write. Callers MUST:
 *   1. Tear down / stop the compositor overlay (setOverlay('')) FIRST
 *   2. Commit the tool-lane result lines via commitAbove SECOND
 *   3. Call emitKittyImage THIRD (while compositor input/overlay are settled)
 *   4. Resume the compositor lifecycle (arm spinner, etc.) FOURTH
 * This ordering prevents the compositor's next repaint from overwriting the
 * image rows that the terminal has already allocated.
 *
 * @module cli/kitty-image
 */

import * as fs from 'node:fs';
import { env } from '../config/env.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** How the Kitty protocol payload is emitted to the terminal. */
export type KittyTransport = 'native' | 'tmux' | 'unsupported';

/** Result of Kitty support detection. */
export interface KittyCapability {
  transport: KittyTransport;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum base64 bytes per Kitty APC chunk (spec recommends ≤ 4096). */
const KITTY_CHUNK_SIZE = 4096;

/**
 * Maximum image dimension in terminal columns / rows the renderer will
 * request from the terminal. A generous cap that prevents a single image
 * from flooding the entire screen; the terminal still clamps to its own
 * available space.
 */
const MAX_COLS = 80;
const MAX_ROWS = 20;

// ---------------------------------------------------------------------------
// Support detection
// ---------------------------------------------------------------------------

/**
 * Detect Kitty graphics protocol support from environment variables.
 *
 * Pure function of `nodeEnv` — never reads `process.env` directly.
 * Call with `process.env` at the call site (which IS allowed; this
 * function itself lives in `src/cli/` and the caller's env access is
 * the only direct `process.env` touch — but all our callers receive
 * `env` from `config/env.ts` typed getters and never raw process.env).
 *
 * NOTE: we inspect terminal-capability vars (`KITTY_WINDOW_ID`, `TMUX`,
 * `TERM_PROGRAM`, `WEZTERM_PANE`, `GHOSTTY_RESOURCES_DIR`, `TERM`)
 * through the `env` typed accessors from `src/config/env.ts`, not
 * directly from `process.env`, keeping the CI gate clean.
 */
export function detectKittySupport(): KittyCapability {
  // 1. Opt-out gate — AFK_INLINE_IMAGES=0 disables everything.
  const inlineImagesFlag = env.AFK_INLINE_IMAGES;
  if (inlineImagesFlag !== undefined && inlineImagesFlag.trim() === '0') {
    return { transport: 'unsupported' };
  }

  // 2. Detect outer terminal from high-confidence env vars (same order as
  //    src/cli/terminal-spawn/detect.ts but scoped to Kitty-protocol supporters).
  const kittyWindow = env.KITTY_WINDOW_ID;
  const ghosttyDir = env.GHOSTTY_RESOURCES_DIR;
  const termVar = env.TERM;
  const termProgram = env.TERM_PROGRAM;
  const weztermPane = env.WEZTERM_PANE;
  const tmuxVar = env.TMUX;

  const isKitty = Boolean(kittyWindow);
  const isGhostty =
    Boolean(ghosttyDir) || termVar === 'xterm-ghostty';
  const isWezterm =
    Boolean(weztermPane) || termProgram === 'WezTerm';

  const outerSupported = isKitty || isGhostty || isWezterm;

  // 3. tmux passthrough: TMUX is set AND the outer terminal supports Kitty.
  //    IMPORTANT: tmux is checked BEFORE native because when running inside
  //    tmux, both TMUX and the outer terminal vars (KITTY_WINDOW_ID etc.) are
  //    set simultaneously in tmux pane processes. The surface the user actually
  //    sees is the tmux multiplexer, so we must use passthrough — direct native
  //    APC sequences are intercepted and eaten by tmux unless wrapped in DCS.
  if (tmuxVar && outerSupported) {
    return { transport: 'tmux' };
  }

  // 4. Direct native support (no tmux wrapper).
  if (outerSupported) {
    return { transport: 'native' };
  }

  return { transport: 'unsupported' };
}

// ---------------------------------------------------------------------------
// Chunk encoding
// ---------------------------------------------------------------------------

/**
 * Encode a base64 image payload into Kitty APC escape sequences.
 *
 * @param b64        Full base64-encoded image data.
 * @param firstChunkKeys  Key=value pairs for the FIRST chunk (includes a=T, f=100, etc.).
 * @returns Array of raw escape-sequence strings (NOT chalk-colored — control
 *          sequences must not go through the palette).
 */
export function buildKittyChunks(
  b64: string,
  firstChunkKeys: Record<string, string | number>,
): string[] {
  const chunks: string[] = [];
  const total = b64.length;

  for (let offset = 0; offset < total || offset === 0; offset += KITTY_CHUNK_SIZE) {
    const slice = b64.slice(offset, offset + KITTY_CHUNK_SIZE);
    const isLast = offset + KITTY_CHUNK_SIZE >= total;
    const isFirst = offset === 0;

    const keys: Record<string, string | number> = isFirst
      ? { ...firstChunkKeys, m: isLast ? 0 : 1 }
      : { m: isLast ? 0 : 1 };

    const keyStr = Object.entries(keys)
      .map(([k, v]) => `${k}=${v}`)
      .join(',');

    // APC: ESC _ G <keys> ; <data> ESC \
    chunks.push(`\x1b_G${keyStr};${slice}\x1b\\`);
  }

  return chunks;
}

/**
 * Wrap a single Kitty APC sequence in a tmux DCS passthrough.
 * The inner ESC must be doubled (ESC ESC) for tmux to forward it.
 *
 * Reference: https://github.com/nicm/tmux/blob/master/tools/kitty-graphics.py
 */
export function wrapForTmux(apc: string): string {
  // Double all inner ESC characters so tmux forwards them.
  const escaped = apc.replaceAll('\x1b', '\x1b\x1b');
  return `\x1bPtmux;${escaped}\x1b\\`;
}

// ---------------------------------------------------------------------------
// Dimension helper
// ---------------------------------------------------------------------------

/**
 * Clamp pixel dimensions to terminal row/col estimates and return
 * `{c, r}` key-value pairs for the Kitty protocol payload.
 *
 * We request at most MAX_COLS columns and MAX_ROWS rows, letting the
 * terminal scale the image to fit within that box. Pass `termCols` from
 * `process.stdout.columns` so the request never exceeds the actual terminal
 * width.
 *
 * @param pixelW   Image pixel width (0 → skip).
 * @param pixelH   Image pixel height (0 → skip).
 * @param termCols Terminal width in columns (fallback to MAX_COLS).
 * @returns Object with `c` (columns) and `r` (rows) to request.
 */
export function computeImageCellDimensions(
  pixelW: number,
  pixelH: number,
  termCols: number,
): { c: number; r: number } {
  if (pixelW <= 0 || pixelH <= 0) {
    return { c: Math.min(MAX_COLS, termCols), r: MAX_ROWS };
  }

  // Assume a typical cell aspect ratio of ~2:1 (width:height in pixels).
  // This is a rough estimate; the terminal always makes the final call.
  const cellPixelW = 10; // typical font cell width in px
  const cellPixelH = 20; // typical font cell height in px

  const rawCols = Math.ceil(pixelW / cellPixelW);
  const rawRows = Math.ceil(pixelH / cellPixelH);

  const c = Math.min(rawCols, MAX_COLS, termCols > 0 ? termCols : MAX_COLS);
  const r = Math.min(rawRows, MAX_ROWS);

  return { c: Math.max(1, c), r: Math.max(1, r) };
}

// ---------------------------------------------------------------------------
// High-level emitter
// ---------------------------------------------------------------------------

/**
 * Emit a PNG/JPEG/WebP image inline to `writeFn` using the Kitty Graphics
 * Protocol, then emit a trailing newline to advance the cursor past the image
 * rows.
 *
 * Safe to call only when:
 *   - `isTTY` is true
 *   - `detectKittySupport().transport !== 'unsupported'`
 *   - The compositor has settled (see TUI ordering constraint in module JSDoc)
 *
 * @param imagePath  Absolute path to the image file.
 * @param writeFn    Raw write function (e.g. `process.stdout.write.bind(process.stdout)`).
 * @param transport  `'native'` or `'tmux'` from `detectKittySupport()`.
 * @param termCols   Terminal width in columns (for dimension capping).
 * @returns `true` on success, `false` if the file could not be read.
 */
export function emitKittyImage(
  imagePath: string,
  writeFn: (data: string) => void,
  transport: KittyTransport,
  termCols: number,
): boolean {
  if (transport === 'unsupported') return false;

  let imageBuffer: Buffer;
  try {
    // Invariant: synchronous read. The caller invokes this inside a compositor
    // commit closure, and the raw stdout write must land at that exact point
    // in the paint sequence. An async read would defer the write past later
    // compositor repaints and interleave escape bytes with overlay rows.
    imageBuffer = fs.readFileSync(imagePath);
  } catch {
    return false;
  }

  const b64 = imageBuffer.toString('base64');

  // Detect pixel dimensions from PNG/JPEG header bytes for the c= r= hints.
  // Falls back to capped defaults when detection fails or format is unknown.
  let pixelW = 0;
  let pixelH = 0;
  if (imageBuffer.length >= 24) {
    // PNG: signature 8 bytes, then IHDR chunk. Width at offset 16, height at 20.
    if (
      imageBuffer[0] === 0x89 &&
      imageBuffer[1] === 0x50 &&
      imageBuffer[2] === 0x4e &&
      imageBuffer[3] === 0x47
    ) {
      pixelW = imageBuffer.readUInt32BE(16);
      pixelH = imageBuffer.readUInt32BE(20);
    }
    // JPEG: SOI marker FF D8, then scan for SOF0/SOF2 (FF C0 / FF C2)
    else if (imageBuffer[0] === 0xff && imageBuffer[1] === 0xd8) {
      let off = 2;
      while (off + 3 < imageBuffer.length) {
        if (imageBuffer[off] !== 0xff) break;
        const marker = imageBuffer[off + 1]!;
        const len = imageBuffer.readUInt16BE(off + 2);
        if ((marker === 0xc0 || marker === 0xc2) && off + 8 < imageBuffer.length) {
          pixelH = imageBuffer.readUInt16BE(off + 5);
          pixelW = imageBuffer.readUInt16BE(off + 7);
          break;
        }
        off += 2 + len;
      }
    }
  }

  const { c, r } = computeImageCellDimensions(pixelW, pixelH, termCols);

  const firstChunkKeys: Record<string, string | number> = {
    f: 100, // PNG format
    a: 'T', // action: transmit + display
    c,
    r,
  };

  const apcChunks = buildKittyChunks(b64, firstChunkKeys);

  for (const apc of apcChunks) {
    const payload = transport === 'tmux' ? wrapForTmux(apc) : apc;
    writeFn(payload);
  }

  // Advance cursor past the rendered image rows with a newline.
  writeFn('\n');
  return true;
}
