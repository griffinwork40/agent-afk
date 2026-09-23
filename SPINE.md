# SPINE.md — Project Architecture Spine

> Auto-maintained by agent-afk at session end. Edit entries manually if needed; IDs are stable.


## Invariants

- **INV-001** (2026-09-17, spine-init): Long comment blocks (≥15 lines) must open with `// Invariant:`, `// Contract:`, or `// History:` (reinforced 2026-09-18)
- **INV-002** (2026-09-17, spine-init): Every DECSTBM emit must be bracketed by `\x1b[s`/`\x1b[u` save/restore or carry a comment explaining why cursor-home is safe at that site (DEC VT spec: CSI r always homes the cursor to (1,1)) (`src/cli/status-line.ts:286-290`)
- **INV-003** (2026-09-17, spine-init): Before first `log-update.render()` of a session, cursor must be at the target row (typically `stdout.rows - 1`)
- **INV-004** (2026-09-17, spine-init): Lifecycle flag must be set synchronously before any `await` that could trigger interval timer or resize handler re-entry
- **INV-005** (2026-09-17, spine-init): Published npm artifact must not ship test scaffolding or stray internal-tier IP
- **INV-006** (2026-09-17, spine-init): package.json advertises dist/index.d.ts as the public types entry point
- **INV-007** (2026-09-17, spine-init): Audit scripts run against PREPARED SOURCE TREE, not compiled `dist/*.mjs`
- **INV-008** (2026-09-17, spine-init): Audit contracts throw with every offending file:line on first failure; return success only when all pass
- **INV-009** (2026-09-17, spine-init): File code-line ceiling is 350 LOC (comments/blanks excluded), ratcheted against `.filesize-baseline.json` (partially weakened to advisory/non-blocking in #1003; gate still emits violations but does not fail CI)
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
- **INV-023** (2026-09-22, d09d5fe9): All file persistence must use src/utils/atomic-write.ts (tmp+rename); no inline atomic-write implementations (#1921) (reinforced 2026-09-22 by #1833/#1839)
- **INV-024** (2026-09-22, 9e37173b): GrantManager interface must live in agent/tools/ layer, not cli/ — agent layer must not import cli/ for its own type definitions (#1856)
- **INV-025** (2026-09-22, spine-audit): Abort signal is unconditional and terminal — if `signal.aborted` is true, callers must throw AbortError even if a hook would return `continue: true`. Abort takes precedence over every other decision surface (`src/agent/abort-graph.ts:9-12`)
- **INV-026** (2026-09-22, spine-audit): In AbortGraph.abort(), the full descendant list must be materialized via BFS BEFORE any controller.abort() fires, and the emitAbort trace event must fire BEFORE the controllers — firing aborts inside the BFS races addEventListener listeners from linkChild (`src/agent/abort-graph.ts:203-236`)
- **INV-027** (2026-09-22, spine-audit): AFK_MAX_NESTING_DEPTH is resolved ONCE at the root session and propagated down through child AgentConfig.maxDepth — children never re-read the environment (`src/agent/tools/nesting.ts:56-60`)
- **INV-028** (2026-09-22, spine-audit): Compose nodes must not receive subagentExecutor or skillExecutor — they are task-worker leaves. buildComposeNodeProvider() is the ONLY approved provider; childProviderFactory (which bundles both executors) must never be used for compose nodes (`src/agent/tools/nesting.ts:343-355`)
- **INV-029** (2026-09-22, spine-audit): AgentConfig.tools.allowedTools is telemetry-only — NOT the enforcement point. The dispatcher gates on permissions.allowedTools on the constructed provider. buildPhaseRestrictedProvider/buildSkillRestrictedProvider/buildReadOnlyReconProvider are the only approved paths (`src/agent/tools/nesting.ts:568-572`)
- **INV-030** (2026-09-22, spine-audit): Compaction must NEVER mutate messages on any failure path (too-short, nothing-to-summarize, aborted, timeout, failed, empty-summary). Mutation happens only after applyCompaction succeeds via messages.splice. An empty/whitespace summary is refused rather than spliced (`src/agent/providers/shared/compaction.ts:598-679`)
- **INV-031** (2026-09-22, spine-audit): microcompactToolResults must NEVER remove a tool_use or tool_result block — only swap a result's content for a placeholder. Every tool_use keeps its matching tool_result at the same position/id. MICROCOMPACT_PLACEHOLDER_SENTINEL prefix makes repeated passes idempotent (`src/agent/providers/shared/compaction.ts:280-305`)
- **INV-032** (2026-09-22, spine-audit): Every child session gets readOnlyMemory: true — subagents may search but cannot persist new memory. The parent session is the only writer; subagent writes would cause uncoordinated fan-out into the shared store (`src/agent/tools/nesting.ts:276-284`)
- **INV-033** (2026-09-22, spine-audit): MCP transport reconnect after a failed Client.connect() requires a FRESH Client instance — the SDK sets an internal transport reference on failure and calling connect() again always throws "Already connected" (`src/agent/mcp/client.ts:203-231`)
- **INV-034** (2026-09-22, spine-audit): contextWindowTokens in ProviderUsage is a single-round measurement — must NOT be summed across rounds. Billing tokens (inputTokens/outputTokens) accumulate cumulatively; the footprint field does not. Provider-specific formula must be preserved (`src/agent/provider.ts:63-83`)
- **INV-035** (2026-09-22, spine-audit): ProviderRouter carries a TEXT-ONLY shadow history across provider family switches — Anthropic thinking blocks (crypto-signed) have no OpenAI equivalent and tool-call ID schemas differ. No migration attempts to preserve structured content (`src/agent/providers/router/provider-router.ts:33-42`)
- **INV-036** (2026-09-22, spine-audit): In compositor arm(), the stdin claim must be acquired BEFORE raw mode and bracketed-paste are enabled — a conflict rejects arm() with nothing to roll back if the claim is taken after raw mode is set (`src/cli/terminal-compositor.lifecycle.ts:169-178`)
- **INV-037** (2026-09-22, spine-audit): Worktree sweep commitsUnpushed fails SAFE — if no upstream is configured, ref is unreadable, or any git error occurs, it is treated as commitsUnpushed === commitsAhead (unreplaceable). Must never be derived from commitsAhead === 0 (`src/agent/worktree/worktree-sweep.ts:108-115`)
- **INV-038** (2026-09-22, spine-audit): env.ts secret entries must be enumerable: false to prevent credential leakage via JSON.stringify(env) or Object.keys(env). Duplicate ENV_REGISTRY names throw at module load via _seenEnvNames guard (`src/config/env.ts:1960-1990`)
- **INV-039** (2026-09-22, spine-audit): ProviderRouter is only instantiated when config.provider is unset. When a caller injects a provider, the router is never constructed — code assuming the router is always present will bypass per-turn credential resolution and model-switch-notice injection (`src/agent/providers/router/provider-router.ts:29-31`)
- **INV-040** (2026-09-22, 8f778a31-6f10-4939-b681-24c4b5beb507): Trace writers are fire-and-forget observability; absence never affects dispatch logic or correctness (reinforced 2026-09-22 by gate_shape telemetry in `src/agent/tools/dispatcher.execute-batch.ts:226-235`)
- **INV-041** (2026-09-22, 8f778a31-6f10-4939-b681-24c4b5beb507): Gate-shape telemetry (safeCount, unsafeCount, parallelGatesMs) emitted exactly once per batch after Phase 1 gates settle
- **INV-042** (2026-09-22, 8f778a31-6f10-4939-b681-24c4b5beb507): Parallel gate wall-clock must be measured from phase entry, not per-gate; captured before wave begins, read after settle
- **INV-043** (2026-09-22, 8f778a31-6f10-4939-b681-24c4b5beb507): Goals scoped per git repository via projectKey parameter; fallback to 'current' key for backward compatibility (reinforced 2026-09-22) (`src/agent/goals/goal-store.ts:14-23`)
- **INV-044** (2026-09-22, 8f778a31-6f10-4939-b681-24c4b5beb507): Project key derivation uses git-common-dir mode so linked worktrees of same repo share the same goal key (reinforced 2026-09-22) (`src/agent/goals/goal-utils.ts:34-62`)
- **INV-045** (2026-09-22, 8f778a31-6f10-4939-b681-24c4b5beb507): Goal injection via injectGoalPrompt() must derive projectKey from config.cwd and pass to buildGoalPromptFragment() (reinforced 2026-09-22) (`src/agent/goals/inject.ts:18-23`)
- **INV-046** (2026-09-22, af7dde45-59bf-448b-a092-700aed35e925): Orphan tool_use repair must scan all assistant turns, not just the tail, and splice repairs mid-sequence (reinforced 2026-09-22 by #2007) (`src/agent/providers/anthropic-direct/query/repair-orphan-tool-uses.ts:1-86`)
- **INV-047** (2026-09-22, af7dde45-59bf-448b-a092-700aed35e925): Content blocks deserialized from disk must be validated against ALLOWED_CONTENT_BLOCK_TYPES allowlist before forwarding to Anthropic API (`src/agent/providers/anthropic-direct/resolve-params.ts:146-182`)
- **INV-048** (2026-09-22, 480fa9c1-899d-4a8a-a884-06beac35cd0a): Orphan repair helpers must be factored to enable mid-sequence pairing validation across any assistant/user boundary (reinforced 2026-09-22); hasValidToolUsePairing() staged for wiring (`src/agent/providers/anthropic-direct/resolve-params.ts:203-229`)
- **INV-049** (2026-09-22, fb1f3eac-8338-4736-b7b4-8f44ce7217d8): isSubagentContext() extracted to src/agent/hooks/hook-utils.ts; all subagent checks must use this function, not inline parentSessionId checks (`src/agent/hooks/hook-utils.ts:13-15`)
- **INV-050** (2026-09-22, fb1f3eac-8338-4736-b7b4-8f44ce7217d8): Abort signal forwarding must use forwardAbortSignal() utility from src/utils/abort.ts; hand-coded abort listeners must not be added directly (`src/utils/abort.ts:11-22`)
- **INV-051** (2026-09-22, fb1f3eac-8338-4736-b7b4-8f44ce7217d8): Error status extraction must use getErrorStatus() from src/agent/providers/shared/error-status.ts; both Anthropic and OpenAI-compatible providers must use the shared extractor (`src/agent/providers/shared/error-status.ts:25-29`)
- **INV-052** (2026-09-22, 40d6aa9a-531d-4970-9c68-38ea62305453): pinnedReadRoots suppresses parent inheritance; extraReadRoots composes additively. Field name signals semantics to callers (`src/agent/dag-subagent.ts:57-82`)
- **INV-053** (2026-09-22, 4bfcc723-17a3-457b-8cfc-192ac9cccc71): Confined subagents must be granted read access to the skills directory to discover sibling skill definitions.


## Explicitly Rejected Patterns

- **REJ-001** (2026-09-17, spine-init): No raw process.env reads outside src/config/env.ts
- **REJ-002** (2026-09-17, spine-init): No raw chalk.<color> calls outside src/cli/palette.ts
- **REJ-003** (2026-09-17, spine-init): No hard wrap enabled in thinking-paragraph rendering (reverted in #1454 fix attempt)
- **REJ-004** (2026-09-17, spine-init): Do not extract sessionSummary and costTokenLine as separate render components (reverted in #1401)
- **REJ-005** (2026-09-22, spine-audit): Do not use AgentConfig.tools.allowedTools to enforce tool permissions on subagents — it is telemetry-only and never reaches the dispatcher. Only permissions.allowedTools on the constructed provider enforces (`src/agent/tools/nesting.ts:568-572`)
- **REJ-006** (2026-09-22, spine-audit): Do not advertise MCP sampling capability in CLIENT_CAPABILITIES — sampling-dependent server tools silently hang waiting for a sampling/createMessage response that never comes (`src/agent/mcp/client.ts:14-22`)
- **REJ-007** (2026-09-22, spine-audit): Do not use Date.now() or pid+Date.now() for atomic temp file naming — concurrent writes within the same ms share a name and silently overwrite. Use crypto.randomBytes(6) (`src/utils/atomic-write.ts:24-30`)
- **REJ-008** (2026-09-22, spine-audit): Do not fork a new session on /model switch — doing so resets cost/token/turn accumulators and re-fires SessionStart/SessionEnd hooks. ProviderRouter swaps only the inner provider below the session level (`src/agent/providers/router/provider-router.ts:21-25`)
- **REJ-009** (2026-09-22, spine-audit): Path-approval hook is NOT a security boundary against an adversarial model — it only intercepts typed file tools. Bash has known bypasses (interpreter scripts, variable assembly, /proc/self/fd, brace expansion). OS-level sandboxing required for adversarial containment (`src/agent/tools/hooks/path-approval-hook.ts:9-17`)


## Taste Calls Made

- **TST-001** (2026-09-17, spine-init): pnpm exclusively (lockfile is pnpm-specific); Node ≥22 required
- **TST-002** (2026-09-17, spine-init): Run single test with `pnpm test <file> -t <name>` scoped to file, not `--` (pnpm 10 drops args after --)
- **TST-003** (2026-09-17, 6c724132): Use optional ServiceInstallOptions parameter to pass backend re-render directives during service operations
- **TST-004** (2026-09-22, 739d2492): Single canonical ToolDispatcher type in agent/providers/ — no ToolDispatcherLike alias indirection (#1861)
- **TST-005** (2026-09-22, spine-audit): Hook handlers dispatch SEQUENTIALLY in registration order — parallel dispatch deliberately not chosen. Multiple non-blocking injectContext values concatenated with '\n' in order; blocking handler short-circuits before accumulation (`src/agent/hooks.ts:7-9`)
- **TST-006** (2026-09-22, spine-audit): SessionStart.injectContext is delivered only to top-level (parent) sessions — subagent forks skip the queue check when parentSessionId is set, avoiding prepended priming context on every subagent prompt (`src/agent/hooks.ts:49-57`)
- **TST-007** (2026-09-22, spine-audit): Atomic temp files default to mode 0o600 (owner read/write only) so secrets are not briefly world-readable between write and rename (`src/utils/atomic-write.ts:50-55`)
- **TST-008** (2026-09-22, spine-audit): Worktree sweep MIN_EMPTY_AGE_MS (1 hour) and the occupancy heartbeat interval are deliberately cross-referenced — raising the heartbeat above the empty-age gate silently re-breaks ghost-reaping with no test failures (`src/agent/worktree/worktree-sweep.ts:214-224`)
- **TST-009** (2026-09-22, spine-audit): execFile callers that produce large output MUST set maxBuffer — Node's default 1MB cap rejects the promise on overflow rather than truncating. In the sweep engine, every failure path fails safe by protecting the worktree (`src/agent/worktree/worktree-sweep.ts:40-47`)
- **TST-010** (2026-09-22, 8f778a31-6f10-4939-b681-24c4b5beb507): Project key format: `proj.<sanitized-basename>-<sha1_hex8>`; sanitizes special chars to `_`, caps at 128 chars
- **TST-011** (2026-09-22, 40d6aa9a-531d-4970-9c68-38ea62305453): Compaction core algorithm factored to shared/compaction.ts; provider-specific ops passed as collaborators to runCompactionCore() (`src/agent/providers/shared/compaction.ts:556-612`)
