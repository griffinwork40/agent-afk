<!-- Design record for the what-if engine, copied from the approved plan (.afk/plans is gitignored). User guide: docs/whatif.md. -->

# What-If Prediction Engine (`afk whatif` / `/whatif`)

Status: approved 2026-09-26. Owner: agent session bfc57f5f.

## Goal

A general, high-level prediction engine: given ANY proposed change to an agent's
environment (prompt / AFK.md overlay, HOT.md, memory facts, skills, plugins,
hooks, MCP servers, config, env vars, model, effort), predict how the agent's
behavior will change and summarize it in plain English so a possibly
non-technical user can decide whether to accept the change. Usable from the CLI
(`afk whatif`) and in the REPL (`/whatif`).

## Research basis (why this shape)

- Zero-shot self-prediction by LLMs is near chance (Binder et al., "Looking
  Inward", ICLR 2025). Static prediction alone is not trustworthy; it must be
  labeled a guess and verified empirically.
- Industry tools (promptfoo, Braintrust, LangSmith, DeepEval, Inspect) do
  empirical A/B, none do change -> plain-English behavioral summary end to end.
- D5 propose-then-verify (Zhong et al. 2022) is the method for describing
  differences between two output distributions; unverified proposals match
  humans ~7% of the time, verified ones far better.
- Detecting moderate shifts needs roughly 100-200 samples, ~3 per case.
- A composition-boundary check showed a prompt-only diff misses the routing /
  end-of-turn directives (appended post-assembly, `src/agent/routing-directive.ts:149`),
  per-turn hook injections (`loop-iteration.ts:595`), tool schemas
  (`provider-schemas.ts:36`), and runtime memory retrieval; and recorded user
  turns carry old-context preambles (`src/web-server/session-source.ts:59,95`).

## Core abstraction

Every change is a transform on the agent's **environment**:
`(AFK_HOME tree, project tree, launch settings)`. The engine materializes two
isolated sandboxes, baseline and candidate, identical except for the change,
runs the same episodes through the REAL agent in both, and explains the
difference. Because the real runtime runs, effects a prompt diff cannot see are
captured (memory retrieval, hooks, skills, model, MCP).

## Prediction levels (each usable alone)

0. **Structural impact (free, no model calls):** what changed, exact assembled
   system prompt + tool list diff (via the runtime's own prompt dump), token /
   per-turn cost delta, tools or skills added/removed.
1. **Predicted changes (~1 cent):** labeled list of up to 8 predicted behavior
   changes (added/removed/strengthened/weakened, confidence, reason, yes/no
   test question). Always labeled a guess. Prompt includes the engine's own
   track record per change kind.
2. **`--verify` measured behavior:** short episodes in both sandboxes; before vs
   after rates with uncertainty; each prediction marked Confirmed / Refuted /
   Unclear; plus unpredicted differences (propose-then-verify).
3. **Calibration:** every prediction + verified outcome appended to
   `~/.afk/state/whatif/ledger.jsonl`, fed back into level 1.

## Specifying a change (same grammar on CLI and REPL)

- Plain English: `afk whatif "turn off auto-routing and remember I prefer pnpm test:file"`
  -> compiled to a ChangeSpec, shown, confirmed before running.
- Flags: `--append <text>`, `--file <path>=<newfile>`, `--memory-add "<fact>"`,
  `--memory-remove <id>`, `--disable-skill <name>`, `--disable-plugin <name>`,
  `--model <id>`, `--effort <level>`, `--env KEY=value` (non-secret only).
- `--spec change.yaml|json`: reusable bundle of changes.
- `--from-git`: uncommitted edits to agent-context files as the change (later).

Each change kind is a plug-in behind one `ChangeOperator` interface.

## Episode execution and safety

- Sandbox: config files copied (never symlinked, writes could go through a
  link to the real file); large read-only trees (skills, plugins) symlinked
  unless the change touches them; fresh state dir per sandbox; memory DB copied.
- Credentials never copied: the child inherits the parent's env; OAuth reads
  from its hard-coded location (`src/agent/auth/keychain.ts:144`).
- Each episode is a subprocess of the real agent (`afk chat`, registered
  subcommand) with `AFK_HOME` / `AFK_STATE_DIR` pointed at the sandbox. Out of
  process because config/env is process-global and would leak into the live
  REPL.
- **Episode mode** (new, tree-wide PreToolUse gate): read-only tools execute;
  the first side-effecting action (writes, mutating bash, network POST,
  messaging, git push, delegation) is RECORDED as the decision and NOT executed;
  every tool call with args logged to a file. Capped tool rounds (default 3).
- Also in episode mode: MCP off unless the change concerns MCP, notifications /
  `--post` off, nested delegation off, `whatif` refuses to run inside an
  episode (recursion guard).
- Budget: preflight estimate, `--max-usd` (default 5), running-spend abort,
  concurrency 4, `--quick` = first decision only.

## Episode sources

Recent real user turns (preambles stripped, secrets redacted), synthetic probes
per prediction, optional user scenario suites (`~/.afk/whatif/suites/*.yaml`).

## Observation and judging

- Deterministic features from the tool log: first action kind, tools used,
  asked-before-acting, delegated, skills used, memory searched, rounds, tokens,
  cost, errors.
- Judged features: each prediction's test question.
- Discovery: propose-then-verify unpredicted differences.
- **Judge: Jev by default** (`--judge auto|jev|claude`; auto = Jev when
  configured in mcp.json, else Claude). Rationale: cross-family (removes
  self-preference bias), calibrated probabilities (rates = mean P(yes)),
  `jev_ask` batches all questions per output, `jev_triage` screens corpus files
  server-side. Positive framing, explicit thresholds. Report states the judge
  ("graded by Jev (external)"). ~10% of outputs cross-graded by Claude; the
  agreement rate discounts confidence. Fallback to Claude if Jev unavailable.
  Configuring Jev is the opt-in for sending redacted real turns to TypeSafe.

## Generality

Engine depends only on `ChangeOperator` and `AgentRunner`
(`run(env, episode) -> EpisodeTrace`). agent-afk is the first runner; a generic
OpenAI-messages runner (model + endpoint + system prompt + tools file) later.

## Runtime changes required (agent-afk)

1. Episode-mode gate + tool-call recorder (extends AFK-mode risk classifier,
   `src/agent/afk-mode-gate.ts`, `src/agent/default-hook-registry.ts`).
2. Prompt dump without calling the API (level 0 from the real code path).
3. Episode switches: MCP off, notifications off, recursion guard; new env vars
   registered in `ENV_REGISTRY`, env registry docs regenerated.
4. Shared preamble stripper extracted from `src/web-server/session-source.ts`.
5. `getWhatifDir()` in `src/paths.ts`.

## Delivery: 4 stacked PRs (one worktree)

1. **Runtime plumbing:** episode gate, dump-only, episode switches, stripper.
   Tests prove an episode leaves the real ~/.afk untouched and side effects are
   recorded not executed.
2. **Engine core:** ChangeSpec + operators (file, append, memory, model/runtime,
   env, skill/plugin toggles), sandbox materializer, level 0, level 1, NL
   compiler, `afk whatif` + `/whatif` (predict only).
3. **Verify:** episode sources, agent-afk runner, observation, stats, budget,
   report, calibration ledger, Jev/Claude judges. `--verify` in both surfaces.
4. **Docs + live validation** (capped ~$5): "always ask first" -> ask rate up;
   memory fact "prefers pnpm test:file" -> used more; disable `diagnose` ->
   its use on bug prompts to ~0; sonnet -> haiku reports a delta without
   crashing. All repo gates on each PR.

Later: agent-afk source changes as candidates (build worktree as runner),
generic runner, post-acceptance check against real sessions.

## Risks

- Sandbox leaking into real ~/.afk: copies not symlinks for writable paths,
  episode gate, test in PR 1.
- Plugin hooks with side effects (e.g. telegram on SessionEnd): disabled in
  episode mode.
- Cost / latency of subprocess episodes: preflight estimate, cap, `--quick`,
  concurrency 4.
- Episodes stop at the first side effect, so the report shows what the agent
  decides, not downstream consequences; stated in every report.
- Judge bias: mitigated by Jev (cross-family) + Claude cross-check.
- Real turns sent to external judge: redaction is regex best-effort; report
  states it; `--judge claude` keeps data on Anthropic.
- Preamble stripping is heuristic; synthetic probes hedge.
- Over-trust of guesses: every unverified prediction labeled "guess"; measured
  rates always shown with uncertainty.
- Weeks of scope: split into 4 PRs that each ship something usable.

## Alternatives considered

- Pure static prediction (one LLM call over a diff): rejected, near chance.
- Prompt-only snapshot diff + first-turn replay: rejected, blind to memory,
  hooks, skills, model, MCP; superseded by environment-level sandboxes.
- In-process REPL execution: rejected, process-global config leaks into live
  session.
- Full multi-step replay with stubbed tool results: deferred, stubs mislead
  downstream steps.
- Standing behavioral fingerprint from all sessions: deferred; useful later as
  post-acceptance verification.
- Wrapping promptfoo: rejected, no replay of real sessions and no plain-English
  diff.

## As built (deviations from the plan)

- Delivered as three PRs instead of four: two runtime bug fixes found during validation, runtime plumbing, then engine + surfaces + docs.
- Level 0 captures the exact wire request through a local capture server (`ANTHROPIC_BASE_URL` pointed at `src/whatif/runner/capture-server.ts`) instead of a new dump-only runtime mode, so no runtime change was needed for it.
- In the REPL, a plain-English change is compiled and shown; the run starts only when re-issued with `--yes` (slash commands have no synchronous confirm).
- `--from-git` and per-message hook regeneration remain deferred.
