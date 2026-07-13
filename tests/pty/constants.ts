/**
 * PTY harness constants shared by the in-pty driver and the parent harness
 * (issue #541). Kept side-effect-free so the parent can import the sentinel
 * without executing the driver's top-level `main()`.
 */

/**
 * Completion marker emitted by the driver once a scenario has rendered its
 * final frame. An APC string (ESC _ ... ESC \): xterm ignores APC entirely, so
 * it produces no glyphs and triggers no scroll. The parent captures only the
 * bytes BEFORE this marker, so it never perturbs the geometry under test.
 */
export const PTY_DONE_SENTINEL = '\x1b_AFK_PTY_DONE\x1b\\';
