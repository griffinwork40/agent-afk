## Summary

Surfaces task responsibility labels on parallel agent rows in the TUI, making it easy to see which agent is doing what during concurrent execution.

### Before / After

**Before:**
```
◉ → Agent(research-agent) [1/2]  ∥2
◉ → Agent(research-agent) [2/2]  ∥2
```

**After:**
```
◉ → Agent(security & api-compat)  ∥1/2
◉ → Agent(correctness & coverage)  ∥2/2
```

---

## Changes

### 1. Batch index on live head row (`∥i/N`)

`activeToolBadge` now renders `∥i/N` instead of `∥N` for in-flight parallel agent rows. Each worker shows its 1-based position within the wave during execution, not just the total count. This completes the live-execution view: the task label (from `id_prefix` via `summarizeNestingArgs`) identifies the job, and `∥i/N` identifies the instance.

- **`tool-lane.ts`** `notifyToolActivity`: builds a `toolIndex: Map<id, position>` from the ordered `activeToolUseIds` array (1-based) and stores it in the `activeTools` snapshot.
- **`tool-lane-format.ts`** `activeToolBadge`: reads `toolIndex.get(id)` and renders `∥i/N` when available; falls back to `∥N` when the index is absent (backward compatible — existing tests using the old fixture shape are unaffected).
- **`tool-lane-overlay.ts`**: widens the `activeTools` parameter type to include the optional `toolIndex` field.

### 2. Skill dispatcher `id_prefix` labels

Updated bundled-skill SKILL.md files to instruct the model to set descriptive `id_prefix` values on every Agent dispatch. `summarizeNestingArgs` in `tool-lane-format-args.ts` already extracts `id_prefix` first, so this is the primary way to surface a label:

| Skill | Agent | `id_prefix` |
|---|---|---|
| `/review` (full) | Security + API compat | `"security & api-compat"` |
| `/review` (full) | Correctness + coverage | `"correctness & coverage"` |
| `/review` (light) | Single reviewer | `"full review"` |
| `/review` | Wave 2 synthesis | `"synthesis"` |
| `/diagnose` | Codebase search | `"codebase search"` |
| `/diagnose` | Git history | `"git history"` |
| `/diagnose` | Hypothesis testing | `"hypothesis: <cause>"` |
| `/research` | Web agent | `"web research"` |
| `/research` | Local inspection | `"local inspection"` |
| `/shadow-verify` | Each verifier | `"verify: <claim-phrase>"` |

**`contract.md`**: adds `id_prefix` as a required schema field so any skill that loads `/contract` inherits the labeling convention automatically.

### 3. Tests

- **`tool-lane-format.test.ts`**: two new `activeToolBadge` cases — `∥i/N` with `toolIndex` present; fallback `∥N` without it.
- **`tool-lane-batch-start.test.ts`**: first test updated to assert `∥1/2` and `∥2/2` appear after `notifyToolActivity(2, [...])`.

---

## Acceptance criteria

- [x] Major skill dispatchers (`/review`, `/diagnose`, `/research`, `/shadow-verify`) set descriptive `id_prefix` values
- [x] Parallel agent head rows show `∥i/N` instance index during execution
- [x] `pnpm lint` passes
- [x] Existing tests pass (6950 tests)
- [x] No modified file exceeds 350 code lines (`tool-lane-format.ts` = 336)
