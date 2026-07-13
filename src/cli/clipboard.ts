/**
 * Best-effort clipboard write.
 *
 * Clipboard support is a convenience, not a correctness requirement — callers
 * (e.g. /fork) always print the value too. `copyToClipboard` therefore never
 * throws: a missing utility, a headless box, or a non-zero exit all resolve to
 * `false`, and the caller falls back to the printed text.
 *
 * Two mechanisms, tried in order:
 *   1. Local OS utilities (pbcopy / clip / wl-copy / xclip / xsel). Preferred
 *      when present because they hit the machine's real clipboard directly.
 *   2. OSC 52 escape sequence written to the TTY. This is the *remote* path:
 *      over SSH (and SSH+tmux) the local utilities either don't exist or reach
 *      only the remote box, so a copy silently no-ops. OSC 52 instead rides the
 *      terminal's own byte stream back to the outer emulator (iTerm2, kitty,
 *      WezTerm, …), which owns the real clipboard. Inside tmux the sequence is
 *      wrapped in a DCS passthrough envelope; that path additionally requires
 *      `set -g allow-passthrough on` (and `set -g set-clipboard on`) in the
 *      user's tmux config, since passthrough is off by default in some tmux
 *      versions.
 *
 * env-access note: the OSC 52 path detects tmux by delegating to
 * `detectTerminal()` (the canonical $TMUX check, reused rather than
 * re-implemented), reading env via an injectable `NodeJS.ProcessEnv` parameter
 * defaulting to `process.env` — the same injectable-test-seam pattern as
 * `src/cli/hyperlink.ts` and `src/cli/terminal-spawn/`. The audit script skips
 * default-param seams, and TMUX is an OS-level var outside the AFK domain,
 * intentionally not in ENV_REGISTRY.
 */

import { spawnSync } from 'node:child_process';
import { detectTerminal } from './terminal-spawn/detect.js';

interface ClipboardTool {
  cmd: string;
  args: string[];
}

/**
 * Minimal writable-TTY seam so the OSC 52 emitter is unit-testable without a
 * real terminal. `process.stdout` satisfies it structurally.
 */
export interface Osc52Sink {
  write(chunk: string): boolean;
  isTTY?: boolean;
}

/**
 * Ordered list of clipboard utilities to try for a platform. The first one
 * present on PATH and exiting 0 wins. Exported for deterministic unit testing
 * of selection without spawning anything.
 */
export function clipboardToolsFor(platform: NodeJS.Platform): ClipboardTool[] {
  switch (platform) {
    case 'darwin':
      return [{ cmd: 'pbcopy', args: [] }];
    case 'win32':
      return [{ cmd: 'clip', args: [] }];
    default:
      // Linux/BSD: prefer Wayland (wl-copy), then X11 (xclip, xsel).
      return [
        { cmd: 'wl-copy', args: [] },
        { cmd: 'xclip', args: ['-selection', 'clipboard'] },
        { cmd: 'xsel', args: ['--clipboard', '--input'] },
      ];
  }
}

/**
 * Encode `text` as an OSC 52 clipboard-write sequence targeting the "c"
 * (clipboard) selection. Wire format: `ESC ] 52 ; c ; <base64> BEL`. The BEL
 * (`\x07`) terminator — rather than ST (`ESC \`) — keeps the sequence free of
 * interior ESC bytes, which simplifies the tmux passthrough escaping in
 * {@link wrapTmuxPassthrough}.
 */
export function osc52Copy(text: string): string {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  return `\x1b]52;c;${b64}\x07`;
}

/**
 * Wrap an escape `sequence` in tmux's DCS passthrough envelope so it reaches
 * the *outer* terminal instead of being swallowed by tmux. Wire format:
 * `ESC P tmux ; <payload> ESC \`, where every ESC byte in the payload is
 * doubled — tmux's passthrough escaping rule (the Neovim / tmux-yank approach).
 * Requires `set -g allow-passthrough on` in the user's tmux config.
 */
export function wrapTmuxPassthrough(sequence: string): string {
  const escaped = sequence.replace(/\x1b/g, '\x1b\x1b');
  return `\x1bPtmux;${escaped}\x1b\\`;
}

/**
 * Build the OSC 52 clipboard sequence for `text`, DCS-wrapped for tmux iff
 * we're inside tmux (`detectTerminal` returns `'tmux'`, i.e. `$TMUX` is set).
 * Pure: emission and TTY-gating live in {@link copyViaOsc52}.
 */
export function osc52ClipboardSequence(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const seq = osc52Copy(text);
  return detectTerminal(env) === 'tmux' ? wrapTmuxPassthrough(seq) : seq;
}

/**
 * Emit the OSC 52 clipboard sequence for `text` to a TTY. Returns true if the
 * sequence was written, false if the sink is not a TTY (piped/redirected — we
 * must never inject escape bytes into non-terminal output) or the write throws.
 *
 * "Written" is not "confirmed landed": OSC 52 has no acknowledgement, and an
 * outer terminal lacking OSC 52 support (or a tmux without passthrough enabled)
 * silently drops it. That is acceptable under the best-effort contract —
 * callers always print the text as a backup regardless.
 */
export function copyViaOsc52(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
  sink: Osc52Sink = process.stdout,
): boolean {
  if (sink.isTTY !== true) return false;
  try {
    // Ignore the write() backpressure boolean: a `false` return means "buffered"
    // (still queued), not "failed". Only a throw signals a real failure.
    sink.write(osc52ClipboardSequence(text, env));
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy `text` to the system clipboard. Returns true if a mechanism accepted it,
 * false otherwise. `platform`, `env`, and `sink` are injectable for testing.
 *
 * Order: local OS utilities first (they own the real clipboard when present),
 * then an OSC 52 fallback for the SSH / SSH+tmux case where no local utility
 * reaches the user's clipboard. The fallback is TTY-gated and never throws.
 */
export function copyToClipboard(
  text: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  sink: Osc52Sink = process.stdout,
): boolean {
  for (const tool of clipboardToolsFor(platform)) {
    try {
      const res = spawnSync(tool.cmd, tool.args, { input: text });
      // spawnSync reports a missing binary via res.error (ENOENT) rather than
      // throwing, so guard on both error and a clean exit status.
      if (!res.error && res.status === 0) return true;
    } catch {
      // Defensive: try the next tool on any unexpected throw.
    }
  }
  // Local utilities are absent or failed (the SSH / SSH+tmux case). Fall back
  // to OSC 52 over the terminal's own channel.
  return copyViaOsc52(text, env, sink);
}
