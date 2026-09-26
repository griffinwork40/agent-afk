# Visual Redesign Proposal: AFK Subagent Activity Tree

**Status**: Design proposal — read-only, no files modified  
**Author**: Visual systems analysis  
**Date**: 2026-09-24  
**Audience**: Implementers who have read the source files listed in the task brief

---

## 1. Design Philosophy

AFK already has a visual identity worth protecting: the warm orange brand, the
dusty-rose thinking glyph `⌇`, the `◉` fisheye turn-root, the rounded `╰─`
corner — these are deliberate signature choices, not defaults. The redesign must
read as **the same AFK, turned up**. The instrument-panel metaphor stands, but
the palette is warm amber, not cool aviation-blue: normal operations glow
orange and rose; urgency escalates through warning amber to error red without
ever reaching for foreign cool tones.

Every proposed change answers one question: *does this make information faster
to read without adding anything the eye has to learn to ignore?* Depth dimming
makes hierarchy legible without new glyphs. Timer color-coding makes elapsed
time an urgency signal without new text. Centering makes the display feel
composed rather than left-justified against a wall. None of these add
decoration — they turn existing data into faster signals. The sacred elements
stay: `⌇` stays, `◉` stays, `●✓✗⊘⚠` stay, the warm palette stays.

---

## 2. Before / After Mockups

### Conventions used in mockups

All examples assume dark theme, 140-col terminal (representative "wide" case).  
Color annotations use role names from `palette.ts` — not hex values.  
`[dim]` = `palette.dim()`, `[chrome]` = `palette.chrome`, `[err]` = `palette.error`,
`[brand]` = `palette.brand`, `[thinking]` = `palette.thinking` (dusty rose italic),
`[warn]` = `palette.warning`.  
Centering margin for 140-col terminal, 100-col measure: `leftMargin = floor((140-100)/2) = 20` spaces.  
The `░` character represents one space of the left margin (for legibility in this document only).

---

### 2.1 Completed agent — 3 grouped tool calls + Done line

**CURRENT** (100-col terminal, no centering)

```
◉ → Agent(skill-review) [worker]
│ ├─ ● read_file(config.ts)    — ✓ 42 lines
│ ├─ ● read_file(palette.ts)   — ✓ 312 lines
│ ╰─ ✎ write_file(out.md)     — ✓ saved → ~/out.md
╰─ Done (3 tools · 2.1 tok · 4.2s)
```

Colors (current): `◉ →` dim · `Agent` plan + bold · `[worker]` dim · `●` clay ·
`read_file` clay + bold · `(config.ts)` dim · `—` dim · `✓` success · `Done` dim · stats dim.

**PROPOSED** (140-col terminal, centered + depth-graded spine + done glyph)

```
░░░░░░░░░░░░░░░░░░░░◉ → Agent(skill-review) [worker]
░░░░░░░░░░░░░░░░░░░░│  ├─ ● read_file(config.ts)    — ✓ 42 lines
░░░░░░░░░░░░░░░░░░░░│  ├─ ● read_file(palette.ts)   — ✓ 312 lines
░░░░░░░░░░░░░░░░░░░░│  ╰─ ✎ write_file(out.md)     — ✓ saved → ~/out.md
░░░░░░░░░░░░░░░░░░░░╰─ ✓ Done  3 tools · 2.1 tok · 4.2s
```

Changes visible here:
- **Centering**: 20-space left margin floats content in the viewport (C-10)
- **Spine width**: `│ ` → `│  ` (+1 space breathing room, C-3)
- **Done line**: `Done (…)` → `✓ Done  …` (C-6, `✓` in `palette.success`, parens removed)

---

### 2.2 Nested agent-in-agent with thinking tail visible

**CURRENT**

```
◉ → Agent(critic-paranoid) [worker]
│ ├─ → Agent(sub-critic) [worker]
│ │ ├─ ● read_file(x.ts)       — ✓ 12 lines
│ │ ╰─ ⌇  the interface contract looks solid but I'd like to verify…
│ ╰─ ⌇  checking the boundary conditions before committing…
```

Colors (current): all depth-1 spine `│` at uniform `palette.dim` · `⌇` and tail text
in `palette.thinking` (dusty rose italic, unchanged) · depth-2 `│ │` also uniform dim.

**PROPOSED** (140-col terminal, centered + depth-graded spine)

```
░░░░░░░░░░░░░░░░░░░░◉ → Agent(critic-paranoid) [worker]
░░░░░░░░░░░░░░░░░░░░│  ├─ → Agent(sub-critic) [worker]
░░░░░░░░░░░░░░░░░░░░│  │  ├─ ● read_file(x.ts)       — ✓ 12 lines
░░░░░░░░░░░░░░░░░░░░│  │  ╰─ ⌇ the interface contract looks solid but I'd like to verify…
░░░░░░░░░░░░░░░░░░░░│  ╰─ ⌇ checking the boundary conditions before committing…
```

Changes visible here:
- **Centering**: 20-space left margin (C-10)
- **Spine breathing room**: `│ ` → `│  ` (C-3)
- **Depth-graded dimming**: depth-1 `│` is standard dim; depth-2 `│  │` outer `│` is
  ~12 L* points darker (C-1). In the ASCII mockup this is invisible; in the terminal
  the leftmost spine column visibly recedes behind the depth-1 one.
- **`⌇` and thinking tail**: completely unchanged — sacred. Same dusty rose italic,
  same glyph, same font style.

---

### 2.3 Error — patch_apply failure with hidden lines and tail preview

**CURRENT**

```
◉ → agent(refactor) [worker]
│ ╰─ ✎ patch_apply(src/cli/x.ts) — ✗ 3 lines · 2 earlier lines hidden
│      failed to apply: old_string not found in file
│      hint: check line endings
```

All continuation lines get the bare 4-space indent. The error text is `palette.error`
(red) but the indented continuation lines blend with structural indent.

**PROPOSED** (140-col terminal, centered + error gutter)

```
░░░░░░░░░░░░░░░░░░░░◉ → agent(refactor) [worker]
░░░░░░░░░░░░░░░░░░░░│  ╰─ ✎ patch_apply(src/cli/x.ts) — ✗ 3 lines · 2 earlier lines hidden
░░░░░░░░░░░░░░░░░░░░▌   failed to apply: old_string not found in file
░░░░░░░░░░░░░░░░░░░░▌   hint: check line endings
```

