/**
 * OSC 8 terminal hyperlink support.
 *
 * Lets the tool lane keep its compact display text (`x.ts`) while making it
 * a real clickable link whose target is the full absolute `file://` path —
 * dissolving the "clickable paths vs. clean layout" trade-off. The escape
 * sequences are zero display width (`string-width` skips OSC), so emitting
 * a hyperlink never changes wrapping, truncation budgets, or alignment.
 *
 * Wire format (ST-terminated; BEL also valid but ST is the modern form):
 *
 *   ESC ] 8 ; params ; URI ST  <visible text>  ESC ] 8 ; ; ST
 *
 * Capability detection is conservative-allowlist: only terminals known to
 * render OSC 8 as clickable links get the escapes. Unsupported terminals
 * would *usually* ignore them gracefully, but Apple Terminal and old VTEs
 * can show garbage, and tmux requires passthrough config — so unknowns get
 * plain text. Degradation is purely cosmetic (the short path, exactly as
 * today).
 *
 * env-access note: this module reads terminal-capability vars (TERM_PROGRAM,
 * TMUX, FORCE_HYPERLINK, …) via an injectable `NodeJS.ProcessEnv` parameter
 * defaulting to `process.env` — the same injectable-test-seam pattern as
 * `src/cli/terminal-spawn/`. The audit script skips default-param seams, and
 * these OS-level / community-convention vars (FORCE_HYPERLINK mirrors
 * FORCE_COLOR's convention but is read here, not via `env.X`) are outside
 * the AFK domain and intentionally not in ENV_REGISTRY.
 */

import { pathToFileURL } from 'node:url';
import { detectTerminal } from './terminal-spawn/detect.js';

/** OSC 8 close sequence — ends the most recent hyperlink span. */
export const OSC8_CLOSE = '\x1b]8;;\x1b\\';

/**
 * Terminals (by `detectTerminal` kind) known to render OSC 8 hyperlinks.
 *
 * Included: iTerm2 (≥3.1), WezTerm, kitty, VS Code (≥1.72 — also covers
 * Cursor, which reports TERM_PROGRAM=vscode), Ghostty, Windows Terminal
 * (≥1.4), Konsole, GNOME/VTE family (≥0.50 — VTE_VERSION-gated below),
 * Alacritty (≥0.11).
 *
 * Excluded: Apple Terminal (no support), Hyper (plugin-dependent),
 * tmux (requires user passthrough config; the host terminal is hidden),
 * unknown.
 */
const HYPERLINK_TERMINALS = new Set([
  'iterm2',
  'wezterm',
  'kitty',
  'vscode',
  'ghostty',
  'windows-terminal',
  'konsole',
  'gnome-terminal',
  'alacritty',
]);

/** Minimum VTE_VERSION with OSC 8 support (0.50.0 → "5000"). */
const VTE_MIN_VERSION = 5000;

/**
 * Pure capability check. Order:
 *  1. FORCE_HYPERLINK — explicit override both ways (`0`/`false` disables,
 *     any other non-empty value enables). Mirrors the FORCE_COLOR convention
 *     and the `supports-hyperlinks` npm package.
 *  2. Not a TTY, or CI set → off (piped output / log collectors).
 *  3. Terminal allowlist via detectTerminal; VTE family additionally
 *     version-gated.
 */
export function supportsHyperlinks(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = process.stdout.isTTY === true,
): boolean {
  const force = env['FORCE_HYPERLINK'];
  if (force !== undefined && force.length > 0) {
    return force !== '0' && force.toLowerCase() !== 'false';
  }
  if (!isTTY) return false;
  if (env['CI'] !== undefined && env['CI'].length > 0) return false;

  const kind = detectTerminal(env);
  if (!HYPERLINK_TERMINALS.has(kind)) return false;
  // VTE family: detectTerminal returns 'gnome-terminal' for both the real
  // gnome-terminal (GNOME_TERMINAL_SCREEN) and the generic VTE_VERSION
  // catch-all (Tilix, XFCE4, …). Gate both on a modern-enough VTE when the
  // version is advertised.
  if (kind === 'gnome-terminal' && env['VTE_VERSION'] !== undefined) {
    const vte = Number.parseInt(env['VTE_VERSION'], 10);
    if (!Number.isFinite(vte) || vte < VTE_MIN_VERSION) return false;
  }
  return true;
}

let cached: boolean | undefined;

/**
 * Cached process-level capability check. Detection is a pure function of
 * env + stdout TTY-ness, neither of which changes mid-process, so we
 * evaluate once on first use.
 */
export function hyperlinksEnabled(): boolean {
  if (cached === undefined) cached = supportsHyperlinks();
  return cached;
}

/** Test seam: clear (or pin) the cached capability result. */
export function resetHyperlinksEnabledForTest(value?: boolean): void {
  cached = value;
}

/**
 * Wrap `text` in an OSC 8 hyperlink pointing at `url`. The caller is
 * responsible for ensuring `url` contains no raw control bytes — use
 * {@link fileHyperlink} for filesystem paths, which percent-encodes via
 * `pathToFileURL`.
 */
export function hyperlink(text: string, url: string): string {
  return `\x1b]8;;${url}\x1b\\${text}${OSC8_CLOSE}`;
}

/**
 * Wrap `text` in a hyperlink targeting an absolute filesystem path as a
 * `file://` URL. `pathToFileURL` percent-encodes spaces, unicode, and any
 * control bytes, so adversarial path content cannot smuggle escape
 * sequences through the URI portion. Fail-open: if URL conversion throws
 * (relative path, malformed input), returns `text` unchanged.
 */
export function fileHyperlink(text: string, absolutePath: string): string {
  try {
    return hyperlink(text, pathToFileURL(absolutePath).href);
  } catch {
    return text;
  }
}
