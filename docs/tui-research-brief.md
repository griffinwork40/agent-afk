# TUI research brief: best approach to perfecting the agent-afk TUI

Written 2026-09-26. It merges a local code survey (the full map is in `docs/tui-architecture-map.md`) with an external survey of Claude Code, Codex CLI, opencode, gemini-cli, aider, and pi-tui.

## Main point

agent-afk already uses the architecture the leading tools have converged on. It renders inline with no alt-screen and keeps native scrollback. Finished blocks are written once into scrollback, and only a small live tail gets redrawn. It uses synchronized output (DEC mode 2026) and cursor-hide, has a custom raw-mode editor with bracketed paste, and tests through node-pty with @xterm/headless. So the remaining work is to make what exists correct and small. A rewrite is not needed.

The recurring bug class is **geometry**: blank gaps, ghost rows, and displaced footers. Two things cause it. First, rows are placed with absolute cursor positioning inside a reserved bottom scroll region with a multi-row footer stack. Second, the state that describes that geometry is spread across many modules.

## Correction to the external survey

The web survey recommended adding synchronized output, an @xterm/headless harness, and commit-above streaming, at an estimated 2 to 4 days. Checking the source showed that all three already exist:
- Synchronized output: `src/cli/cup-frame-renderer.batcher.ts:22-51`
- @xterm/headless harness: `tests/pty/harness.ts`, `tests/pty/compositor-scrollback.pty.test.ts`
- Commit-above streaming: `markdown-stream.ts` commits finished blocks through `compositor.commitAbove()`

One gap is real: **line-level diffing**. `cup-frame-renderer.ts:153-197` erases the whole previous frame and repaints all of it every frame. It does not compare against a buffer of the previous frame's lines.

## Evidence

- The compositor is spread across 96 `src/cli/terminal-compositor*` files totalling about 25.9k lines (tests included). `terminal-compositor.ts` has 1225 lines and `terminal-compositor.input-dispatch.ts` has 1158, both far over the 350-line ceiling.
- Recent geometry fixes in `git log -- src/cli`: #2226 (content-hug blank gaps), #2182 (capped the blank gap on short terminals), #2231 (displaced footer after banner scroll), #2212, #2174/#2180. The repro test files carry the same names: `*.shrink-gap`, `*.wrap-gap`, `*.commit-collapse-wrap-gap`, `*.ghost`.
- 52 non-test sites in `src/cli/*.ts` reference the reserved scroll region (DECSTBM).
- Open TUI issues: #2229 (first reply scrolls the banner off), #1619 (tool-lane wrap ignores the row budget), #1505 (no viewer to expand bash output), #1609 (status line lacks turn/budget/fan-out counts), #2143 (Kitty images), #2290 (content-hug follow-ups).

## Improvement tracks, ranked

### 1. One geometry model plus invariant tests (highest leverage)
Put all row accounting in one pure `CompositorGeometry` object: top of the committed band, target bottom row, anchor floor, hug slack, footer reservations, and terminal rows/columns. Every paint derives from it. Then write property-style tests that generate random sequences (stream N lines, resize, collapse the overlay, add or remove footer rows, commit) and check general invariants on the @xterm/headless buffer: no blank run above K rows between the band and the frame, every committed line appears exactly once, and there are no ghost rows. Claude Code reportedly unblocked its renderer rewrite with this kind of randomized testing. That report comes from a secondary source and is not verified.
- Tradeoff: large refactor of the most fragile code. It must happen in layers, behind the existing PTY suite.
- Effort: 1 to 2 weeks. This also shrinks the over-ceiling compositor files.

### 2. Line-level diffing in CupFrameRenderer
Keep the previous frame's lines. Find the first line that changed and repaint only from there. Fall back to a full repaint when the width or the top row changes. This is pi-tui's three-case strategy.
- Tradeoff: small and local. Most visible on terminals without synchronized output (tmux without the patch, Apple Terminal) and on SSH.
- Effort: 1 to 3 days. It interacts with track 1, so land it after the geometry model or together with it.

### 3. Broader PTY/headless coverage
Currently untested (from the local survey): the input path (keypresses, paste, autocomplete), wide characters and emoji in committed content, multi-turn sessions, SIGTERM mid-stream teardown, and SGR colour state (the emulator strips it; xterm-headless cell attributes could check it). Many regressions currently reach users before they reach tests.
- Effort: 2 to 4 days. Low risk. Best done first, as the safety net for tracks 1 and 2.

### 4. Feature polish from the backlog
In order of daily impact: #1619 (tool-lane wrap from the row budget), #2229 (banner and first reply), #1505 (expandable bash output, or a collapsed "N lines hidden" row with expand/copy), #1609 (status-line counters). #2143 (Kitty images) is optional.
- Effort: about 1 to 3 days each. Independent of each other, so they can be split across parallel worktrees (for example with /tackle-issues).

### 5. Opt-in alt-screen mode (a later escape hatch)
This is the equivalent of Claude Code's `CLAUDE_CODE_NO_FLICKER`. It gives no flicker and no geometry drift, because nothing ever writes into scrollback. The cost is rebuilding scrolling, search, and copy (via OSC 52) inside the app.
- Effort: several weeks. Consider it only if tracks 1 to 3 do not end the geometry bug class.