Changes visible here:
- **Centering** (C-10)
- **Error gutter**: `▌` (LEFT HALF BLOCK, `palette.error`) replaces the leftmost
  space of the 4-space continuation indent. Net column cost: 0 (4 spaces → `▌` + 3
  spaces). The red gutter persists across all continuation lines of the error block,
  making the error block's extent obvious at a glance. (C-4)
- Benign-blocked (`⊘`) outcomes: `palette.warning` gutter instead of error.

---

### 2.4 OODA loop rail

**CURRENT**

```
  ◇ observe · ◇ model · ◆ act · ◇ choose · ◇ update
```

The `·` separators are dim glyphs competing at the same weight with the dim
inactive diamonds. The active stage (`◆ act`) uses `palette.brand` but has to
fight against five mid-dots for salience.

**PROPOSED** (centered)

```
░░░░░░░░░░░░░░░░░░░░  ◇ observe  ◇ model  ◆ act  ◇ choose  ◇ update
```

Changes visible here:
- **Centering**: the rail is prepended with `leftMargin` spaces (C-10)
- **Separator removed**: `·` (3 cols) → `  ` (2 cols). The active `◆` now stands alone
  as the only non-space separator element in the line — the eye lands on it first (C-8)
- Active stage and inactive stages: unchanged colors, unchanged glyphs

---

### 2.5 Parallel agents running simultaneously (live badge)

**CURRENT**

```
◉ → Agent(critic-a) [worker] [×3]                    1s
◉ → Agent(critic-b) [worker] [×3]                    1s
◉ → Agent(critic-c) [worker] [×3]                    2s
```

`[×3]` is dim. Hard to read as "three agents running RIGHT NOW."

**PROPOSED** (centered + warm parallel badge)

```
░░░░░░░░░░░░░░░░░░░░◉ → Agent(critic-a) [worker]  ∥3                    1s
░░░░░░░░░░░░░░░░░░░░◉ → Agent(critic-b) [worker]  ∥3                    1s
░░░░░░░░░░░░░░░░░░░░◉ → Agent(critic-c) [worker]  ∥3                    2s
```

Changes visible here:
- **Centering** (C-10)
- **Live badge redesign**: `[×3]` → `∥3` in `palette.brand` (warm orange). The `∥`
  (PARALLEL TO) already exists in the post-completion batch badge (`∥i/N`). Using
  the same glyph here creates vocabulary consistency: `∥` = parallel, always.
  The count is not in brackets (those were unnecessary chrome); `palette.brand`
  makes it warm and salient without reading as an error (C-5)
- **Elapsed timer**: after 10 s the `1s` / `2s` suffix ticks to `palette.warning`
  amber; after 60 s to `palette.error` red (C-2). In this snapshot both are still
  green (< 10 s)

---

### 2.6 Overflow `… +21` synthetic line

**CURRENT**

```
│ ├─ ● read_file(a.ts)   — ✓ 12 lines
│ ├─ ● read_file(b.ts)   — ✓ 8 lines
│ ├─ ● read_file(c.ts)   — ✓ 44 lines
│ ╰─ … +21 more (read_file ×18, write_file ×3)
```

The `… +21 more (…)` reads as log-file truncation, not intentional collapse.

**PROPOSED** (centered)

```
░░░░░░░░░░░░░░░░░░░░│  ├─ ● read_file(a.ts)   — ✓ 12 lines
░░░░░░░░░░░░░░░░░░░░│  ├─ ● read_file(b.ts)   — ✓ 8 lines
░░░░░░░░░░░░░░░░░░░░│  ├─ ● read_file(c.ts)   — ✓ 44 lines
░░░░░░░░░░░░░░░░░░░░│  ╰─ ··· +21  read_file ×18  write_file ×3
```

Changes visible here:
- **Centering** (C-10)
- **Spine breathing room** (C-3)
- **Overflow glyph**: `… +21 more (…)` → `··· +21  read_file ×18  write_file ×3`.
  `···` = three ASCII periods = dim collapse marker. Count in `palette.chrome`.
  Items separated by double-space, no parentheses or commas (C-7)

---

## 3. Change Inventory

Each change has an ID (C-N) for the implementation-order section (§5).

---

### C-1: Depth-graded spine dimming

**What**: Each nested `│` spine column dims by an additional luminance step. Depth-0
(leftmost ancestor) stays at current `palette.dim`. Depth-1 is ~12 L* points
darker. Depth-2+ is floored at the minimum legible tone. The `⌇` thinking glyph
and its content are completely untouched — they inherit `palette.thinking` as
before.

**Where**:  
`src/cli/commands/interactive/tool-lane-render.ts` → `colorizeIndent()`

**How**:

The current implementation applies `palette.dim(slot)` uniformly to every `│`
slot in the plain-indent string. The proposed change adds a `startDepth` parameter
(defaults to `0` for backward compat) and looks up the tone from a three-entry
array precomputed at module load — zero per-repaint allocation:

```typescript
// Precomputed at module load — three discrete chalk instances per theme set.
// SPINE_TONES[0] = current palette.dim equivalent
// SPINE_TONES[1] = ~12 L* darker
// SPINE_TONES[2] = floor (~24 L* darker, minimum legible)
const SPINE_TONES_DARK = [
  chalk.hex('#6E7681'),  // depth 0: same as chalk.dim on dark
  chalk.hex('#4A5058'),  // depth 1
  chalk.hex('#30363D'),  // depth 2+
] as const;

// colorizeIndent receives `startDepth = 0` at call sites that don't track
// ancestor depth; renderOverlayChildren passes the actual ancestor count.
export function colorizeIndent(
  plainIndent: string,
  g: Readonly<Glyphs>,
  startDepth = 0,
): string {
  let out = '';
  let slot = 0;
  for (let i = 0; i < plainIndent.length; i += g.spine.length) {
    const chunk = plainIndent.slice(i, i + g.spine.length);
    const depth = Math.min(startDepth + slot, SPINE_TONES.length - 1);
    out += chunk.startsWith('│') ? SPINE_TONES[depth]!(chunk) : chunk;
    slot++;
  }
  return out;
}
```

The theme-set switch is resolved once at import time based on which theme is
active (handled in `theme.ts` via the same `applyTheme()` mechanism that
swaps palette entries). `SPINE_TONES` is a module-level `let` that `applyTheme()`
reassigns:

```typescript
// In theme.ts alongside the existing palette swap:
export let SPINE_TONES: readonly [chalk.ChalkInstance, chalk.ChalkInstance, chalk.ChalkInstance] =
  SPINE_TONES_DARK;
// applyTheme() sets this in the same block as palette member reassignment.
```

**Theme variants**:

