/**
 * Best-effort clipboard write.
 *
 * Clipboard support is a convenience, not a correctness requirement — callers
 * (e.g. /fork) always print the value too. `copyToClipboard` therefore never
 * throws: a missing utility, a headless box, or a non-zero exit all resolve to
 * `false`, and the caller falls back to the printed text.
 */

import { spawnSync } from 'node:child_process';

interface ClipboardTool {
  cmd: string;
  args: string[];
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
 * Copy `text` to the system clipboard. Returns true if a utility accepted it,
 * false otherwise. `platform` is injectable for testing.
 */
export function copyToClipboard(text: string, platform: NodeJS.Platform = process.platform): boolean {
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
  return false;
}
