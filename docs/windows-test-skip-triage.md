# Windows Test Skip Triage — Issue #1604

Classification of all win32-gated test sites (R4 in `pnpm audit:posix:list`), excluding
files handled by PR #2730 (`load-entrypoints`, `copy-bundled-plugins`, `postinstall`).

Total R4 sites in scope: **99** across **37 files** (30 already modified in this PR).

---

## Category Summary

| Category | Sites | Meaning |
|---|---|---|
| **Genuinely POSIX-only** | 74 | POSIX APIs with no Windows equivalent: `chmod`/`statSync` mode bits, `/bin/sh` scripts, POSIX signals (`SIGKILL`), symlink semantics, ANSI caps on real subprocesses |
| **Platform-specific service** | 13 | macOS (launchd) or Linux (systemd) — the entire module is OS-specific by design |
| **TODO: needs native equivalent** | 11 | Could run on Windows with a Windows-aware mock or path fix |
| **Windows-positive (runIf)** | 1 | Gated TO Windows (drive-letter topology test in `bash-restriction-hook.test.ts`) |

---

## Per-File Breakdown

### Genuinely POSIX-only (74 sites)

| File | Skip sites | Reason |
|---|---|---|
| `src/agent/tools/handlers/bash.test.ts` | 10 | Real subprocess output caps, `SIGKILL` overflow, `/bin/sh` cwd enforcement |
| `src/agent/shell-jobs/streamer.test.ts` | 9 | Real shell subprocesses (`#!/bin/sh`, signals, caps) |
| `src/agent/hooks/config-bridge.test.ts` | 6 | Dispatches `#!/bin/sh` hook scripts |
| `src/agent/plugins/command-files.test.ts` | 5 | NUL-byte filenames forbidden by NTFS |
| `src/utils/atomic-write.test.ts` | 5 | POSIX `chmod`/`statSync` mode bits (0o600/0o644) |
| `src/agent/tools/hooks/bash-restriction-hook.test.ts` | 4 | POSIX path semantics + sensitive-path signal checks |
| `src/agent/tools/handlers/write-file.test.ts` | 2 | POSIX `chmod` read-only parent + EACCES mock |
| `src/agent/tools/handlers/overflow-telemetry.test.ts` | 2 | Real SIGKILL overflow via `/bin/sh` subprocess |
| `src/agent/tools/handlers/bash-capture.test.ts` | 2 | POSIX mode 0700 + SIGKILL capture path |
| `src/agent/tools/skill-bridge.test.ts` | 2 | POSIX-only escape-sequence filenames in tmpfs |
| `src/cli/slash/commands/diff.test.ts` | 2 | `test -e`/`touch`/`chmod` POSIX shell calls |
| `src/cli/commands/browser.test.ts` | 2 | POSIX mode bits 0o644/0o600 on mcp.json |
| `src/agent/tools/handlers/read-denylist.test.ts` | 1 | POSIX path semantics (one site; others are TODO) |
| `src/agent/tools/handlers/_cwd-utils.test.ts` | 1 | Symlink inside root via POSIX `fs.symlinkSync` |
| `src/agent/tools/handlers/_rg-availability.test.ts` | 1 | Spawns real `rg` binary via POSIX shell |
| `src/agent/tools/handlers/list-directory.test.ts` | 1 | POSIX symlink directory listing |
| `src/agent/tools/subagent/root-validation.test.ts` | 1 | POSIX symlink resolution |
| `src/agent/worktree/worktree-sweep-valve.test.ts` | 1 | Symlinked marker via `fs.symlinkSync` |
| `src/agent/worktree/worktree-root-registry.test.ts` | 1 | POSIX mode bits on worktree lock file |
| `src/agent/auth/keychain.test.ts` | 1 | POSIX mode 0o600 on credential file |
| `src/agent/hooks/command-executor.test.ts` | 1 | Dispatches `#!/bin/sh` scripts |
| `src/agent/hook-block-fidelity.bench.test.ts` | 1 | POSIX shell benchmark |
| `src/agent/abort-cascade.bench.test.ts` | 1 | Real process kill via POSIX signals |
| `src/agent/journal/writer.test.ts` | 1 | POSIX mode bits on journal file |
| `src/agent/prompt-dump.test.ts` | 1 | POSIX file write failure mock |
| `src/agent/trace/concurrent-emitter.bench.test.ts` | 1 | POSIX filesystem benchmark |
| `src/agent/trace/trace-completeness.bench.test.ts` | 1 | POSIX filesystem benchmark |
| `src/agent/transcript-search/transcript-index.test.ts` | 1 | POSIX symlink in index path |
| `src/agent/agents/registry.test.ts` | 1 | Control-byte filename via POSIX tmpfs |
| `src/agent/daemon/handoff-store.test.ts` | 1 | Linux-only `itOnLinux` guard (counted as POSIX) |
| `src/cli/render.test.ts` | 1 | `HOME`/`USERPROFILE` env swap via POSIX os.homedir() |
| `src/cli/login-command.test.ts` | 1 | POSIX mode 0o600 on env file |
| `tests/check-terminal-width.test.ts` | 1 | Spawns `node --import tsx/esm` via POSIX shell |