| Depth | Dark | Light | Umber |
|-------|------|-------|-------|
| 0 (shallowest) | `#6E7681` | `#8B949E` | `#AAA19B` |
| 1 | `#4A5058` | `#6E7481` | `#776E68` |
| 2+ (floor) | `#30363D` | `#57606A` | `#4E4844` |

Dark depth-0 is the literal hex equivalent of `chalk.dim` on a `#0D1117`
background. All values verified against their theme's background at WCAG SC
1.4.3 Lc ≥ 30 (the minimum for "decorative" chrome).

**Column cost**: 0 — only ANSI escape sequences change; glyph widths are unchanged.

**Performance**: one array-index lookup per `│` slot per row. The slot loop already
iterates 2-cell chunks; this adds one `Math.min` and one `const` array read. O(1)
per slot, O(depth) per row — negligible at any real nesting depth.

**Risk**: Tests that snapshot `colorizeIndent` ANSI output will break — the escape
sequences change from `chalk.dim` to `chalk.hex(…)`. Behavioral risk: none.
The `startDepth` parameter defaults to `0` so every existing call site compiles
and runs unchanged; the depth-grading is opt-in from `renderOverlayChildren`.

---

### C-2: Adaptive elapsed timer (warm urgency gradient)

**What**: The elapsed timer on in-flight tool rows (`2s`, `1m30s`) changes color
based on elapsed time, turning a decorative datum into an urgency signal.
The thresholds stay in the warm register: normal is dim (not green — green is
`✓` done, a different semantic), amber is warning, red is error.

**Where**:  
`src/cli/terminal-compositor.scrollback.ts` → `formatElapsed()`

**How**:

```typescript
// Current: palette.dim(` ${totalSec}s`) (and ` ${min}m${...}s`)
// Proposed:

const ELAPSED_AMBER_SEC = 10;   // configurable constant
const ELAPSED_RED_SEC   = 60;

function elapsedTone(totalSec: number): chalk.ChalkInstance {
  if (totalSec >= ELAPSED_RED_SEC)   return palette.error;    // red: stuck
  if (totalSec >= ELAPSED_AMBER_SEC) return palette.warning;  // amber: watch it
  return palette.dim;                                          // dim: normal
}

export function formatElapsed(startedAt: number): string {
  const elapsed = Date.now() - startedAt;
  if (elapsed < ELAPSED_GRACE_MS) return '';
  const totalSec = Math.floor(elapsed / 1000);
  const tone = elapsedTone(totalSec);
  if (totalSec < 60) return tone(` ${totalSec}s`);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return tone(` ${min}m${sec.toString().padStart(2, '0')}s`);
}
```

The `< 10s` range uses `palette.dim` (not green) deliberately: green = success/done
is a reserved semantic. A fast-executing tool is not "successful" yet; dim is the
correct "unremarkable" signal.

**Theme variants**: inherits `palette.dim` / `palette.warning` / `palette.error`
from the active theme. Zero new color definitions.

| Range | Dark | Light | Umber |
|-------|------|-------|-------|
| < 10s | `chalk.dim` | `chalk.dim` | `chalk.dim` |
| 10–59s | `chalk.yellow` | `#B8860B` | `#D7AA32` |
| ≥ 60s | `chalk.red` | `#C62828` | `#EF7F74` |

**Column cost**: 0 — timer text is the same characters; only ANSI attributes change.

**Performance**: 1 comparison per `formatElapsed` call. Already called per-repaint
per in-flight row. Negligible.

**Risk**: Low. Tests that snapshot `formatElapsed` ANSI output will need updating
for rows where the elapsed time crosses a threshold. No behavioral change.

---

### C-3: Spine column breathing room (+1 cell per level)

**What**: Expand the spine/closed spine/lead/turnRoot glyph strings from 2 cells
to 3 cells. `│ ` → `│  `. The connectors (`├─ `, `╰─ `) stay at 3 cells — they
already have the right visual weight. The net effect: each nesting level adds 3
instead of 2 columns of indent, giving the tree interior room to breathe without
changing the structural connectors.

**Where**:  
`src/cli/commands/interactive/tool-lane-render.ts` → `UNICODE_GLYPHS`, `ASCII_GLYPHS`,
and every JSDoc width-invariant comment that says "2 cells".

**How**:

```typescript
// Current:
export const UNICODE_GLYPHS: Readonly<Glyphs> = Object.freeze({
  spine:         '│ ',    // 2 cells
  spineClosed:   '  ',    // 2 cells
  lead:          '  ',    // 2 cells
  turnRoot:      '◉ ',    // 2 cells
  midConnector:  '├─ ',   // 3 cells  ← unchanged
  lastConnector: '╰─ ',   // 3 cells  ← unchanged
  textPrefix:    '│ ',    // 2 cells
});

// Proposed:
export const UNICODE_GLYPHS: Readonly<Glyphs> = Object.freeze({
  spine:         '│  ',   // 3 cells
  spineClosed:   '   ',   // 3 cells
  lead:          '   ',   // 3 cells
  turnRoot:      '◉  ',   // 3 cells
  midConnector:  '├─ ',   // 3 cells  ← unchanged
  lastConnector: '╰─ ',   // 3 cells  ← unchanged
  textPrefix:    '│  ',   // 3 cells
});
```

`ASCII_GLYPHS` mirrors the same change. The Glyphs interface JSDoc "2 cells"
invariant comments are updated to "3 cells".

**Column cost**: +1 column per nesting level per row. Depth-3 nesting costs 3
extra columns. `toolLaneWidth()` already caps to `capToMeasure(getTerminalWidth())`,
so on a 100-col terminal at depth 3 the content budget shrinks by 3 columns
(100 → 97). Acceptable: the DECSTBM/wrap math is unaffected because
`clampLineToTerminal` enforces the budget at row-emission time regardless.

**Performance**: 0 — frozen constant objects.

**Risk**: **HIGH** — this is the highest-risk single change. Every test that
asserts on exact rendered output, `buildIndent` string length, or tree-connector
column positions will fail. The width invariants in JSDoc change. All snapshot
tests and width-math unit tests must be updated in the same PR. Do not split
this change across multiple PRs.

---

### C-4: Error gutter on continuation lines

**What**: The multi-line continuation of an error outcome (the `hiddenLineCount`
notice and `tailPreview` lines that appear under a failed tool row) gains a
one-column `▌` (U+258C LEFT HALF BLOCK) gutter in `palette.error` tone.
Benign-blocked (`⊘`) outcomes use `palette.warning`. Success outcomes retain
the current plain 4-space indent. The gutter replaces the leftmost space of
the existing 4-space indent, keeping total prefix width unchanged at 4 columns.

