# Shift+Tab → cycle permission modes (3-mode ring)

## Goal
Make the REPL's **Shift+Tab** key cycle through permission modes instead of only
toggling `plan ↔ default`.

## Decision (chosen: option **a**, the safe 3-mode ring)
Shift+Tab cycles a fixed ring **`default → plan → bypassPermissions → default`**.
**AFK (`autonomous`) is deliberately excluded** from the keypress ring and stays
on the `/afk` command. The one concession: if the session is *already* in
`autonomous` (operator ran `/afk on`), Shift+Tab exits AFK cleanly (full
teardown) and lands on `default` — so the key still does something sensible from
AFK without ever *entering* it on a transient press.

Built the **cheap way** (devils-advocate pragmatist): no extraction refactor of
`afk-mode-toggle.ts`. `plan`/`bypass`/`default` are pure `setPermissionMode`
flips; the AFK-exit case reuses the existing `toggleAfkMode(ctx, false)` helper.

## Verified facts (shadow-verify, all CONFIRMED via independent re-derivation)
- 4 modes: `default`, `plan`, `autonomous` (AFK), `bypassPermissions`. New
  installs default to `bypassPermissions` (`config.ts:342` `DEFAULT_CLI_PERMISSION_MODE`).
- Shift+Tab wired at exactly 2 call sites, both calling `togglePlanMode(ctx.slashCtx)`:
  `surface-setup.ts:~103` (persistent compositor) and `loop-iteration.ts:~206`
  (readLine fallback). `reader.ts`/`terminal-compositor*` only forward the callback.
- `toggleAfkMode` (`afk-mode-toggle.ts`) owns AFK's enter/exit machinery
  (push-budget reset, elicitation→ledger swap, abort-watcher start/stop,
  presence on/off) — all gated on `(sessionId && swap && fallback)`. These live
  ONLY there, not in `session.setPermissionMode` (`agent-session.ts:750`) nor in
  any provider `setPermissionMode` (anthropic-direct/openai-compatible/router).
  A raw `setPermissionMode('autonomous')` would leak the abort-watcher + strand presence.
- `togglePlanMode` and `/bypass` are pure (setPermissionMode + stats mirror +
  repaint + copy; no teardown).
- `plan-mode-addendum.test.ts` asserts `'/plan off'` literal but does NOT snapshot
  the `Shift+Tab` parenthetical — so rewording it stays green.
- `buildPrompt` (`repl-loop-shared.ts:~59`) renders a marker for `plan` and
  `autonomous` but NOT `bypassPermissions`.
- `repl-loop-wiring.test.ts:64` + `loop-iteration.test.ts:73` both
  `vi.mock('../../plan-mode-toggle.js')`. NUANCE: neither test actually *fires*
  the `onShiftTab` handler (FakeInputSurface stores/ignores it), so repointing
  won't break them — swapping the mock target is defensive (hermeticity).

## Step-by-step changes
1. **New `src/cli/permission-mode-cycle.ts`** — `PERMISSION_CYCLE =
   ['default','plan','bypassPermissions']` + `cyclePermissionMode(ctx)`:
   - `cur === 'autonomous'` → `await toggleAfkMode(ctx, false)` (clean exit to default); return.
   - else `idx = indexOf(cur)`; `next = ring[(idx+1) % len]` (out-of-ring → idx -1 → default).
   - `setPermissionMode(next)` + mirror `stats.permissionMode` + `repaintStatusLine()` + per-mode copy.
   - On `setPermissionMode` rejection: leave `stats` unchanged, surface via `ctx.out.error` (mirrors `togglePlanMode` contract).
2. **Repoint both `onShiftTab` handlers** (`surface-setup.ts`, `loop-iteration.ts`)
   from `togglePlanMode(ctx.slashCtx)` → `cyclePermissionMode(ctx.slashCtx)`; update inline comments.
3. **`buildPrompt`** (`repl-loop-shared.ts`) — add a `⚡ bypass` marker for prompt parity (status line already shows the chip).
4. **Doc/tip/addendum updates** (no behavior):
   - `loading-tips.ts:56` — "Shift+Tab cycles permission modes (default → plan → bypass)".
   - `input/types.ts:71-73` — `onShiftTab` doc comment.
   - `plan-mode-addendum.ts:49` — reword Shift+Tab parenthetical; KEEP `/plan off`.
   - `slash/commands/plan.ts` — doc (47-49) + hint (102).
   - `plan-mode-toggle.ts` — doc (13-14) + first-use tip (40).
   - `CHANGELOG.md` — add entry.
   - (`afk-mode-addendum.ts:46` "(or Shift+Tab) to restore default" stays accurate — AFK→Shift+Tab still lands on default.)
5. **Tests**:
   - New `permission-mode-cycle.test.ts` — ring advances default→plan→bypass→default; autonomous→`toggleAfkMode(false)`; out-of-ring→default; rejection leaves stats unchanged + errors.
   - Swap `vi.mock('plan-mode-toggle.js')` → `vi.mock('permission-mode-cycle.js')` in `repl-loop-wiring.test.ts` + `loop-iteration.test.ts`.
6. **Gates**: `pnpm lint` (strict tsc) + focused vitest (permission-mode-cycle, plan-mode-toggle, afk-mode-toggle, repl-loop-wiring, loop-iteration, plan-mode-addendum, status-line) + full suite.

## Risks
- **Lost "Shift+Tab exits plan" muscle memory / model desync.** From plan,
  Shift+Tab now → bypass, not default. Mitigated: reword `plan-mode-addendum.ts`
  (model-facing) + tips, keep `/plan off` for save-and-implement.
- **Accidental bypass escalation** via stray double-press from default. Accepted:
  bypass is already the new-install default, so it's not new exposure for most
  users; the ring is forward-only and the status line + prompt marker show the mode.
- **AFK churn** — eliminated by excluding AFK from the ring.

## Alternatives considered (devils-advocate; dissent=true, user chose)
- **O (original):** 4-mode ring + extract AFK helpers. Dropped — extraction
  unnecessary (`toggleAfkMode` already takes a boolean); strictly dominated by P.
- **P (pragmatist, strong):** 4-mode ring reusing existing toggles, no extraction.
  Adopted its build approach; user chose 3-mode over its 4-mode for safety.
- **R (paranoid, strong):** keep Shift+Tab=plan toggle + separate guarded key for
  AFK/bypass; no wrap through bypass. Drove the decision to exclude AFK and pick
  the safe ring. Repo evidence: `settable-keys.test.ts:95` names `permissionMode`
  a "self-escalation vector"; AFK machinery non-idempotent; `surface-setup.ts:107-108`
  calls Shift+Tab the "manual-takeover escape hatch."
- **A (architect, medium):** unified `PermissionModeManager.transitionTo` for all
  entry points. Deferred as YAGNI — only Shift+Tab needs cycling; revisit if a
  second new caller (config restore, Telegram `/mode`) appears.
