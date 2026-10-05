# Skill preview verification — 2026-10-03

## Outcome

Scoped acceptance verification is complete locally; ready for PR preparation, not pushed or submitted. Refreshed ground-state before changes: branch `afk/skill-dispatch-preview-ui`, clean starting SHA `aeac74ce0b6a541218f5547fa28292b60cc809ea`. Inspected existing log/diff and reused implementation and producer integration tests. No redesign.

Runtime code verified at `7f3a6c0eb`. This report's commit adds only documentation and corrects a stale fixture description. All new commits use AFK Agent <agent@agentafk.com> and DCO sign-off.

## Acceptance evidence

- `src/cli/_lib/stream-renderer-skill-identity-acceptance.test.ts`: five meaningful tests drive real renderer root/child tool events; require identity and both activity filenames in live frames; compare actual direct-compositor fallback (composer-null seam) with normal OverlayComposer; assert identity precedes root scrollback; owned compositor disarms once, with late events rejected.
- `src/cli/slash/_lib/run-skill-dispatch-turn-identity.test.ts`: three real dispatch/renderer tests for provider stream exception, cancel callback, and soft-stop. Assert interrupt routing, callback restoration, spinner shutdown, identity removal and no completed-turn accounting.
- `tests/pty/skill-identity-fixtures.ts`, `skill-identity-driver.ts`, `skill-identity.pty.test.ts`: real StreamRenderer + TerminalCompositor under node-pty and xterm reconstruction. Immediate, delayed, live pre-content, soft-cancel, interrupt, back-to-back and nested renderer lifetimes run in bottom-pinned and content-hug placements. Raw subprocess pipe verifies automatic non-TTY detection, once-only introduction before content, and absence of ESC bytes. Fifteen new tests plus thirty existing PTY tests.
- Existing `src/agent/tools/skill-executor/fork-renderer-identity.test.ts` connects resolved registry/plugin identity through manager sink into renderer ToolLane, including nested parentage/error isolation. `fork-dispatch-integration.test.ts` covers producer enrichment and call-scoped isolation.

## Actual issue reproduced and fixed

Both PTY placements reproduced a stale `interrupting… / Ctrl+C again to exit` affordance after cancellation/disposal. `src/cli/_lib/stream-renderer.ts:609–617` now resets `interrupting` before building disposal context/final overlay flush, matching existing soft-stop cleanup. Commit `7f3a6c0eb`. Both regressions are ordinary passing tests; no expected failures remain in this feature suite.

## Commands and results

- `pnpm run test src/cli`: **7,781 passed**, 445 files, 0 failures.
- `pnpm run test src/agent/tools/skill-executor`: **151 passed**, 7 files, 0 failures.
- `pnpm test:pty`: **45 passed**, 2 files, 0 failures (independent final rerun).
- `pnpm lint`: passed (`tsc --noEmit`).
- Initial `pnpm build` failed because dashboard/node_modules was missing. Resolved locally with `pnpm --dir dashboard install --frozen-lockfile`; lockfile unchanged. `pnpm build` then passed, including another final rebuild after the interrupt fix. Vite emitted a non-fatal >500 kB chunk warning.
- Passed: `pnpm audit:env:check`, `audit:chalk:check`, `audit:width:check`, `audit:filesize:check`, `audit:funcsize:check`, `audit:posix:check`, `audit:module-state:check`, `audit:sdk:check`.
- Passed: `pnpm scan:env:check`, `pnpm fix:pins:check`, `git diff --check`.
- Independent read-only final review found no blocking production issue. Its one stale expected-failure comment was corrected in this report commit.

## Boundaries

No paid provider/model invocations in acceptance fixtures. Provider streams and fork spawning are deterministic stubs; not a live-provider end-to-end run. Cancellation invokes installed callbacks rather than physical key bytes. PTY nested coverage exercises nested renderer lifetimes; fork metadata wiring is separately integration-tested. Live pre-content evidence is a deliberate terminal snapshot, not continuous timing capture or a full live preflight transaction. Full repository tests, dashboard tests, cross-platform PTYs and remote CI were not run. Broad CLI tests emitted fixture/error-path warnings (including listener and temporary trace cleanup warnings) but all passed. No push or PR was attempted; no upstream is configured. Local dashboard dependencies/build outputs remain ignored build artifacts.