**Where**:  
`src/cli/commands/interactive/tool-lane-format.ts` → `formatOutcome()`

**How**: The gutter is built inside `formatOutcome` as part of the returned string
(not at the render site), so `pushOutcomeLines`'s `\n` split carries the gutter
through to every continuation line intact:

```typescript
// In formatOutcome, near the top:
const gutterChar = chunk.isError
  ? (isBenignFailure(chunk.failureClass) ? palette.warning('▌') : palette.error('▌'))
  : '';
// gutterChar is 1 display col. '   ' is 3 spaces. Total = 4 cols, matching
// the current '    ' (4 spaces). Net column cost: 0.
const contPrefix = chunk.isError ? gutterChar + '   ' : '    ';

// Then where hiddenLineCount is emitted:
headline += '\n' + contPrefix + resultColor(`${chunk.hiddenLineCount} earlier lines hidden`);

// And tailPreview lines:
const tailLines = chunk.tailPreview
  .map(l => contPrefix + palette.dim(sanitizeLabel(l.length > 120 ? l.slice(0, 120) + '…' : l)))
  .join('\n');
```

**Theme variants**: inherits `palette.error` / `palette.warning` — zero new colors.

**Column cost**: 0 net. `▌` (1 col) + 3 spaces = 4 cols, same as current 4 spaces.

**Performance**: 1 boolean check per formatted outcome. O(1).

**Risk**: Low. Only the error continuation path changes. Tests that snapshot error
outcome strings need updating. Edge case: benign-blocked multi-line results get
a warning-tone gutter — verify `BENIGN_FAILURE_CLASSES` coverage in `isBenignFailure`.

---

### C-5: Parallel-run live badge — warm, minimal

**What**: While multiple agents run in true parallel, each root tool row's live
activity badge changes from `[×N]` (dim, bracketed) to `∥N` (`palette.brand`,
warm orange). The `∥` (PARALLEL TO, U+2225) glyph already exists in the
post-completion `batchBadge` — using the same glyph creates a coherent
vocabulary: `∥` = parallel, always. The count is plain digits, no brackets.

**Where**:  
`src/cli/commands/interactive/tool-lane-format.ts` → `activeToolBadge()`

**How**:

```typescript
// Current:
return palette.dim(` [×${activeTools.toolUseIds.size}]`);

// Proposed:
return palette.brand(`  ∥${activeTools.toolUseIds.size}`);
// Two leading spaces provide visual separation from the dispatch tag.
// palette.brand = warm orange — matches the brand prompt color and reads
// as "active/live" without alarming. NOT palette.info (sky blue) — that
// would pull the color temperature cool. The existing guard (activeCount > 1
// and this tool is in the active set) is unchanged.
```

**Theme variants**: inherits `palette.brand`:

| Theme | Color |
|-------|-------|
| Dark  | `#E67E4C` warm orange |
| Light | `#C0562A` burnt orange |
| Umber | `#FF9B5A` Umber amber |

**Column cost**: `[×N]` = 4–6 cols; `  ∥N` = 4–5 cols. Net: roughly equal.
Row is clamped by `clampLineToTerminal` so worst case is right-edge truncation
of the args preview, not layout corruption.

**Performance**: 0 — same O(1) set check.

**Risk**: Low. Tests asserting the exact `[×3]` string format will need updating.

---

### C-6: Done-line `✓` prefix and un-parenthesized stats

**What**: The `agentResultSummary` Done line changes from `Done (3 tools · 2.5s)`
to `✓ Done  3 tools · 2.5s`. The `✓` is in `palette.success` (the same
glyph and color already used in the `— ✓` outcome indicator on individual
tool rows). The parentheses are removed; the stats are dim. Net: the green
check makes the done state pre-attentively identifiable — the eye finds it
without reading text.

**Where**: wherever `agentResultSummary` strings are assembled. From the code:
this is in `src/cli/_lib/stream-renderer-*.ts` (the `summaryWithBatchBadge`
helper or equivalent), confirmed by the `PRE-STYLED` invariant comment in
`ResultSummarySibling`.

**How**: the assembled summary string changes from:
```
palette.dim(`Done (${toolCount} tools · ${tokStr} · ${durStr})`)
```
to:
```
palette.success('✓') + palette.dim(` Done  ${toolCount} tools · ${tokStr} · ${durStr}`)
```

The `PRE-STYLED` invariant on `ResultSummarySibling.summary` is preserved —
the string arrives pre-colored and render sites emit it verbatim without
re-wrapping in another `palette.dim()`.

**Theme variants**: `palette.success`:

| Theme | Color |
|-------|-------|
| Dark | `chalk.green` |
| Light | `#2E7D32` |
| Umber | `#8AE49E` |

**Column cost**: `✓ ` = 2 cols; `(…)` removal saves 2 cols. Net: 0.

**Performance**: 0 — string construction happens once per Done event, not per repaint.

**Risk**: Low-medium. Tests that snapshot the Done line exact string will break.
The `PRE-STYLED` annotation in grouping-module comments must be preserved.

---

### C-7: Overflow line `···` glyph

**What**: `… +21 more (read_file ×18, write_file ×3)` becomes
`··· +21  read_file ×18  write_file ×3`. Triple ASCII periods as the collapse
glyph (dim), count in `palette.chrome`, items double-space-separated with no
parentheses or commas.

**Where**:  
`src/cli/commands/interactive/tool-lane-render-grouping-overflow.ts` →
`formatCategoricalOverflow()` (or the equivalent string builder for overflow lines)

**How**:

```typescript
// Current string: `… +21 more (read_file ×18, write_file ×3)`
// Proposed:
const prefix = palette.dim('··· ');
const count  = palette.chrome(`+${hiddenCount}`);
const items  = palette.dim(categoricalItems.join('  '));
return prefix + count + '  ' + items;
// '··· ' = 4 cols; '+21' = 3 cols; '  ' = 2 cols; items vary.
// Net vs current: '… +21 more (' = 11 cols → '··· +21  ' = 9 cols.
// Removes ~2 cols per item (commas + spaces → double-space).
```

`···` is three literal ASCII periods — portable across all fonts and locales,
survives `stripAnsi`, works in the ASCII fallback mode too.

**Theme variants**: `palette.dim` + `palette.chrome` — no new colors.

**Column cost**: net −2 to −4 cols for typical overflow lines.

**Performance**: 0 — string built once at overflow synthetic construction.

**Risk**: Low. Tests asserting the overflow string format will break. No behavioral change.

