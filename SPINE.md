# SPINE.md — Project Architecture Spine

> Auto-maintained by agent-afk at session end. Edit entries manually if needed; IDs are stable.


## Invariants

- **INV-001** (2026-09-17, spine-init): Long comment blocks (≥15 lines) must open with `// Invariant:`, `// Contract:`, or `// History:`
- **INV-002** (2026-09-17, spine-init): Every DECSTBM emit must be bracketed by `\x1b[s`/`\x1b[u` save/restore or carry a comment explaining why cursor-home is 
- **INV-003** (2026-09-17, spine-init): Before first `log-update.render()` of a session, cursor must be at the target row (typically `stdout.rows - 1`)
- **INV-004** (2026-09-17, spine-init): Lifecycle flag must be set synchronously before any `await` that could trigger interval timer or resize handler re-entry
- **INV-005** (2026-09-17, spine-init): Published npm artifact must not ship test scaffolding or stray internal-tier IP
- **INV-006** (2026-09-17, spine-init): package.json advertises dist/index.d.ts as the public types entry point
- **INV-007** (2026-09-17, spine-init): Audit scripts run against PREPARED SOURCE TREE, not compiled `dist/*.mjs`
- **INV-008** (2026-09-17, spine-init): Audit contracts throw with every offending file:line on first failure; return success only when all pass
- **INV-009** (2026-09-17, spine-init): File code-line ceiling is 350 LOC (comments/blanks excluded), ratcheted against `.filesize-baseline.json`
- **INV-010** (2026-09-17, spine-init): Footer URL must be visible on every post regardless of content length
- **INV-011** (2026-09-17, spine-init): When `AFK_RELEASE_THREADS_TOKEN` is set, it MUST route posts to the designated thread
- **INV-012** (2026-09-17, spine-init): Pass postText to spawnSync as an argv element, NOT as part of a shell command string
- **INV-013** (2026-09-17, spine-init): Audit only on state change (see dispatcher.addReadRoot) — not on repeat grants
- **INV-014** (2026-09-17, spine-init): Witness traces are the durable record of agent execution; tool args in events.jsonl, prompts/outputs in separate capture


## Explicitly Rejected Patterns

- **REJ-001** (2026-09-17, spine-init): No raw process.env reads outside src/config/env.ts
- **REJ-002** (2026-09-17, spine-init): No raw chalk.<color> calls outside src/cli/palette.ts
- **REJ-003** (2026-09-17, spine-init): No hard wrap enabled in thinking-paragraph rendering (reverted in #1454 fix attempt)
- **REJ-004** (2026-09-17, spine-init): Do not extract sessionSummary and costTokenLine as separate render components (reverted in #1401)


## Taste Calls Made

- **TST-001** (2026-09-17, spine-init): pnpm exclusively (lockfile is pnpm-specific); Node ≥22 required
- **TST-002** (2026-09-17, spine-init): Run single test with `pnpm test <file> -t <name>` scoped to file, not `--` (pnpm 10 drops args after --)
