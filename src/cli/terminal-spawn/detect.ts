/**
 * Terminal-emulator detection from environment variables.
 *
 * There is no universal "open a new tab" primitive — capability varies wildly
 * per terminal — so the first step is identifying which terminal we're in.
 * Detection is a pure function of the environment, kept separate from spawning
 * so it can be unit-tested exhaustively without side effects.
 */

export type TerminalKind =
  | 'tmux'
  | 'wezterm'
  | 'kitty'
  | 'iterm2'
  | 'apple-terminal'
  | 'ghostty'
  | 'windows-terminal'
  | 'gnome-terminal'
  | 'konsole'
  | 'vscode'
  | 'alacritty'
  | 'hyper'
  | 'unknown';

export type SpawnCapability = 'tab' | 'window' | 'none';

// Invariant: detection order is load-bearing and must not be reordered
// casually. A user inside tmux inside Ghostty (or VS Code) has BOTH the
// multiplexer var (TMUX) and the host terminal's vars set simultaneously.
// tmux owns the surface the user actually sees and offers the cleanest,
// most portable new-tab API, so it must win — hence TMUX is checked first.
// Unique high-confidence vars (KITTY_WINDOW_ID, WEZTERM_PANE, WT_SESSION,
// KONSOLE_DBUS_SERVICE, GNOME_TERMINAL_SCREEN) come next; they never collide.
// TERM_PROGRAM (set by iTerm/Terminal/VS Code/Hyper) is checked after those,
// and TERM-based signals (xterm-ghostty, alacritty) last because TERM is the
// weakest signal (a user's `term =` config override can change it). VTE_VERSION
// is the final generic catch for VTE-family terminals (Tilix, XFCE4, …) that
// accept gnome-terminal's CLI syntax.
export function detectTerminal(env: NodeJS.ProcessEnv = process.env): TerminalKind {
  if (env['TMUX']) return 'tmux';
  if (env['KITTY_WINDOW_ID']) return 'kitty';
  if (env['WEZTERM_PANE']) return 'wezterm';
  if (env['WT_SESSION']) return 'windows-terminal';
  if (env['KONSOLE_DBUS_SERVICE']) return 'konsole';
  if (env['GNOME_TERMINAL_SCREEN']) return 'gnome-terminal';

  const termProgram = env['TERM_PROGRAM'];
  if (termProgram === 'iTerm.app') return 'iterm2';
  if (termProgram === 'Apple_Terminal') return 'apple-terminal';
  if (termProgram === 'vscode') return 'vscode';
  if (termProgram === 'Hyper') return 'hyper';

  const term = env['TERM'];
  if (term === 'xterm-ghostty' || env['GHOSTTY_RESOURCES_DIR']) return 'ghostty';
  if (term === 'alacritty') return 'alacritty';

  if (env['VTE_VERSION']) return 'gnome-terminal';
  return 'unknown';
}