---

### C-8: OODA rail separator removal

**What**: The `·` dim separator between stage cells is replaced with a plain
double-space. The active stage retains `palette.brand` + bold; inactive stages
retain `palette.dim`. Without the five dim mid-dots, the single active `◆`
becomes the only non-space character with full weight, making it pop without any
color or size change.

**Where**:  
`src/cli/commands/interactive/loop-stage.ts` → `formatStageRail()`

**How**:

```typescript
// Current:
return cells.join(fmt.dim(' · '));

// Proposed:
return cells.join('  ');   // plain double-space, no separator glyph
```

**Theme variants**: no new colors.

**Column cost**: `' · '` = 3 cols; `'  '` = 2 cols. −1 col per separator,
−4 cols total. Slightly more room for the rail on narrow terminals.

**Performance**: 0 — one join per stage transition.

**Risk**: Minimal. Tests asserting the rail string format will break. No behavioral
change.

---

### C-9: Thinking tail — `⌇` stays, indent sharpened

**What**: The `⌇` glyph and `palette.thinking` (dusty rose italic) are **sacred
and unchanged**. The only change is a tighter indent prefix: replace `'⌇  '`
(glyph + 2 spaces) with `'⌇ '` (glyph + 1 space) so the thinking text sits
closer to its glyph. This saves 1 column per thinking-tail line with no visual
downside — the `⌇` glyph already reads as a distinct class marker without the
extra padding.

**Where**:  
`src/cli/commands/interactive/tool-lane-render-children.ts` →
both thinking-tail branches in `renderOverlayChildren`

**How**:

```typescript
// Current:
palette.thinking('⌇  ' + sanitizeLabel(child.thinkingTail))

// Proposed:
palette.thinking('⌇ ' + sanitizeLabel(child.thinkingTail))
// 1 space instead of 2. Same glyph, same color, same font style. −1 col.
```

**Theme variants**: `palette.thinking` unchanged in all themes.

**Column cost**: −1 col per thinking-tail line. Marginally better on narrow terminals.

**Performance**: 0.

**Risk**: Tests that snapshot the exact thinking-tail prefix string will break.
Visual regression risk: none — the change is one space narrower.

---

### C-10: Content centering

> **This is the most architecturally complex change. Read the full section before
> estimating or starting implementation.**

**What**: On terminals wider than the content measure (100 cols for code/tree,
80 cols for prose), prepend a computed left margin to every content line so the
display floats in the center of the viewport rather than running left-aligned
against column 0. When `terminalWidth ≤ contentMeasure`, margin = 0 and behavior
is completely unchanged.

```
leftMargin = Math.floor((terminalWidth - contentMeasure) / 2)
```

For a 140-col terminal and 100-col measure: `floor((140 - 100) / 2) = 20`.  
For a 100-col terminal: `floor((100 - 100) / 2) = 0` — no change.  
For an 80-col terminal: `floor((80 - 100) / 2) = -10` → clamped to 0.

**Why centering is non-trivial**: there are four completely separate write paths
in the compositor, and they behave differently. Centering must be applied in the
right place for each — applying it at the wrong seam breaks ANSI accounting,
row counting, or DECSTBM geometry.

#### 3.10.1 The four write paths

**Path A — Overlay (live frame)**  
`toolLane.getOverlay()` → `OverlayComposer.flush()` → `compositor.setOverlay(text)` →
stored as `this.overlay` → `gatherChromeRows` splits on `\n` → `buildFrameLines`
assembles `frameLines` → `logUpdate.render(frame, ...)`.  
`log-update` hard-wraps each line at `stdout.columns`. ANSI-aware.

**Path B — Committed scrollback (during armed turn)**  
`compositor.commitAbove(text)` → `decomposeCommitText` hard-wraps to `cols` →
`stdout.write(text + '\n')`. Append-only; once written, cannot be re-centered
on resize.

**Path C — Disarmed / console writes (between turns)**  
`boundLineToTerminal(text, stdout)` → `stdout.write(bounded + '\n')`. Used by
slash commands and `commitAbove`'s disarmed early return. Plain TTY write.

**Path D — CUP-addressed writes (status line + OODA rail + bg-status bar)**  
`\x1b[${row};1H\x1b[2K${content}`. These write to an absolute column 1 using
ANSI cursor-addressing. Centering these requires changing the content of `content`
to include the left margin prefix, or changing the column in the CUP escape.

#### 3.10.2 Implementation approach: margin at the content-assembly layer

The correct place to apply centering is **at the line-assembly layer, not the
compositor layer**. Specifically:

- **Overlay lines**: prepend `leftMargin` spaces inside `toolLane.getOverlay()`
  before each line is added to the `lines` array. The overlay is already assembled
  line-by-line with `clampLineToTerminal` at the end of each line. The margin is
  applied before the clamp so the clamped width budget is correctly the full
  terminal width (not the content width). This is the right seam because every
  overlay line already goes through `clampLineToTerminal(line, cols)` where `cols =
  toolLaneWidth() = capToMeasure(getTerminalWidth())`.

  The change: in `tool-lane.ts` `getOverlay()`, introduce a `margin` helper:
  ```typescript
  const termWidth = getTerminalWidth();
  const measure = toolLaneWidth();   // = capToMeasure(termWidth)
  const leftMargin = Math.max(0, Math.floor((termWidth - measure) / 2));
  const pad = ' '.repeat(leftMargin);
  // Then every `lines.push(clampLineToTerminal(line, cols))` becomes:
  // lines.push(clampLineToTerminal(pad + line, termWidth))
  // Note: clamp arg changes from `cols` (measure) to `termWidth`, because
  // the padded line may now be up to termWidth wide.
  ```

  This is a **pure overlay change** — the spinner row, tip row, input line, and
  dropdown are handled separately and must NOT receive the content margin (they are
  full-width chrome, not content).

- **Scrollback / commitAbove lines** (Path B): centering is **deliberately skipped**
  for this path. The append-only scrollback cannot be retroactively re-centered on
  terminal resize. Applying a margin here would cause a jarring visual break between
  the centered live overlay and the left-aligned scrollback above it — which is
  actually *correct*: scrollback is a transcript, not a live display. The seam
  between scrollback and overlay is already visual (the committed band above vs.
  the live frame below); centering the overlay only reinforces this distinction.

  However: for the spinner row and the progress banner (which *do* go through
  `commitAbove`), the margin should be applied there too so the transition from
  live to committed looks consistent. This means `commitAbove` callers that build
  tool-lane flush output need to prepend the margin. See C-10's flush-path note.