### Platform-specific service (13 sites)

| File | Skip sites | Reason |
|---|---|---|
| `src/service/launchd.test.ts` | 8 | macOS launchd — `!darwin` guard, service is macOS-only by design |
| `src/service/systemd.test.ts` | 5 | Linux systemd — `!linux` guard, service is Linux-only by design |

### TODO: needs native equivalent (11 sites)

| File | Skip sites | Issue / blocker |
|---|---|---|
| `src/agent/memory/memory-store.test.ts` | 3 | SQLite EBUSY on teardown: better-sqlite3 file handle not closed when constructor throws — GC non-deterministic on Windows |
| `src/agent/tools/handlers/read-denylist.test.ts` | 4 | 8.3 short-path vs long-path mismatch: `homedir()` may return `C:\Users\RUNNER~1` while `BUILTIN_READ_ALLOWLIST` uses the long form |
| `src/agent/tools/handlers/read-denylist-carveout.test.ts` | 1 | Same 8.3 / long-path root cause as above |
| `src/cli/clipboard.test.ts` | 2 | OSC 52 fallback tests: `clip.exe` intercepts before fallback fires; need mock-tool variant that forces the fallback path |
| `src/agent/tools/hooks/bash-restriction-hook.test.ts` | 1 | Windows-positive `runIf` for drive-letter topology (NOT a skip — included for completeness) |

---

## Proposed Follow-up Issues

These are triage findings only — **do not open issues from this PR**. The issues below
should be opened separately by a maintainer after review.

### Issue A: SQLite EBUSY teardown in `memory-store.test.ts`

**Scope:** `src/agent/memory/memory-store.test.ts` (3 skip sites: lines 287, 484, 531)

**Problem:** When `MemoryStore` constructor throws mid-open (mocked `pragma` failure),
the `better-sqlite3` file handle is not returned to the caller and cannot be closed before
`afterEach` calls `rmSync`. On Windows, this leaves the SQLite WAL file locked (EBUSY)
and the cleanup fails.

**Proposed fix:** Ensure `MemoryStore` closes the partial handle in its own `catch`
before rethrowing, so the file is always releasable. Alternatively, use a short
`setTimeout`/retry in `afterEach` before rmSync.

**Label:** `windows-compat`, `bug`

---

### Issue B: 8.3 short-path vs long-path in `read-denylist` tests

**Scope:** `src/agent/tools/handlers/read-denylist.test.ts` (4 sites: lines 266, 348, 367, 449, 460)
and `src/agent/tools/handlers/read-denylist-carveout.test.ts` (line 123)

**Problem:** On Windows CI, `os.homedir()` may return the 8.3 short form
(`C:\Users\RUNNER~1`) while `BUILTIN_READ_ALLOWLIST` entries are built from
`path.join(homedir(), rel)` which uses the long form. `safeRealpath` resolves
symlinks but may not normalize 8.3 names, causing the denylist entries to not match.

**Proposed fix:** Normalize via `fs.realpathSync.native` at startup, or guard
`BUILTIN_READ_ALLOWLIST` construction with `realpathSync.native(homedir())`.

**Label:** `windows-compat`, `correctness`

---

### Issue C: clipboard OSC 52 fallback test

**Scope:** `src/cli/clipboard.test.ts` (2 sites: lines 158, 168)

**Problem:** The OSC 52 fallback fires on POSIX because all local clipboard tools
(xclip, pbcopy, etc.) fail on CI. On Windows, `clip.exe` succeeds, so the fallback
is never reached and the test cannot run as written.

**Proposed fix:** Add a mock-tool path that injects a failing tool list regardless of
platform, so the fallback test is entirely synthetic and platform-independent.

**Label:** `windows-compat`, `test-coverage`

---

## Notes

- All classification comments were added as `// Windows: genuinely POSIX-only — <reason>`,
  `// Skipped on Windows: <reason>`, or `// Windows: TODO needs native equivalent — <reason>`
  immediately above the skip guard.
- The posix-guard baseline was NOT updated in this PR (counts did not drop; baseline is
  enforced as a ceiling, so staying under passes).
- Files excluded per issue #1604 scope: `src/agent/plugins/load-entrypoints.test.ts`,
  `tests/copy-bundled-plugins.test.ts`, `tests/postinstall.test.ts`,
  `src/cli/postinstall.test.ts` (handled by PR #2730).
