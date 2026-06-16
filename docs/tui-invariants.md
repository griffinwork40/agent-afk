# TUI Invariants

The agent-afk TUI is built on three protocols whose contracts are governed by sources outside the source file you're editing: the VT/xterm spec (DECSTBM, CUP), `log-update`'s internal line tracker, and the compositor's lifecycle phases. Bugs in this subsystem are almost never raw-ANSI leaks or shared-state races. They are **invariant violations inside centralized owners** — and they recur because the external constraint isn't named at the call site, so the next author can't see it.

This doc names the three risk-site classes, the comment shape they require, and the existing embodiments already in the codebase.

## The pattern

1. **Name the externally-governed constraint.** What invariant does the call site depend on that isn't visible in the surrounding code? (e.g., "`CSI r` homes cursor to (1,1)", "log-update's first frame anchors at current cursor row", "`disposed` flag must be set synchronously before any await")
2. **Emit the constraint as a code comment, not just in reasoning.** Future authors read the call site, not your PR description.
3. **For matched teardown/setup pairs, write teardown above setup in source order.** The inverse must be visible from the setup line.
4. **No optimistic rendering** — never emit a UI update before its dependent write has a confirmed result.

Source: pattern card `agents-fail-ordered-sequences-when-constraint-is-externally-governed`.

## Risk-site classes

### 1. DECSTBM scroll-region operations

**Protocol owner:** VT100/xterm spec — `CSI {top};{bottom}r` sets the scroll region AND unconditionally homes the cursor to `(1,1)`.

**Invariant:** Every DECSTBM emit must either (a) be bracketed by `\x1b[s`/`\x1b[u` save/restore, or (b) carry a comment explaining why cursor-home is intentional at this site.

**Recurrence vector:** Author sets a scroll region to wrap an unrelated write, forgets the cursor moves to (1,1), the next thing rendered clobbers content at the top of the screen.

### 2. log-update calls

**Protocol owner:** `node_modules/log-update/index.js:230` — the first `render()` call writes at the **current cursor row** with no preceding cursor movement. All subsequent repaints anchor relative to that first frame.

**Invariant:** Before the first `log-update.render()` of a session, the cursor must be at the row you want the overlay to anchor to (typically `stdout.rows - 1`). After `log-update.clear()`, call `log-update.done()` to restore cursor visibility — `clear()` alone leaves the cursor hidden.

**Recurrence vector:** A status-line setup or banner-print bracketed its writes with save/restore but left the cursor mid-screen; log-update's first frame anchors there; the overlay is stranded at the wrong row for the rest of the session.

### 3. Lifecycle-dependent state resets

**Protocol owner:** Internal — the compositor and stream renderer have phase transitions (`armed`/`disposed`, `streaming`/`idle`, owned/borrowed) whose invariants are enforced by ordering rather than types.

**Invariant:** Setting the lifecycle flag must happen **synchronously before any `await`** that could let an interval timer, resize handler, or other deferred callback re-enter the object. Borrow-dispose sequences must use per-step `try/catch` so a throw in one step doesn't skip the others. Teardown is written above setup in source order.

**Recurrence vector:** Author adds an `await` between two cleanup steps; an 80ms timer fires in the gap and mutates state the next step assumes is quiescent; the safety-net cleanup then clobbers the timer's writes.

## Comment shape

```ts
// External constraint (<protocol name>): <invariant in one to three sentences>.
//
// <Optional: why this site needs the constraint, what breaks without it,
// citation to the spec / library source / commit that established the rule>.
```

Grep the prefix `External constraint` to find every site. The labelled form `External constraint (<protocol>):` is preferred and dominant; a few older sites use the bare `External constraint:` form, so grep the **unparenthesised** prefix to catch both. New protocol invariants extend the catalog by grep, not by re-deriving the rule.

## Existing embodiments

Each site below already carries an `External constraint` comment. **Cite them by grep anchor, never by line number.** Filenames and line numbers drift across refactors — `commitAbove` may live in `terminal-compositor.committed-band.ts` or `terminal-compositor.committed-band-commit.ts`; SIGWINCH/drain handling in `terminal-compositor.ts` or `terminal-compositor.lifecycle.ts` — so the searchable comment text is the only stable anchor. Every anchor below was verified to resolve in the current tree.

