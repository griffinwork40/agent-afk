# AFK TUI Architecture Map

> Generated 2026-09-26 from source read. Updated 2026-10-10 to reflect shipped work and the decided geometry plan (closes #3480).

---

## 1. Rendering Approach

**Stack:** Raw ANSI writes via a custom `CupFrameRenderer`. No ink, no blessed, no readline rendering.

`TerminalCompositor` (`src/cli/terminal-compositor.ts`, 1 225 LOC) orchestrates all frame output. Its dependencies split cleanly:

| Layer | File | Role |
|---|---|---|
| Frame renderer | `cup-frame-renderer.ts` (348 LOC) | Positions each line with absolute CUP (`\x1b[row;1H`) so no trailing `\n` is ever emitted in a live frame — fixes the "compositor drift / jumping" bug that `log-update`'s trailing newline caused (cup-frame-renderer.ts:6-30). |
| Escape constants | `cup-frame-renderer.escapes.ts` | `SYNC_START` / `SYNC_END` (synchronized-output, xterm/iTerm2/Apple Terminal), `CURSOR_HIDE/SHOW`, `CUP`, `ERASE_LINE`. |
| Status line | `status-line.ts` | Reserves the last terminal row via `DECSTBM` scroll region; repaints with raw ANSI. |
| Overlay composition | `src/cli/_lib/overlay-composer.ts` | Single `setOverlay` owner with a fixed z-order (thought-summary → thinking-live → markdown-pending → tool-lane → progress-banner → interrupt; source of truth: `src/cli/_lib/stream-renderer.ts`, the `new OverlayComposer(...)` call). The stage rail is a reserved footer row (`LoopStageBar`), not an overlay slot. Running subagents appear only as tool-lane Agent rows; the separate `subagent-status` stack was removed. Replaced 15+ racing direct `setOverlay` call sites. |

**Alt-screen:** None. The REPL preserves scrollback. `DECSTBM` reserves one row (status bar) and optionally additional rows (footer subsystems — verdict ledger, stage bar, mascot bar). Content committed above the live frame is archived to scrollback via `buildScrollbackArchiveEscape` (auto-wrap + `\n` at the bottom margin).

**`log-update`:** Removed in #3479. The dependency was the last live `dynamic import('log-update')` inside `initLogUpdateModule()` (`markdown-stream-format.ts`) which was only reachable from a TTY path without a compositor — a path confirmed unreachable in production: `StreamRenderer.arm()` always resolves a compositor before any `StreamingMarkdownRenderer` is constructed, and `afk chat` never uses `StreamingMarkdownRenderer` at all. The fallback branch in `executeRepaint` / `clearOverlay` and the `logUpdate` field on `StreamingMarkdownRenderer` have been removed. Non-TTY surfaces (Telegram, daemon) skip overlay painting via the `!isTTY` guard already present.

---

## 2. Markdown Streaming

**Renderer:** `StreamingMarkdownRenderer` (`src/cli/markdown-stream.ts`, 479 LOC) with pure helpers in `markdown-stream-format.ts` (400 LOC) and `markdown-stream-buffer.ts`.

**Strategy — two-region model:**
- **Committed** region: completed blocks, printed once, archived to scrollback via `compositor.commitAbove()`, never rewritten.
- **Pending** region: partial in-progress block, set via `compositor.setOverlay()` (routed through `OverlayComposer`) and rewritten on each new chunk at a 33 ms throttle.

**Block-boundary detection** (`markdown-stream-format.ts:isInOpenCodeFence`, `isInOpenTable`):
- Double `\n\n` — paragraph/section break.
- Closing fenced code fence (` ``` ` on its own line).
- Markdown list/heading boundaries.

**Partial-block previews** (`markdown-stream-format.preview.ts`): open code fences show real content (dimmed), not a placeholder; open tables show real pipe-delimited rows dimmed — full formatting deferred to commit.

**Inline syntax auto-close** (`markdown-stream-inline-close.ts`): synthetic closing `` ` `` / `**` / `_` appended to the pending buffer before rendering so mid-word bold or code doesn't leave the terminal in SGR state.

**Flicker risk:** The pending buffer is rewritten via `OverlayComposer.flush()` (single `setOverlay` call), and `CupFrameRenderer` wraps each frame in `SYNC_START`/`SYNC_END` — mitigating visible tearing on supporting terminals. Historical flicker from 15+ racing `setOverlay` calls was fixed by the `OverlayComposer` (overlay-composer.ts:7-19). Residual risk: a very fast 33 ms overlay repaint that arrives inside a `SYNC_START/END` pair can still cause a mid-word repaint flash on non-synchronized terminals.

**Marked** (`marked: ^17.0.5`) is used under `formatter.ts` / `formatter.block.ts` for committed-block rendering. No `marked-terminal` — chalk is applied in the formatter directly.

---

## 3. Input / Prompt Line

**No readline rendering.** The prompt is custom raw-mode:

- **Raw mode entry:** `src/cli/input/raw-mode.ts` — `setRawMode(true)` + bracketed-paste enable (`\x1b[?2004h`) atomically. Restored idempotently (guarded by a `restored` flag, raw-mode.ts:37) so double-restore from SIGINT + finally block is safe.
- **Keypress event loop:** `src/cli/input/reader.ts` (50 LOC entry) wired to `reader.keypress.ts`, `reader.keypress.nav.ts`, `reader.keypress.paste.ts`, `reader.keypress.submit.ts`.
- **Multi-line input:** `multi-line-reader.ts` + `input-box.ts`; `InputCore` (`input-core.ts`) manages the buffer with grapheme-correct cursor math.
- **Bracketed paste:** `src/cli/input/reader.keypress.paste.ts` — detects `ESC[200~` / `ESC[201~` markers; zero-char paste probes clipboard for image; non-empty paste calls `repaint()` then probes clipboard speculatively (paste.ts:43-58). Ctrl+V triggers an explicit clipboard-image attach.
- **History:** `src/cli/input/history.ts` (417 LOC ring buffer). Reverse search: `reader.reverse-search.ts`.
- **Autocomplete / slash suggestions:** `src/cli/input/suggest.ts` — Tier 1 (deterministic ghost text: prefix match against history + skills), Tier 2 (LLM fallback, debounced, opt-in). Dropdown rendered by `input/dropdown.ts`.
- **Ctrl+B (background):** Handled via `InputSurface.onBackground` closure (input-surface.ts:368); mutable per-turn handler set by `installBackgroundHandler` (input-surface.ts:450). Between turns the handler is cleared.
- **Ctrl+C:** Three-state: foreground shell abort → soft-stop or interrupt picker → double-within-1500ms exits (interactive.cleanup.ts:57-116).
- **Wide chars / emoji:** `string-width` used throughout the input path (echo.ts, reader.repaint.ts, dropdown.ts) for column-accurate cursor math.

---

## 4. Spinners / Status Line / Footer

**Spinner:** `SpinnerController` (`src/cli/input/spinner.ts`) — owns braille-frame ticker, verb rotation, and loading-tip slot. 80 ms interval. The controller never writes to terminal; it calls `onTick` which triggers a compositor `repaint()`. The compositor pulls `renderSpinnerRow()` / `renderTipRow()` in the same frame (spinner.ts:44-50). This avoids the historical ora-vs-log-update region-tracking race.

**Status line:** `StatusLine` (`status-line.ts`) — DECSTBM-reserved bottom row. Throttled repaints (100 ms default). Subscribes to `ResizeBus` for SIGWINCH, snapshotting `preResizePaintedRow` before the resize fires (status-line.ts:58).

**Footer stack** (bottom-up, `footer-subsystems.ts`): status line → verdict ledger → mascot bar → loop-stage bar → background-status bar → context pane. Each `setExtraRows(n+1)` before starting; teardown must run top→bottom exactly to avoid mis-painted ghost rows.

**Coexistence with streaming:** The spinner row is part of the live frame rendered by `CupFrameRenderer`. It is always the bottommost non-status row. The `OverlayComposer` renders above it in a fixed z-order. There is no timer race between spinner tick and stream-renderer repaint because both trigger `repaint()` on the same `TerminalCompositor` instance.

---

## 5. Tool-Call Display / Subagent / Background-Job Display

**ToolLane** (`commands/interactive/tool-lane.ts`, 855 LOC) buffers tool-use starts and results during a turn. Overlay renders live detail (max 6 root entries, `MAX_OVERLAY_ROOTS`); scrollback gets compact grouped summaries via `ToolLane.flush()`.

**Nesting / subagents:** `ToolLane` carries an `agentIdStack` and `ancestry` map. Entries are hierarchical — each subagent call is a child under an Agent entry; its tool calls are grandchildren. `tool-lane-render-children.ts` (547 LOC) renders the nested tree.

**Collapse on completion:** `feat(tui): collapse completed agent subtrees in scrollback` (#2174, commit `ebd1e518-ish`) — `tool-lane-render-compact.ts` renders compact one-line summaries for done agents in scrollback.

**Parallel-call badge:** `∥i/N` badge injected by `ToolLane.notifyToolActivity()` (tool-lane.ts:80-96). Cleared only when the dispatcher reports <2 active calls; `addResult()` deliberately does not clear it.

**Background jobs:** `BackgroundStatusBar` (`background-status-bar.ts`) and `BgResultNotifier` (`commands/interactive/bg-result-notifier.ts`) — DECSTBM-reserved footer rows above the status line.

**Failure bubbling:** `tool-lane.ancestry.ts:propagateChildFailure` — failure indicators bubble to parent agent rows (`feat(tui): bubble failure indicators`, #2171).

---

## 6. Resize (SIGWINCH) Handling, Width, Wide Chars

**Two-phase SIGWINCH handling** (`terminal-compositor.lifecycle.resize.ts`):
1. `handleResizeImmediate` — fires synchronously via `ResizeBus.subscribeImmediate()`, snapshots pre-resize ghost footprint into `pendingResizeErase`, calls `logUpdate.resetGeometry()`, marks `bandGeometryStale=true`. No I/O, no repaint.
2. Debounced subscriber (150 ms) fires `repaint()` — erases ghost rows from old geometry, repaints at new geometry.

**Between-turn resize** (`handleDisarmWindowResize`): called at re-arm time; detects SIGWINCH that arrived while disarmed; on EXPAND sets conservative ghost-erase target (row 1 → old bottom).

**Width computation:** `getTerminalWidth()` (`terminal-size.ts`) reads `process.stdout.columns`, defaulting to 80. Two-tier measure caps content: prose ≤80 cols (`DEFAULT_PROSE_MEASURE`), code/structure ≤100 cols (`DEFAULT_TEXT_MEASURE`), both overridable via env vars.

**Wide chars:** `string-width` is used in the input path (echo.ts, dropdown.ts, reader.repaint.ts), smoke-reveal.ts, and display.ts (`displayWidth`). `Intl.Segmenter` for grapheme splitting (display.ts:20-24). The committed-band path (`terminal-compositor.commit-text.ts:50-54`) uses `hardWrapToWidth` which wraps at columns, relying on wrap-ansi's built-in wide-char awareness. Wide chars in the markdown body or tool-lane output are handled by `wrap-ansi` at wrap time; they are not independently audited at paint time.

---

## 7. Teardown / Cleanup

**Ordering** (`terminal-compositor.lifecycle.teardown.ts`):
1. **`endTurnFlush()`** — before `disarm()`. Erases on-screen painted band rows (CUP+EL, no `\n`), archives entire committed band to scrollback, zeros band state.
2. **`disarm()`** — `logUpdate.clear()` (erases live frame), `flushPendingCommittedBand()` (no-op after step 1), clears spinner, restores cursor (`CURSOR_SHOW`), releases stdin claim.
3. **Signal handlers** (`interactive.cleanup.ts:installSignalHandlers`): SIGINT/SIGTERM/SIGHUP registered at REPL start. SIGTERM/SIGHUP: 2 s grace, then `runCleanupFunctions()` + `process.exit(0)`. SIGINT: three-state logic (shell abort → soft-stop / picker → double-Ctrl+C exit).
4. **Raw mode restore** (`raw-mode.ts:restore()`): idempotent, writes `DISABLE_BRACKETED_PASTE + setRawMode(false)` as one concatenated write.
5. **Bracketed paste disable:** both sequences share a single `stdout.write` drain boundary (raw-mode.ts:49-58).

**Crash path:** `runCleanupFunctions()` (cleanupRegistry) is the belt-and-suspenders; registered teardown closures run in reverse registration order. Best-effort stdout writes in `endTurnFlush` / `flushPendingCommittedBand` swallow write errors — assumes terminal may already be closed.

---

## 8. PTY Test Suite

**Location:** `tests/pty/` — 5 files, ~600 LOC total; 143 LOC test file.

**Infrastructure:** `node-pty` spawns a real OS pseudo-terminal sized to the scenario's `cols×rows`; output is accumulated until an APC sentinel. Bytes are replayed into `@xterm/headless` Terminal to reconstruct scrollback + viewport. The `isWrapped` flag on each buffer line detects hard-newline fragmentation (issue #540 axis-2).

**What it covers (`scenarios.ts`):**
- Committed-band geometry: content appears in scrollback (not viewport), no duplicate rows.
- `exactlyOnce` assertions: each output string appears exactly once in the full buffer.
- Blank-void detection: `maxViewportBlankRun` asserts at most N consecutive blank rows between content and live frame.
- `inScrollback` / `inViewport` / `absent` membership.
- Mid-scenario resize: `buildResizeMarker` / `findResizeMarker` sends SIGWINCH mid-stream; emulator replays pre-resize bytes, resizes, then post-resize bytes.
- Content-hug placement: every scenario runs twice (legacy bottom-pinned + `AFK_PTY_CONTENT_HUG=1`).
- Smoke-reveal effect (`SMOKE_GLYPHS`), subagent output, thinking blocks, tool-lane.

**What is NOT tested by the PTY suite:**
- Input path (keypress, paste, autocomplete, history) — those tests are in-process unit tests.
- Wide-char / emoji rendering accuracy in committed content.
- Multi-turn interactions (scenarios are single-turn drives with no `disarm()`).
- Spinner frame accuracy or timing.
- Crash / SIGTERM teardown sequence.
- Color output correctness (emulator's `translateToString` strips ANSI).
- Windows (node-pty on Windows is not covered in CI).

**Config:** `vitest.pty.config.ts` — excluded from default `pnpm test` run, serial (`fileParallelism: false`, `maxConcurrency: 1`), 60 s timeout, up to 2 retries.

---

## 9. Pain Points

### Open Issues (TUI-tagged or TUI-relevant)

| # | Title | Gist |
|---|---|---|
| **2143** | `feat(tui): inline terminal image rendering via Kitty graphics protocol` | No inline image support in the REPL surface. |
| **1609** | `feat(tui): status-line turn/budget indicator + parallel fan-out count` | Status line lacks live turn counter and parallel subagent count. |
| **3479** | `chore(tui): decide fate of log-update — one live dynamic import` | One live dynamic import on a compositor-less TTY path; the rest of the TTY surface is fully owned by `CupFrameRenderer`. |

**Closed:** #1619 (tool-lane row budget, `0fd9d2bd9`), #1505 (expandable bash output, `5da98b86b`), #2229 (content-hug banner overflow, `9c1748f09`).

### TODO/FIXME in src/cli

Only 2 non-test TODOs found (very low for the codebase size):
- `slash/_lib/create-skill-renderer.ts:40`: deferred `out` override.
- `slash/commands/init.ts:103`: explicit `out` override comment.

### Git Log Recurring Fix Themes (last 60 commits, `src/cli`)

| Theme | Representative commits |
|---|---|
| **Blank gap / void rows** above committed band | `fix(tui): cap blank gap above committed band on short terminals (#2182)`, `fix(tui): content-hug placement — no blank gaps (#2226)`, `fix(tui): erase displaced footer after banner scroll (#2231)`, `fix(tui): re-join on-screen committed-band rows on widen (#2234)` |
| **Ghost rows** after resize or overlay collapse | `fix(tui): resize-ghost` (multiple `.test.ts` regressions filed), `fix(tui): remove setTimeout race conditions in lifecycle module` |
| **Scrollback correctness** (single-copy invariant) | `fix(tui): scan OSC sequences past 254 bytes in smoke-reveal mask (#2250)`, `fix(tui): spine-continuation separator (#2196)` |
| **Content centering** wrapping/clipping | `fix(#2167): clip centered input viewport to prevent column-0 wrap` |
| **Overlay scrambling / stacking** | Fixed structurally by `OverlayComposer` but continues to generate repro tests |

---

## 10. Size and Complexity Hotspots

### Interactive subsystem

Hard-coded LOC counts drift quickly as the file-size ceiling (`pnpm audit:filesize:check`) forces splits. Every `src/cli` file now passes the 350-code-line gate (tracked in #3478). For a current ranked list run:

```bash
pnpm audit:filesize:check   # flags files approaching or over the ceiling
pnpm audit:funcsize:check   # flags functions over the 200-line ceiling
# or for a sorted list of the current worst offenders:
npx tsx scripts/check-function-size.ts --list
```

Notable structural changes since the map was first generated (2026-09-26):

- `terminal-compositor.input-dispatch.ts` was ~1 158 LOC; it has since been split into `.enter`, `.cursor`, `.editor-key`, and `.viewer-key` siblings.
- `commands/interactive/loop-iteration.ts` was ~861 LOC; it is now 267 lines after extraction of turn-orchestration helpers.
- `CommitGeometry` was extracted into `terminal-compositor.commit-geometry.ts`; the dev/test geometry guard lives in `terminal-compositor.geometry-assert.ts`.

The test files for the compositor remain much larger than the production source — `terminal-compositor.keypress.test.ts`, `terminal-compositor.ghost.test.ts`, `terminal-compositor.paste.test.ts` — indicating that the regression surface for geometry edge cases is wide and actively maintained.

---

## Top Pain Points (Ranked by Evidence)

1. **Blank-gap / void-row recurrence.** Four separate `fix(tui)` commits in 60 commits address blank rows appearing between committed content and the live frame. The root geometry is: content-hug places the frame immediately above the last committed line, but short terminals, widen events, and banner-scroll events each create new paths where that invariant breaks. The PTY suite tests it, but new paths keep emerging.

2. **Tool-lane row budget not respected (#1619) — SHIPPED.** Fixed in `0fd9d2bd9`; tool entries now wrap from the compositor frame row budget.

3. **No expandable output surface (#1505) — SHIPPED.** A scrollable in-TUI viewer for captured bash output landed in `5da98b86b` (PR #2739).

4. **Overlay racing still possible at the scroll-region boundary.** `OverlayComposer` eliminated intra-turn racing, but the compositor's `withFullScrollRegion` (status-line boundary) is still called by separate code paths during `endTurnFlush` and `disarm`. On very fast exit sequences this ordering must be exact; the `setTimeout` removal commit (`b062de37`) addressed the most visible instance.

5. **Content-hug first-reply banner overflow (#2229) — SHIPPED.** Fixed in `9c1748f09`; the content-hug strand exclusion is now scoped to frames with slack, preventing the banner scroll-off on first reply.

---

## Highest-Leverage Improvement Tracks

1. **Geometry invariant encapsulation — DONE (partial, per the decided plan).** `CommitGeometry` ships as a pure value object in `src/cli/terminal-compositor.commit-geometry.ts`; the dev/test guard lives in `terminal-compositor.geometry-assert.ts`. The research brief (`docs/tui-research-brief.md:81`) explicitly decided **not** to consolidate all compositor geometry in one pass: `geometryStale`, `prevTopRow`, `anchorFloor`, and `committedBandPaintedRows` carry reset and ordering invariants that make a single `CompositorGeometry` value type unsafe. Consolidation beyond `CommitGeometry` is a **deliberate non-goal** — do not reopen it.

2. **Tool-lane row-budget wrapping (#1619) — SHIPPED.** `ToolLane.getOverlay()` now receives the available row count from the compositor frame geometry and caps/truncates accordingly. Fixed in commit `0fd9d2bd9`.

3. **Expandable bash output (#1505) — SHIPPED.** An inline scrollable viewer for captured bash output landed in commit `5da98b86b` (PR #2739). The "▼ expand" affordance is live.

4. **PTY suite coverage gaps.** The suite does not test input (paste, history, autocomplete), wide-char committed-content, multi-turn geometry, or teardown. Adding one scenario each for: (a) wide-char content in committed band, (b) a SIGTERM mid-stream (to validate teardown ordering), and (c) a two-turn script, would materially increase regression coverage without much harness complexity.

5. **`log-update` removal.** ✅ Resolved in #3479. `log-update` has been removed from `package.json`. The `initLogUpdateModule` dynamic import, `LogUpdateFunction` type, and all `logUpdate` branches in `StreamingMarkdownRenderer`, `executeRepaint`, and `clearOverlay` are deleted. Non-TTY output writes committed content directly via `out.write`.

---

## Coverage Block

**Coverage confidence: HIGH**

Every named subsystem (renderer, markdown, input, spinner, teardown, resize, PTY test suite) was confirmed by direct source read with file:line citations. The package.json dependency list was verified directly.

**Known gaps:**
- `terminal-compositor.input-dispatch.ts` (1 158 LOC) was not read fully — the keypress routing detail beyond Ctrl+B / Ctrl+C was sampled, not exhaustively mapped.
- The `smoke-reveal.ts` visual effect (AFK_SMOKE_TEXT) was identified but not traced end-to-end.
- `_lib/stream-renderer.ts` per-subagent state machine internals were not fully traced.
- `.filesize-baseline.json` / `.funcsize-baseline.json` keys were empty in the root (the files exist but parsing produced no output), so function-level hotspot ranking is from LOC only.

**Tacit knowledge risk: LOW**

The codebase has unusually dense inline documentation (every module starts with a multi-paragraph JSDoc explaining root cause, design invariants, and ordering constraints). The invariants are explicit in code and comments, not tribal knowledge. The main tacit risk is the exact ordering of `endTurnFlush → disarm → signal-handler teardown`, which is documented in `teardown.ts` but only testable via the PTY suite.