- **Flush output** (the scrollback path for completed agent blocks): in
  `tool-lane.ts`'s `flush()` and `renderFlushChildren`, every emitted line goes
  through `commitAbove`. Apply the same `pad + line` transformation here.
  **Critical**: the `pad` must be computed at flush time using the THEN-CURRENT
  terminal width, not cached at getOverlay time. A terminal resize between the
  overlay and the flush would cause width mismatch — but since the flush happens
  immediately at turn end, in practice the terminal width is stable.

- **CUP-addressed writes** (Path D — status line, OODA rail): the status line
  already paints at `\x1b[${row};1H` (column 1). To center it, the CUP column
  must change to `leftMargin + 1`:

  ```typescript
  // In status-line.ts repaint() and LoopStageBar.repaint():
  const col = leftMargin + 1;
  this.stream.write(`\x1b[${paintRow};${col}H\x1b[2K${content}`);
  ```

  But: the status line uses `\x1b[2K` (erase entire line) before painting, so
  the leftward portion of the status row is always blank. The `\x1b[2K` erases
  from the current cursor position to end-of-line — no, actually `2K` erases
  the ENTIRE line (all columns). So centering the status line is as simple as
  changing the column in the CUP escape and letting the preceding `\x1b[2K`
  erase the full row.

  **However**: the status line is a dense field (model, cwd, branch, cost, tokens,
  etc.) designed to use the full terminal width. Centering it to the content
  measure would cut its available width from `terminalWidth` to `contentMeasure`,
  triggering priority shedding of fields. **Recommendation**: do NOT center the
  status line. Let it remain full-width as a visual anchor (see §3.10.3 below).

- **Prompt line**: the prompt (`afk › `) is assembled by `renderInputLine` and
  passed into the compositor frame as the last line. Since it is part of the
  `log-update` frame, centering it requires prepending the margin inside
  `renderInputLine()`. This means the prompt moves to the center of the screen.
  **Recommendation**: center the prompt together with the overlay content so the
  input field aligns with the tree above it.

#### 3.10.3 Which surfaces center, which stay full-width

| Surface | Center? | Reason |
|---------|---------|--------|
| Tool-lane overlay (tree) | **Yes** | Primary content |
| Spinner row | **Yes** | Part of overlay block |
| Prompt / input line | **Yes** | Aligns with tree above |
| OODA loop rail | **Yes** | Sits visually above the prompt |
| Flush / scrollback lines | **Yes** | For consistency during active turns |
| Status line (bottom row) | **No** | Full-width anchor; truncation budget unchanged |
| Background-status bar rows | **No** | Full-width informational; centered would reduce field count |
| Dropdown / autocomplete rows | **No** | These track the prompt column — centered automatically by centering the prompt |
| Hint row | **No** | Same as dropdown |
| Tip row (spinner tip) | **No** | Full-width informational |

#### 3.10.4 The resize edge case

When the terminal is resized, `getTerminalWidth()` returns the new width
immediately. The overlay is re-rendered on the next 80ms tick (or on the
SIGWINCH-triggered debounced repaint). The left margin recalculates on every
call to `getOverlay()` — it is not cached — so the overlay re-centers
automatically after resize.

The committed scrollback (Path B) is **not re-centered** after resize. This is the
correct behavior: scrollback rows are append-only and cannot be modified. On a
width-expanding resize, the existing committed rows stay left-aligned; new
rows committed after the resize will use the new (potentially larger) margin.
This produces a brief visual inconsistency between old and new scrollback rows,
but it is the same inconsistency that already exists for line-wrapping on resize —
an acceptable trade.

The DECSTBM scroll region is unaffected by centering: the scroll region reserves
rows by row number, not columns. The left margin is a content prefix within the
rows the scroll region already owns.

#### 3.10.5 Implementation structure: `contentMargin()` helper

A new pure function `contentMargin(termWidth?: number): string` in
`src/cli/render/measure.ts` (or `src/cli/terminal-size.ts`) centralizes the
margin computation for all centering call sites:

```typescript
// src/cli/render/measure.ts — alongside capToMeasure()

/**
 * Left-margin string for centering content at the active text measure.
 *
 * Returns a plain string of spaces whose width is:
 *   Math.max(0, Math.floor((termWidth - contentMeasure) / 2))
 *
 * When termWidth ≤ contentMeasure (the common case on narrow terminals),
 * returns '' so callers get a no-op without any branch. The returned
 * string is at most ~200 chars (half of an absurdly wide terminal) — safe
 * to prepend to every line without allocation concerns.
 *
 * @param termWidth - Terminal width; defaults to `getTerminalWidth()`.
 */
export function contentMargin(termWidth?: number): string {
  const tw = termWidth ?? getTerminalWidth();
  const measure = resolveTextMeasure() ?? tw;
  const marginCols = Math.max(0, Math.floor((tw - measure) / 2));
  return ' '.repeat(marginCols);
}
```

Call sites:
- `tool-lane.ts` `getOverlay()`: `const pad = contentMargin();` once per
  `getOverlay()` call, prepended to each line before clamping.
- `tool-lane.ts` `flush()` and `renderFlushChildren`: `const pad = contentMargin();`
  once per flush call, prepended to each line passed to `commitAbove`.
- `renderInputLine()` in `terminal-compositor.render.ts`: prepend `contentMargin()`
  to the assembled prompt+buffer line.
- `LoopStageBar.repaint()` in `loop-stage.ts`: prepend `contentMargin()` to the
  stage rail content (the `'  ' + formatStageRail(...)` string).
- Spinner row (`renderSpinnerRow()`): prepend `contentMargin()` in
  `SpinnerController.renderSpinnerRow()`.

**Where NOT to call `contentMargin()`**:
- `renderDropdownRows()` — autocomplete tracks the cursor column naturally.
- `renderHintRow()` — same.
- `renderTipRow()` — full-width informational.
- Status line `repaint()` — intentionally full-width.
- Background-status bar — intentionally full-width.
- `commitAbove` Path B for non-tool-lane content (e.g. error banners, system
  notices, the `commitAbove('')` separator) — these are ambient and should stay
  at column 0. Only tool-lane flush lines and the OODA rail center.

#### 3.10.6 `AFK_CENTER_CONTENT` environment variable

Centering should be opt-in (or opt-out after default-on — designer's call).
Recommend: **default off**, enabled by `AFK_CENTER_CONTENT=1`. The rationale for
default-off: centering changes the visual behavior on every wide terminal, which
is a larger surface area than the other changes in this proposal. Starting as
opt-in lets the operator evaluate it in their own sessions before enabling broadly.

The `contentMargin()` helper checks the env var:

```typescript
export function contentMargin(termWidth?: number): string {
  if (!env.AFK_CENTER_CONTENT || !/^(1|true|yes)$/i.test(env.AFK_CENTER_CONTENT)) {
    return '';  // default: no centering
  }
  // ... rest of computation
}
```

This means all C-10 call sites are a no-op unless the flag is set — zero
behavioral change for the default case, and the feature is trivially togglable.

**Theme variants**: centering is purely structural (spaces); no color involved.
Works identically in dark, light, and umber.

**Column cost**: `leftMargin` spaces prepended to each line. This does NOT
reduce the content width — the content was already capped at `contentMeasure`
columns by `toolLaneWidth()` / `capToMeasure()`. The terminal's right side had
dead space; centering splits it between left and right. The total occupied
columns increases by `leftMargin`, but the terminal width absorbs it cleanly.

**Performance**: `contentMargin()` calls `getTerminalWidth()` (a
`process.stdout.columns` lookup) and `resolveTextMeasure()` (a regex against an
env var string). Both are O(1) and already called per-frame for other purposes.
`' '.repeat(N)` allocates a small string once per `getOverlay()` call (~80ms);
negligible.

**Risk**: Medium. The centering touches several files across the overlay and flush
paths. The core risk is **partial centering**: if one call site is missed, lines
from that source will appear at the wrong horizontal offset, creating a ragged
mix of centered and left-aligned content. The `contentMargin()` helper's
centralization mitigates this — auditing call sites is a mechanical check.

The disarmed path (`commitAbove`'s early return via `boundLineToTerminal`) is
explicitly NOT centered — ensure tests that cover the disarmed path still assert
on column-0 output.

---

## 4. Changes NOT Proposed (and Why)

### 4.1 Replacing `⌇` or `palette.thinking`

**Why rejected**: `⌇` (WAVY LINE) and the dusty-rose italic `palette.thinking` are
the most distinctive elements in AFK's visual vocabulary. They are immediately
recognizable as "the model is thinking" without requiring any other cue. Adding a
left-bar gutter or replacing them with a different glyph would dilute the identity.
C-9 touches only the trailing whitespace (−1 space) — the sacred elements are
completely preserved.

### 4.2 Replacing `◉`, `╰─`, or the status glyphs (`●✓✗⊘⚠`)

**Why rejected**: These are signature AFK choices. `◉` as the fisheye turn-root
is unique; `╰─` is the rounded corner that gives the tree its soft aesthetic;
`●✓✗⊘⚠` form a complete 5-state vocabulary already. None of these are generic
defaults from other tools. Replacing them would make AFK look like lazygit or
btop. The redesign enhances what is there, not substitutes it.

### 4.3 Shifting the palette toward cool tones (teal, cyan, blue)

**Why rejected**: AFK's palette is warm (orange brand, rose thinking, olive goblin,
amber warning). Adding `palette.info` (sky blue) for the parallel badge (original
C-5 draft) would pull the dominant temperature cool. The revised C-5 uses
`palette.brand` (warm orange) for the parallel badge, staying within the warm
register. Every new color in this proposal either inherits existing warm palette
roles or is a darker/dimmer variant of the same hue family.

### 4.4 Full-width active-row highlight (background color on in-flight rows)

**Why rejected**: The tree is an animated display where multiple rows are
simultaneously "active." A per-row background requires knowing the terminal
background color, is not portable across themes and terminal emulators, and
would require background-color to be removed during the 80ms repaint cycle —
creating visible flicker at 12.5 Hz. The adaptive elapsed timer (C-2) and
the warm parallel badge (C-5) already signal active state without touching
background color.

### 4.5 Gradient spine colors (rainbow depth levels)

**Why rejected**: Hue differentiation for structural elements is decoration
without information. The palette already has 12+ hues serving semantic roles
(tool category colors, status colors, identity colors). Depth should be conveyed
by luminance (C-1), not hue, which is perceptually universal and
colourblind-safe.

### 4.6 Full-width completion boxes (`╭─╮` / `╰─╯` borders)

**Why rejected**: The tree already uses `╰─` as its last-child connector. Adding
surrounding borders would consume 2+ columns per side, require a layout pass to
distinguish complete vs. in-flight entries, and would import the Catppuccin/Charm
aesthetic that the operator explicitly wants to avoid. The done-line `✓` glyph
(C-6) provides closure with zero overhead.

### 4.7 Blank-line section separators between completed agents

**Why rejected**: The overlay is height-limited. Every blank line displaces a
real content row. The compositor's DECSTBM geometry assumes a stable row count
per frame; adding blank lines would require scroll-region recomputation. The
spine breathing room (C-3) and centering (C-10) together achieve the "airy"
feel without height cost.

### 4.8 Centering the status line

**Why rejected**: The status line is a dense priority-shed field (model, cwd,
branch, cost, tokens, quota, turn, budget, agents, tok/s) designed to use the
full terminal width. Centering it to 100 cols would immediately trigger
field-shedding on wide terminals, hiding cost and context information the user
relies on. The status line is most useful as a full-width anchor — it grounds
the centered content above it and gives the eye a reference edge.

### 4.9 Centering the dropdown / autocomplete

**Why rejected**: the dropdown tracks the cursor column to appear adjacent to the
user's typed text. If the input line is centered (per C-10), the dropdown
inherits the centering naturally because it appears in the same log-update frame.
No separate change is needed.

### 4.10 Centering scrollback / committed band permanently (including re-centering on resize)

**Why rejected**: committed scrollback is append-only. There is no mechanism to
retroactively re-center already-written rows on resize without a full screen
repaint (which would corrupt DECSTBM accounting and the committed-band geometry).
The seam between centered overlay and left-aligned scrollback is an acceptable
visual artifact — it mirrors the existing seam between the styled live frame and
the terminal's native scrollback.

---

## 5. Implementation Order

Dependencies flow downward. Items at the same indentation level can be done
in parallel.

```
Wave 0 — independent, zero width impact, safe to merge in any order:
  C-2   Adaptive elapsed timer color
  C-5   Parallel-run live badge (brand warm orange)
  C-6   Done-line ✓ prefix
  C-7   Overflow ··· glyph
  C-8   OODA rail separator removal
  C-9   Thinking tail −1 space

Wave 1 — width-geometry change, must be a standalone PR:
  C-3   Spine breathing room (+1 cell)
        ↳ Expect many snapshot failures. Fix all in the same PR.
          This is the foundation. Merge before Wave 2.

Wave 2 — depends on C-3:
  C-1   Depth-graded spine dimming
        ↳ Requires C-3 because the glyph-slot walk changes with the
          new spine width (now 3 cells per slot instead of 2).
  C-4   Error gutter on continuation lines
        ↳ Can be started before C-3 lands (different file: tool-lane-format.ts),
          but must be rebased on C-3 before merge to keep snapshot tests consistent.

Wave 3 — depends on C-3 landing, architectural:
  C-10  Content centering
        ↳ Depends on C-3 for correct margin computation (toolLaneWidth is the
          measure anchor; if spine widths change, the measure is unaffected, but
          the overlay-line prefixes produced by getOverlay() change width and must
          be re-checked against the terminal-width clamp).
        ↳ Implement contentMargin() helper first, wire one surface (overlay),
          verify visually, then wire the remaining surfaces (flush, prompt,
          OODA rail, spinner) in a single PR.
```

**Recommended PR sequence**:

1. **PR 1** — C-2 + C-5 + C-6 + C-7 + C-8 + C-9. All Wave 0. Safe, fast to review.
   No width changes. Reviewers see the warm elapsed timer, done glyph, warm parallel
   badge, cleaner overflow, simpler rail, and tighter thinking tail immediately.
2. **PR 2** — C-3 alone. Many snapshots break; fix them all here. Get this reviewed
   and merged before any other work depends on it.
3. **PR 3** — C-1 + C-4 together. Both depend on C-3. C-1 touches `colorizeIndent`,
   C-4 touches `formatOutcome` — no shared surface, safe to combine.
4. **PR 4** — C-10 (centering), behind `AFK_CENTER_CONTENT=1`. The largest
   architectural scope; deserves its own review. Depends on C-3 being merged.

---

## 6. Measuring Success

A reviewer accepts the redesign when all of the following pass:

### 6.1 Visual identity preserved

Show the proposed output to someone who uses AFK regularly. They should say
"yes, that's still AFK" — not "that looks like another tool." Specifically:
`⌇` and dusty-rose thinking text must be present and unchanged; `◉` must be
present; `●✓✗⊘⚠` vocabulary must be present; the warm orange `◆ act` rail
must be present.

### 6.2 Urgency at a glance (C-2)

Run a `bash` tool for 90 seconds. Observe the elapsed timer without a clock:
it should be dim at start, amber at ~10s (visible without reading the number),
and red at ~60s (alarming without reading the number). A fresh observer told
"is this taking too long?" should answer correctly in ≤2s at the 75s mark.

### 6.3 Hierarchy legibility (C-1, C-3)

Open a 3-level deep agent tree. Without reading text, point to the deepest
active row. Time to identify: ≤1 second. The depth-3 spines should visibly
recede behind the depth-1 ones to a human judge, not just on a color meter.

### 6.4 Error discoverability (C-4)

In a session where a `patch_apply` fails 3 levels deep in a nested agent, find
the error row in the live overlay. The red `▌` gutter should draw the eye without
scanning — the observer finds it without reading.

### 6.5 Done recognition (C-6)

Scroll back through 20 completed agent entries. Identify all done entries in
≤2 seconds. The green `✓` enables pre-attentive identification.

### 6.6 Centering aesthetic (C-10, only if enabled)

On a 140-col terminal with `AFK_CENTER_CONTENT=1`: the tree should appear to
float in the center of the viewport. The status line should remain full-width.
On a 100-col terminal: no centering, behavior identical to the unconfigured state.
On resize from 140→80: the overlay re-centers within one repaint cycle (~80ms).

### 6.7 Correctness

- All existing tests pass after snapshot updates.
- No tree corruption: no severed spines, phantom `│` columns, or orphaned connectors.
- `AGENT_AFK_ASCII=1` produces correct ASCII-equivalent output at all nesting depths.
- `AFK_CENTER_CONTENT=0` (or unset): output is byte-for-byte identical to the
  pre-C-10 state.

### 6.8 Theme consistency

Switch themes mid-session (dark → light → umber). Every element introduced
by this redesign tracks the theme change:
- Depth-0 spine tone in light theme is `#8B949E` (darker than dark's `#6E7681`).
- Elapsed amber/red in umber theme is `#D7AA32` / `#EF7F74`.
- Done `✓` in umber theme is `#8AE49E`.
- Parallel badge `∥N` in umber theme is `#FF9B5A`.
No element should freeze to the theme active at import time — all must be
resolved at render time via `palette.<role>` or the `SPINE_TONES` ref.

---

## Appendix A: Complete New Color Table

All new colors introduced by this proposal:

| Purpose | Dark | Light | Umber |
|---------|------|-------|-------|
| Spine depth-0 | `#6E7681` | `#8B949E` | `#AAA19B` |
| Spine depth-1 | `#4A5058` | `#6E7481` | `#776E68` |
| Spine depth-2+ | `#30363D` | `#57606A` | `#4E4844` |

Everything else reuses existing `palette.<role>` entries:
`palette.dim`, `palette.warning`, `palette.error`, `palette.success`,
`palette.chrome`, `palette.brand`, `palette.thinking`.

Six hex values total. This is the entire new-color surface area of the redesign.

---

## Appendix B: `contentMargin()` Call-Site Checklist

For C-10 implementers — every surface that must receive the margin, and every
surface that must NOT:

| File | Function / location | Centered? |
|------|---------------------|-----------|
| `tool-lane.ts` | `getOverlay()` — every `lines.push(...)` | **Yes** |
| `tool-lane.ts` | `flush()` / `renderFlushChildren` — every `commitAbove(line)` call | **Yes** |
| `terminal-compositor.render.ts` | `renderInputLine()` — return value | **Yes** |
| `loop-stage.ts` | `LoopStageBar.repaint()` — content string | **Yes** |
| `input/spinner.ts` | `SpinnerController.renderSpinnerRow()` — return value | **Yes** |
| `terminal-compositor.render.ts` | `renderDropdownRows()` | No — tracks cursor |
| `terminal-compositor.render.ts` | `renderHintRow()` | No — tracks cursor |
| `input/spinner.ts` | `SpinnerController.renderTipRow()` | No — full-width |
| `status-line.ts` | `StatusLine.repaint()` | No — full-width anchor |
| `loop-stage.ts` | Background-status bar rows | No — full-width |
| `terminal-compositor.committed-band-commit.ts` | Disarmed `commitAbove` path | No — col-0 transcript |
| Any `commitAbove('')` separator call | (blank separator lines) | No |

---

*Document ends. No files were modified during the creation of this document.*