### Rejected
- **Adopt ink:** the tools that used it (Claude Code, gemini-cli) either replaced ink's output layer or spent months fighting flicker.
- **Adopt pi-tui wholesale:** it has the same model we already have, and porting the tool lane, subagent tree, and footer stack would cost more than borrowing its diffing technique.
- **Native Rust/Go renderer (Codex path):** Codex moved for packaging and sandboxing reasons, not rendering, and its DECSTBM history insertion has the same copy/paste and Zellij problems.

## Recommended path
Do track 3 first (the safety net), then track 1 (the geometry model and invariant tests, which also split the over-ceiling files), then track 2 (line-level diffing). Run track 4 alongside in parallel worktrees, since it does not touch the geometry core. Keep track 5 in reserve.

## Open questions
1. Which terminals does Griffin actually use daily (Ghostty? iTerm2? tmux, and which build)? This decides how much track 2 matters, because synchronized output already hides full repaints on terminals that support it.
2. Is content-hug mode the long-term default? A lot of the geometry complexity serves it (#2226, #2229, #2290).
3. Does Goblin Portal (Griffin's own terminal) change the terminal target? It could guarantee synchronized output and Kitty graphics.
4. How much should the footer stack (verdict ledger, mascot, loop-stage bar, background bar, context pane) be simplified before the geometry refactor? Every reserved row adds a geometry case.

## Not verified
- The Claude Code renderer internals (cell diff, packed TypedArrays, property tests) and the `CLAUDE_CODE_NO_FLICKER` details come from secondary sources (a thread aggregator, loomblog, a fork). The Codex, aider, and pi-tui claims cite source code and author writeups, so they are stronger.
- The gemini-cli TerminalBuffer internals and the opencode/OpenTUI Zig internals were not read from source.

---

## Addendum: devil's-advocate critique (2026-09-26)

Three critics (pragmatist, paranoid, architect) and one synthesis agent reviewed the recommended path above. A steelman critic was skipped because the agent wrote the proposal.

**Verdict:** the proposal did not survive as written. The revised plan is the paranoid alternative with the pragmatist's guard added. No critic dissents.

### Revised plan
1. **Add an `assertGeometryConsistent` guard first** at the compositor's public mutation entry points (`commitAbove`, `repaint`, `arm`, `disarm`). It throws only in dev and test, so production behaviour does not change. It catches split-reads, where different sites read `rows`, `extraRows`, or `anchorRow` and disagree. Known site: `commit-geometry.ts:34` reads `extraRows` fresh while its caller passes in a `rows` it captured earlier (`committed-band-commit.ts:142`, before a `repaint()` that can re-enter).
2. **Land the backlog fixes one at a time on main, not in parallel worktrees:** #1619, #2229, #1505, #1609. Each fix brings its own regression test as its merge gate. Parallel worktrees would conflict on the shared footer row-reservation code (`footer-subsystems.ts:101-115`).
3. **Timing-sensitive tests use `VirtualScreen`, not @xterm/headless.** @xterm/headless's parsing does not resolve under `vi.useFakeTimers()` (`terminal-compositor.resize-stale-width.repro.test.ts:243-244`). The "widen headless coverage" track becomes a gate on each fix instead of a separate workstream.
4. **Then extract `CommitGeometry` as a pure value object, and do nothing more.** Do not consolidate all compositor geometry in one pass: `geometryStale`, `prevTopRow`, `anchorFloor`, and `committedBandPaintedRows` carry reset and ordering invariants (`terminal-compositor.ts:499-549`).
5. **Drop line-level diffing.** Synchronized output already hides full repaints on terminals that support it, and a diff buffer that drifts from what is actually on screen after a resize would leave stale rows.
6. Keep the alt-screen mode in reserve, as before.

### Claims checked by the coordinator
- The "jumping" bug was caused by log-update's trailing `\n` at the reserved-region margin, not by keeping state between frames (`cup-frame-renderer.ts:10-27`). So line diffing with absolute cursor positioning would **not** bring back that exact bug. The synthesis agent overstated this. The real risk is the diff buffer going stale, and the benefit is small because synchronized output exists. The decision to drop diffing stands, for weaker reasons.
- The architect's alternative (a "last N rows live region" without the reserved scroll region) is **not** literally the design that failed: the failure needed log-update's trailing `\n` **and** the reserved region together. It is still the most expensive and riskiest option: it rewrites the core paths, replaces about 90 compositor tests, and makes content-hug hard. Rank: last.

### Ranking
| Option | Cost | Risk | Scope fit | Goal fit |
|---|---|---|---|---|
| Paranoid + guard (chosen) | Medium | Medium, and each commit reverts on its own | Strong | Strong |
| Pragmatist (guard + targeted fixes only) | Low | Low | Strong | Good; leaves geometry scattered |
| Original | High | High (the refactor and diffing both touch hot paths) | Partial | Partial |
| Architect (replace the screen model) | Very high | Very high | Weak | Uncertain |

**Strongest counter-argument:** if there is no capacity for four sequential PRs, the pragmatist's guard plus targeted fixes (about 80 lines) is the safer fallback.

**Not checked:** `frame.layout.ts:116`, the details of `footer-subsystems.ts:101-115`, and the bodies of the four backlog issues.
