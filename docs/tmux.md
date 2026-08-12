# tmux Compatibility

agent-afk's interactive REPL is designed to work well inside tmux. This guide
covers recommended tmux configuration, known quirks, and how the two interact.

## Recommended tmux.conf settings

Add these to `~/.tmux.conf` for the best experience:

```tmux
# Fast escape — tmux adds its own escape-time delay on top of the app's.
# Default is 500ms; 10ms eliminates the lag on ESC / Alt combos.
set -sg escape-time 10

# Truecolor — tells tmux the outer terminal supports 24-bit color.
# Without this, tmux quantizes truecolor to the nearest 256-palette index.
set -g default-terminal "tmux-256color"
set -as terminal-features ",*:RGB"          # tmux ≥ 2.7 (preferred)
# set -ga terminal-overrides ",*256col*:Tc"  # tmux 2.2–2.6 (legacy)

# Clipboard — lets tmux forward OSC 52 clipboard writes to the outer
# terminal. Default is "external" which also works; "on" enables the
# tmux paste buffer too.
set -g set-clipboard on

# Focus events — forwards FocusIn/FocusOut to pane applications.
set -g focus-events on

# Extended keys — reports modifier state on Enter, arrows, etc.
# Required for Shift+Enter (soft newline) to work reliably.
set -g extended-keys on
```

## How agent-afk detects tmux

When `$TMUX` is set (always true inside a tmux pane), agent-afk identifies the
terminal as `'tmux'` and adjusts its behavior:

- **Clipboard (OSC 52):** Raw OSC 52 is emitted without DCS passthrough
  wrapping. tmux's built-in `set-clipboard` mechanism intercepts it and forwards
  to the outer terminal natively. This works with the default `set-clipboard
  external` — no `allow-passthrough` configuration needed.
- **Hyperlinks (OSC 8):** Disabled inside tmux. tmux does not forward OSC 8
  hyperlink sequences without `allow-passthrough on`, so they are suppressed to
  avoid rendering garbage.
- **Terminal title (OSC 2):** Set to `afk — <project>` at REPL start, switches
  to `afk — <project> · running` during turns, and resets on exit. Visible in
  tmux's window/tab list. Controlled by `AFK_TERM_TITLE` (on by default; set to
  `0` to opt out).

## Known quirks

### Ctrl-B (tmux prefix conflict)

tmux's default prefix key is `Ctrl-B`. agent-afk binds `Ctrl-B` in streaming
mode to "background the current turn." Since tmux intercepts the first
`Ctrl-B`, you need to press **`Ctrl-B` twice** — the first activates the tmux
prefix, the second sends the literal keystroke through to agent-afk.

Alternatively, add a different tmux prefix to avoid the double-tap:

```tmux
set -g prefix C-a
bind C-a send-prefix
```

### Shift+Enter (soft newline)

Shift+Enter inserts a newline without submitting. This requires the terminal to
report modifier state, which tmux only does with `extended-keys on`. Without
it, Shift+Enter behaves the same as Enter (submits the input).

### Escape delay

agent-afk sets an internal escape timeout of 50ms, but tmux adds its own
`escape-time` delay (default: **500ms**) on top. Without `set -sg escape-time
10`, pressing ESC to soft-stop a running turn will feel sluggish (~550ms).

### Theme auto-detection

agent-afk auto-detects light/dark background from the `COLORFGBG` environment
variable. tmux does **not** set `COLORFGBG`, so auto-detection always falls
back to dark inside tmux. Light-terminal users should set the theme explicitly:

```bash
# In ~/.afk/config/afk.env or shell profile:
export AFK_THEME=light

# Or per-launch:
afk interactive --theme light

# Or mid-session:
/theme light
```

### Color depth (Node ≤ 24)

On Node.js versions before 25.0.0, a bug in `tty.getColorDepth()` caused tmux
sessions to report 256-color support even when the outer terminal supports
truecolor (`COLORTERM=truecolor`). agent-afk detects this case and overrides
chalk to 24-bit color when both `$TMUX` and `COLORTERM=truecolor` are set.

If colors look wrong, verify your tmux has the `RGB` terminal feature (see
recommended config above) and that `$COLORTERM` is set:

```bash
echo $COLORTERM    # should print "truecolor" or "24bit"
```

### DEC Synchronized Output

agent-afk wraps frame updates in DEC Synchronized Output sequences
(`\e[?2026h`/`\e[?2026l`) to prevent tearing during fast streaming. tmux does
not forward these sequences, so there may be occasional visual tearing during
rapid LLM output that wouldn't occur in a bare terminal. This is cosmetic only.

### Scrollback

agent-afk uses cursor-home + erase-down (`\e[1;1H\e[J`) for in-place repaints,
which preserves tmux scrollback. The alternate screen (`\e[?1049h`) is not used
by the REPL, so `Ctrl-B [` (tmux copy mode) can scroll through the full
session history.

## Running multiple sessions

Griffin's typical workflow — multiple agent-afk sessions in parallel across
tmux windows — works out of the box:

- **Pane titles:** Each REPL sets its pane title to `afk — <project>`, visible
  in `tmux list-windows` and the status bar. Distinct project directories get
  distinct labels.
- **No shared state conflicts:** Sessions use independent state files keyed by
  session ID (`~/.afk/state/sessions/<id>/`). No file locks or port conflicts.
- **Signals:** SIGINT, SIGTERM, and SIGHUP are handled per-pane. Killing a tmux
  pane sends SIGHUP, which agent-afk handles gracefully (saves state, exits 0).

### Useful tmux commands for multi-session workflows

```bash
# See all agent-afk panes at a glance
tmux list-panes -a -F "#{session_name}:#{window_index}.#{pane_index} #{pane_title}"

# Capture the last 20 lines from a specific pane
tmux capture-pane -t <target> -p | tail -20

# Send input to a specific pane
tmux send-keys -t <target> "/exit" Enter
```
