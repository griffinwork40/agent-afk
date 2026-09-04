Implement Wave 1 of the infrastructure primitives tracked in issues #1411-#1423. Use parallel subagents in isolated worktrees to maximize throughput.

## Strategy

Run `/ground-state` first, then dispatch up to 4 concurrent implementation subagents (worktree concurrency ceiling), each in its own managed worktree via `isolation: "worktree"`. Each subagent implements one issue end-to-end: branch, code, tests, commit, push, open PR referencing the issue.

## Wave 1 targets (no inter-dependencies)

Pick from these -- they touch disjoint code areas and can land in any order:

1. **#1420 -- test-command discovery and invocation** (P2, area: dx)
   - Extend `src/agent/tools/handlers/test-runner-detector.ts` with project-level discovery
   - Create a `test_run` tool handler + schema
   - Wire `testResult` into at least one downstream consumer
   - Scope: `src/agent/tools/handlers/`, `src/agent/tools/schemas.ts`, `src/agent/providers/shared/tool-result.ts`

2. **#1417 -- declarative wait_for primitive** (P2, area: core)
   - New `wait_for` tool handler that polls conditions in Node without consuming model turns
   - Condition types: `command`, `file`, `url`, `process` at minimum
   - SSRF guard on URL waits via `src/web/egress-guard.ts`
   - Scope: new tool handler + schema, reuse `src/agent/providers/shared/sleep-with-abort.ts` patterns

3. **#1419 -- atomic patch and dry-run** (P3, area: core)
   - New `patch_apply` tool accepting structured multi-file changes
   - Validate-before-apply with content hash verification
   - Dry-run mode returns diff without applying
   - Reuse `src/utils/diff.ts`, `src/agent/grant-manager.ts`, `src/agent/tools/handlers/write-denylist.ts`

4. **#1411 -- durable task lifecycle** (P1, area: core)
   - Lease-based queue recovery in `src/agent/daemon/queue-store.ts`
   - DAG checkpoint persistence alongside `src/agent/dag.ts`
   - Retry policy on task records
   - Scope: `src/agent/daemon/`, `src/agent/dag.ts`

If any finish early, backfill from:
5. **#1414 -- durable structured state** (P1, area: core) -- new namespaced JSON store
6. **#1423 -- JSON query tool** (P3, area: dx) -- bounded jq-subset queries, smallest scope

## Constraints

- **Worktree isolation is mandatory.** Use `isolation: "worktree"` on every implementation subagent. Never have two subagents writing to the same tree.
- **Concurrency ceiling: 4.** Do not dispatch more than 4 write-capable subagents simultaneously.
- **Each subagent must run `pnpm install` in its worktree** before building or testing (no shared node_modules in worktrees).
- **Each subagent must pass `pnpm lint` and `pnpm test` in its worktree** before committing. If `pnpm test:coverage` fails on thresholds, `pnpm test` alone is acceptable.
- **Never `git add -A`.** Stage specific files only.
- **PR body via `--body-file`, never inline markdown in shell commands.**
- **Never force-push.** Each subagent pushes its branch and opens a draft PR with `Closes #NNNN` in the body.
- **350 LOC ceiling.** New files must stay under 350 code lines. Split concerns into sibling files if needed. Run `pnpm audit:filesize:check` before committing.
- **env.ts indirection.** Any new env var goes through `src/config/env.ts` + `ENV_REGISTRY`. Run `pnpm audit:env:check`.
- **Tool schema in `src/agent/tools/schemas.ts`.** New tools need schema entries there.

## Subagent brief template

Each subagent prompt should include:
- The issue number and title
- The specific files to read first (from the issue body's "Verified current behavior" table)
- The proposed interface from the issue body
- The acceptance criteria as a checklist
- Explicit instruction to: create branch `feat/<short-name>`, implement, add tests, run lint+test, commit with `feat(scope): <description> (#NNNN)`, push, open draft PR

## Coordination

After all subagents complete:
1. Collect the PR URLs from each
2. Verify no merge conflicts between the branches (they shouldn't conflict given disjoint scope)
3. Report the results as a table: issue number, PR number, status (open/failed), branch name

Do not implement #1412, #1413, #1415, or #1416 in this wave -- they depend on #1411 or #1414 landing first.
