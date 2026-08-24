## Summary

Implements Phase 2 of issue #12: job-to-be-done category grouping for `/skills`.

Categories are **authored** at the source (in `SKILL.md` frontmatter or `registerSkill()` calls) — never inferred at render time.

## Changes

### Core interface & vocabulary
- **`src/skills/index.ts`** — Adds `category?: string` to `SkillMetadata`; exports `SKILL_CATEGORIES` const (7 canonical categories in render order) + `UNCATEGORIZED_LABEL = 'More skills'`.

### Harvesting from SKILL.md frontmatter
- **`src/cli/slash/_lib/flag-harvest.ts`** — No change needed; `parseSkillMd` already returns the `frontmatter` record.
- **`src/skills/user-skills.ts`** — `parseUserSkillMd` now reads `category` from frontmatter and threads it into `SkillMetadata` via `scanSkillsFromDir`.
- **`src/cli/slash/plugin-skills/flags.ts`** — Introduces `harvestPluginSkillMetadata()` (single-pass walk returning `{ flags, categories }`). `harvestPluginSkillFlags()` delegates to it for backwards compatibility.
- **`src/cli/slash/plugin-skills/state.ts`** — `DiscoveredSkill` grows `category?: string`.
- **`src/cli/slash/plugin-skills/dispatch.ts`** — `registerPluginSkills()` now calls `harvestPluginSkillMetadata()` (replacing the separate flags-only call) and threads `category` into each `DiscoveredSkill`.

### Rendering
- **`src/cli/slash/plugin-skills/listing.ts`** — `ListingGroup` carries `category?`; `buildListingGroups` propagates category from both registry skills and plugin skills. `renderUnifiedListing` switches to category-grouped layout when ≥1 skill has a category (canonical order, empty categories omitted, un-categorised skills in "More skills"); falls back to the legacy two-block layout when no category is authored.

### Built-in skill annotations (4 of 5 requested)
- **`src/skills/mint/index.ts`** — `category: 'Build & ship'`
- **`src/skills/telegram-setup/index.ts`** — `category: 'Setup & ops'`
- **`src/skills/service-setup/index.ts`** — `category: 'Setup & ops'`
- **`src/skills/get-started/index.ts`** — `category: 'Setup & ops'`

> **Note on `audit-fit`**: The issue listed `diagnose` (a plugin skill, not a built-in) in the set of 5. The actual 5th built-in candidate is `audit-fit`, but that file is already in the filesize-baseline at 421 code lines and the `--check` ratchet prohibits growing it. Category annotation is deferred to a follow-up extract of `audit-fit` into sibling files.

### Tests
- **`src/cli/slash/plugin-skills-category.test.ts`** *(new)* — 8 tests covering category headers, "More skills" bucket, canonical render order, empty-category omission, legacy fallback, plugin skill grouping, vocabulary invariants.

## Verification

```
pnpm lint           ✅  (tsc --noEmit clean)
pnpm test --run src/cli/slash/ src/skills/
                    ✅  72 test files, 1064 tests pass
pnpm audit:filesize:check
                    ✅  no new violations (2 pre-existing GREW violations in
                        openai-compatible/index.ts and daemon.ts, both in
                        .filesize-baseline.json before this PR)
```

## Canonical category vocabulary

| Order | Category |
|-------|----------|
| 1 | Build & ship |
| 2 | Debug & fix |
| 3 | Understand & explore |
| 4 | Refactor & simplify |
| 5 | Review & verify |
| 6 | Setup & ops |
| 7 | Author & meta |

Un-annotated skills → **More skills** (always last).

## Design decisions preserved from issue
- No inference at render time — category is authored or absent
- Phase 1 detail card, audience gate, wrapping, inline shadow suffixes are untouched
- Empty categories are silently omitted from the listing
