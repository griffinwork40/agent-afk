# SPINE.md — Project Architecture Spine

> Auto-maintained by agent-afk at session end. Edit entries manually if needed; IDs are stable.


## Invariants

- **INV-001** (2026-09-17, spine-init): Long comment blocks (≥15 lines) must open with `// Invariant:`, `// Contract:`, or `// History:` (reinforced 2026-09-21)
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
- **INV-015** (2026-09-17, 6c724132): Service restart must preserve custom environment variables across upgrades via config re-render
- **INV-016** (2026-09-17, 2aafb714): Atomic plist upgrade uses tmp-then-rename write strategy; byte-equal content skips write (no-op safety)
- **INV-017** (2026-09-17, 151dc338): Service upgrade must detect and safely skip writes when config content is byte-identical to disk (no-op idempotence)
- **INV-018** (2026-09-17, 151dc338): ServiceManager.upgrade() must never invoke launchctl; caller responsible for applying updated config to running job
- **INV-019** (2026-09-18, 3c2d6194-0ab7-4c30-a9e2-56e9d477ae2d): Hook block decisions must be traced with hook_decision events; blocks/throws always emit trace records
- **INV-020** (2026-09-18, 3c2d6194-0ab7-4c30-a9e2-56e9d477ae2d): Handler exception caught in hook dispatch must wrap in HookBlockedError (fail-safe, not fail-open)
- **INV-021** (2026-09-18, 3c2d6194-0ab7-4c30-a9e2-56e9d477ae2d): Hook handler return { decision: 'block' } must short-circuit the handler chain immediately
- **INV-022** (2026-09-18, f1884bb2-c075-46d5-b0ea-f61d48342e64): Overlay content must not exceed viewport height; cap after word-wrap to prevent ghost-row duplicates in scrollback
- **INV-023** (2026-09-20, 14f28f71-2484-4a6d-8051-8de4fab6d70f): Try/catch guard must span ALL statements from subagent register to active.set, including async operations. (reinforced 2
- **INV-024** (2026-09-20, 14f28f71-2484-4a6d-8051-8de4fab6d70f): Occupancy heartbeat teardown must live on the settle callback of the subagent handle. (reinforced 2026-09-21)
- **INV-025** (2026-09-20, 77b0e613-0c77-42fa-99fd-847c5d7ed4a0): Pre-construction failure cleanup must fire SubagentStop events for symmetry with SubagentStart. (reinforced 2026-09-21)
- **INV-026** (2026-09-20, 74b26044-ff88-4e7e-8155-90d0118e5cac): On-terminal settle callback must remain idempotent to survive cancel/run race conditions. (reinforced 2026-09-21)
- **INV-027** (2026-09-20, 74b26044-ff88-4e7e-8155-90d0118e5cac): Delegation tool results (agent/compose/skill) must use higher clearance threshold (8x ordinary) in microcompaction. (rei
- **INV-028** (2026-09-20, 0486d84e-a6d2-4677-b999-6aa6ba976fc1): Atomic file write must be centralized in utils/atomic-write.ts; all file persistence routes through this module. (reinfo


## Explicitly Rejected Patterns

- **REJ-001** (2026-09-17, spine-init): No raw process.env reads outside src/config/env.ts
- **REJ-002** (2026-09-17, spine-init): No raw chalk.<color> calls outside src/cli/palette.ts
- **REJ-003** (2026-09-17, spine-init): No hard wrap enabled in thinking-paragraph rendering (reverted in #1454 fix attempt)
- **REJ-004** (2026-09-17, spine-init): Do not extract sessionSummary and costTokenLine as separate render components (reverted in #1401)


## Taste Calls Made

- **TST-001** (2026-09-17, spine-init): pnpm exclusively (lockfile is pnpm-specific); Node ≥22 required
- **TST-002** (2026-09-17, spine-init): Run single test with `pnpm test <file> -t <name>` scoped to file, not `--` (pnpm 10 drops args after --)
- **TST-003** (2026-09-17, 6c724132): Use optional ServiceInstallOptions parameter to pass backend re-render directives during service operations
