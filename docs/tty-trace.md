# TTY trace recorder (`AFK_TTY_TRACE`)

## Why this exists

A rare REPL rendering bug leaves a stale copy of the reply's last line in the
footer band directly under the idle `afk ›` prompt after a turn ends in tmux.
The bug is non-reproducible headlessly. `AFK_TTY_TRACE` lets you capture the
exact byte sequence written to the terminal so the write that left the stale row
can be identified by replaying it through a headless terminal emulator.

## How to capture

Set `AFK_TTY_TRACE` to an absolute (or `~/`-prefixed) path before starting the
interactive REPL:

```bash
AFK_TTY_TRACE=~/afk-tty.cast afk
```

The recorder installs itself before the first byte of REPL output and writes an
[asciinema v2](https://docs.asciinema.org/manual/asciicast/v2/) cast file at
that path. Every byte written to `stdout` **and** `stderr` is tee-d there in
real time using a sync file descriptor, so a crash loses at most the chunk in
progress — never the file. Terminal resize events are recorded as `"r"` events.

When `AFK_TTY_TRACE` is unset (the default), the recorder adds zero overhead —
no wrappers are installed, no file is opened.

## Privacy

> **Warning:** The cast file records **every byte** written to your terminal during the session — including prompts, source snippets, command output, model responses, and potentially credentials or secrets. The file is created with `0600` permissions (owner-read/write only), but it is not encrypted and may be captured by backup tools, synced to cloud storage, or accidentally shared.
>
> - Keep cast files in a directory excluded from cloud sync and backups.
> - Delete them as soon as the diagnostic work is done.
> - Never share a cast file without scrubbing it first.

## How to replay

Use the bundled replay script to feed the cast through a headless xterm and
inspect the screen state at any point:

```bash
# Print the final screen (all rows numbered):
pnpm exec tsx scripts/tty-replay.ts ~/afk-tty.cast

# Stop at a specific timestamp (seconds from start):
pnpm exec tsx scripts/tty-replay.ts ~/afk-tty.cast --at 4.2

# Stop at the first output event that contains a given string:
pnpm exec tsx scripts/tty-replay.ts ~/afk-tty.cast --until-match "afk ›"

# Override the starting size (the header size is used by default; a header of
# 0x0, recorded on a PTY with no window size, falls back to 80x24):
pnpm exec tsx scripts/tty-replay.ts ~/afk-tty.cast --cols 230 --rows 57
```

Output looks like:

```
── Terminal snapshot (230×57) ──

  h0: (scrollback rows are labelled h<n>)
  ...
── visible screen (rows are CUP-addressable) ──
   1: ╭─ ✓ Done ─────────
  ...
  48: afk  ›
  49:            CLI will use his signature ...   <-- the stale row: should be blank
  ...
  57: claude-opus-5-5 · ... (status line)

── End of snapshot ──
```

## Workflow for diagnosing the stale-row bug

1. Reproduce the session in tmux with `AFK_TTY_TRACE` set.
2. After the stale row appears, exit the REPL normally.
3. Run `tty-replay` with `--until-match "afk ›"` to find the snapshot at the
   moment the idle prompt appeared.
4. Check which rows below the prompt are non-blank — each non-blank row is a
   candidate stale write.
5. Use `--at <t>` to binary-search backward through the cast and find the exact
   write event that produced the stale content.

## Implementation notes

- Recorder: `src/cli/tty-trace.ts`
- Env var registration: `src/config/env.tty-trace.ts` (spread into `ENV_REGISTRY`)
- Install site: `src/cli/commands/interactive.ts` — before the ora spinner starts
- Uninstall site: `src/cli/commands/interactive.ts` — inside `rl.on('close', …)` before `runCleanupFunctions()`
- Replay script: `scripts/tty-replay.ts` (requires `@xterm/headless` devDependency)
- Tests: `src/cli/__tests__/tty-trace.test.ts`