### DECSTBM scroll-region

| Site | Grep anchor |
|---|---|
| `commitAbove()` band write | `External constraint (DECSTBM contract): when a StatusLine is active` |
| readline `onSubmit` echo | `External constraint (DECSTBM contract): the StatusLine reserves` |
| `StatusLine.withFullScrollRegion()` | `External constraint (VT100/DECSTBM contract)` |
| `StatusLine` DECSTBM cursor-home rule | `External constraint (DEC VT spec)` |

### Lifecycle / ordered-operation sequences

| Site | Grep anchor |
|---|---|
| skill-borrow `onCancel` capture | `External constraint (ordered-operation sequence): we MUST capture` |
| `commitPending` before `drainSubagent` | `External constraint (pattern card: ordered-sequences governed by` |
| dedup-tail flush after `disarm()` | `External constraint (pattern card: ordered-sequences): this MUST run` |
| SIGWINCH geometry reset | `External constraint (terminal resize semantics): SIGWINCH` |
| teardown drain ordering | `External constraint (drain ordering): disable bracketed-paste BEFORE` |

Bare-form sites (no parenthesised label — find them with the unparenthesised `External constraint` grep): the streaming→idle ordering in `setInputMode` (`→ 'idle'` … `onSubmit` MUST fire first), the `Ctrl+L` clear-screen ordering in `input/reader.ts`, and the `CommitCoordinator` "this call MUST come before any cleanup" rule in `stream-renderer.ts`.

### Tested, not yet annotated

Two invariants the regression tests in this PR (`describe('TerminalCompositor — protocol invariants')`) guard, but which do **not** yet carry an `External constraint` comment at the call site — add one on next touch:

- **`arm()` first-frame CUP anchor.** `arm()` now drives a `CupFrameRenderer` (not `log-update`); it still writes an explicit CUP to the bottom row before the first repaint, but the rationale lives only in the test. *(Test: "writes CUP to bottom row before the first repaint".)*
- **`disarm()` cursor-visibility restore.** The `clear()` → `done()` sequence carries an explanatory inline comment but not the `External constraint` tag. *(Test: "calls logUpdate.done() after logUpdate.clear()".)*

## Checklist for new TUI code

When touching `src/cli/terminal-compositor.ts`, `src/cli/_lib/stream-renderer*.ts`, `src/cli/input/`, or any file that calls log-update / writes ANSI escapes / manages a compositor lifecycle, answer before merging:

- [ ] Does this site depend on a contract from outside the source file? (VT spec, `log-update` source, lifecycle phase invariant)
- [ ] If yes, is the contract named in an `// External constraint (...)` comment at the call site?
- [ ] If this is a teardown/setup pair, does teardown appear above setup in source order?
- [ ] Is the inverse operation reachable from the setup line by reading downward in the same function?
- [ ] If this site mutates state during an `await`, is there a re-entrancy guard (flag, `disposed`, `committing`) checked synchronously?

## What this is not

- **Not an ESLint rule.** The 2025 audit confirmed every historical bug in this subsystem was a semantic protocol violation **inside** a centralized owner, not a raw-ESC leak outside one. Linting `\x1b` byte literals would flag the correct fixes as violations while catching none of the actual bugs.
- **Not a refactor brief.** `docs/rendering-architecture-desired.md` proposes the state-machine refactor for the entry lifecycle. This doc is the discipline for the call sites we already have, until and unless that refactor lands.
- **Not a runtime check.** A `withSavedCursor()` helper or a runtime cursor-position assertion would also work — and may be worth adding alongside. This doc is the cheaper first move.
- **Not a requirement for every commit.** Most TUI work doesn't touch a risk-site class. The checklist applies when you're inside one of the three protocols above.

## Recurrence record

When a new TUI bug ships and traces back to an unnamed invariant, add the site to the **Existing embodiments** table above as part of the fix PR — as a **grep anchor (the searchable comment text), never a line number**. Line numbers rot on the next refactor; the comment text is stable across line drift. The table is the load-bearing artifact — it converts a one-time fix into searchable institutional memory.
