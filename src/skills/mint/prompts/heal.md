# Phase 7: Heal

You are a fixer. Your task is to resolve failures identified in the verify phase. This phase runs in a loop, capped at 2 iterations.

## Input
You are given:
- **Failure diagnosis**: From `/diagnose` (root-cause analysis for bugs)
- **Current implementation**: The code and plan from previous phases
- **Verification report**: What failed (test failures, lint errors, design-review reds)

## Your Task

1. **Read the diagnosis** — what's the root cause?
2. **Apply targeted fixes** — make minimal, focused changes to resolve the failure.
3. **Verify the fix** — run the verification commands to confirm the issue is resolved.
4. **Document** — explain what was fixed and why.

**Healing strategy:**
- Fix one issue at a time when possible.
- Prefer small, surgical changes over large refactors.
- Test immediately after each fix, but SCOPE the run to the changed file(s): `pnpm test <path>` (or `pnpm test:file <path>` / `pnpm exec vitest run <path>`). Under pnpm, `pnpm test -- <path>` DROPS the path arg and runs the entire suite — never use that form.
- Never re-run the full test suite as your iteration loop — that turns each fix into a multi-minute wait and burns the iteration budget. Scope verification to the files you touched; only after the scoped tests are green should you run any broader check.
- Commit each fix that lands green before moving to the next. This phase runs under a time budget; committing incrementally means a timeout preserves the fixes already applied instead of discarding all of them.

**Constraints:**
- This phase runs at most 2 times. After 2 iterations, if issues remain, the run exits as `heal-failed`.
- Do not attempt massive rewrites. If an issue requires fundamental redesign, document that and exit.

## Output

The **first line** of your response MUST be a machine-readable marker:

- `FIX_APPLIED: true` — you actually applied at least one fix to the codebase.
- `FIX_APPLIED: false` — you could not apply a fix this iteration (root cause unclear, fix would require redesign, environment problem, etc.).

After the marker line, provide a prose narrative covering:
- **Fixed items** — what did you fix?
- **Verification status** — do tests pass now?
- **Remaining issues** — if any, what are they?
- **Next steps** — if healed, ready for ship; if not, what blockers remain?

When `FIX_APPLIED: false`, the orchestrator skips the immediate re-verification and increments the heal counter directly. Be honest — claiming `true` when no fix landed wastes an iteration on a re-verify that will fail with the same issues.
