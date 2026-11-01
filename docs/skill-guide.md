# Skill Guide — Tiered Reference

A scannable reference for all available skills, categorized by general utility.
Use this to find the right skill for your task without reading every SKILL.md.

- **Tier 1 — Core workflow**: skills every user should know
- **Tier 2 — Power user**: valuable but situational
- **Tier 3 — Specialized**: agent-afk development, meta-orchestration, niche patterns
- **Tier 4 — Domain-specific**: non-coding domains (trading, real estate, content, CRM)

---

## Tier 1 — Core Workflow

Skills that cover the everyday development loop. Learn these first.

| Skill | Description | Example |
|-------|-------------|---------|
| `mint` | Takes a feature idea and delivers a ship-ready, verified implementation end-to-end (spec → research → build → verify → heal). | `/mint "add rate-limit middleware to the API"` |
| `ship` | Pushes local changes, runs tests, drafts a commit message, and opens a PR. | `/ship` or `/ship --verify` |
| `review` | Parallel multi-dimension code review (security, correctness, API compat, test coverage, perf) across a diff, PR, branch, or commit. | `/review 312` or `/review --staged` |
| `fix-pr` | Fetches unresolved reviewer feedback and red CI from a PR, fixes everything in an isolated worktree, and pushes. | `/fix-pr 286` |
| `diagnose` | Parallel root-cause analysis for bugs and failing tests — dispatches sub-agents to form and validate hypotheses. | `/diagnose "login returns 401 after token refresh"` |
| `heal` | Iterative repair for build/test failures — characterizes, fixes, re-verifies, up to 3 rounds before escalating. | `/heal "TypeError: Cannot read properties of undefined"` |
| `research` | Dispatches two sub-agents in parallel to gather external and local context for the current task. | `/research` (invoked inline before starting a task) |
| `spec` | Transforms a loose idea into a structured, actionable spec ready for implementation. | `/spec "user notification preferences page"` |
| `ground-state` | Pre-flight reconnaissance pass — triangulates git state, project structure, and prior-session memory before any edit. | `/ground-state` (at the start of a session) |
| `onboard` | Orients any session to an unfamiliar repo via parallel research across architecture, ownership/debt, and test/CI posture. | `/onboard` (first thing in a new codebase) |
| `refactor` | Safe large-scale structural changes — enumerates sites, groups by dependency layer, applies in parallel with test gates. | `/refactor "rename UserService → AccountService"` |
| `simplify` | Discovers complexity, duplication, and dead code; produces a ranked behavior-preserving reduction plan. | `/simplify src/utils` |
| `shadow-verify` | Adversarial parallel re-derivation of key claims after any high-stakes sub-agent finding. | `/shadow-verify` (after a security audit result) |

---

## Tier 2 — Power User

Situationally valuable skills that unlock significant leverage once you know when to reach for them.

### PR & Issue Management

| Skill | Description |
|-------|-------------|
| `land` | Takes one PR all the way to merged: review → fix CI/feedback → re-review → merge → file follow-up issues. |
| `pr-triage` | Batch-reviews open PRs in parallel, triages into merge/fix/follow-up buckets, executes with human gates. |
| `tackle-issues` | Tackles N GitHub issues in parallel via worktree-isolated subagents, producing one PR per issue. |
| `resolve` | Resolves PR code review feedback. Use when asked to fix/address review comments. |
| `split` | Decomposes a mixed-risk PR into "ship now / track later" — scoped diff + GitHub tracking issue. |

### Debugging & Quality

| Skill | Description |
|-------|-------------|
| `deflake` | Statistical reproduction and acceptance gate for flaky/intermittent tests. Wraps `/diagnose`. |
| `validate-first` | Gates any bug fix behind mandatory reproduction — read-only subagent confirms failures before writes. |
| `diagnose-first` | For open-ended diagnostic questions ("do we need to improve latency?") — discovery first, then fix. |
| `tighten` | Wraps generated artifacts in a bounded execute → observe → correct loop using real signals, not self-critique. |
| `bypass-trace` | Diagnoses structural bypass bugs where a component exists but is never reached. |
| `threshold-driven` | Enforces measurable correctness thresholds (coverage %, LOC limits, latency, fidelity) with TDD-style gates. |

### Planning & Architecture

| Skill | Description |
|-------|-------------|
| `god` | Full-lifecycle meta-orchestrator: classifies a plain-English task into one of 12 shapes and chains the right skills. |
| `gather-first` | Dispatches a bounded research phase before any implementation — gates on explicit approval before writing. |
| `fork-then-build` | Parallel investigation phase before any writes on open-ended features — eliminates mid-build pivots. |
| `arch-fork-resolve` | Forces an explicit architectural decision when a goal is ambiguous between quick-win and scalable infra. |
| `plan-probe` | At the plan-to-implementation boundary, emits a blast-radius manifest and gates on resolved assumptions. |
| `pre-write-probe` | Runs prior-art and internal-contract probes before any file is touched; blocks on COLLISION-DETECTED. |
| `spec-collapse` | Collapses a complex spec to its minimum-viable model-native form. |

### Audit & Verification

| Skill | Description |
|-------|-------------|
| `repo-audit` | One-dispatch repo health audit: deps, security advisories, test coverage gaps, dead code, config drift. |
| `audit-verify` | Multi-phase security/correctness audit with runtime-probe verification before severity is reported. |
| `per-file-audit` | Audits every file in a glob against a ruleset, proving no files were skipped. |
| `consumer-map` | Read-only consumer graph and blast-radius analysis for a diff, symbol, module, or config key. |
| `design` | Research-backed UX judgment loop — renders a URL, captures evidence, emits a falsifiable UX Decision Brief. |
| `unattended-agent-audit` | Audits an agent system's readiness for unattended operation across 7 failure-mode dimensions. |

### Session & Context Management

| Skill | Description |
|-------|-------------|
| `session-handoff` | Structured cross-session context transfer — distills a 5-field HANDOFF.md for long-horizon tasks. |
| `checkpoint` | Serializes in-progress work state into a resumable snapshot; re-grounds on resume with a drift check. |
| `whats-next` | Reconstructs working context from git/GitHub/state-store and emits a ranked work queue. |
| `orient` | End-of-session survey that drafts a priming prompt for the next session. |
| `weekly-reflect` | Friday retrospective — surveys work this week and the broader project arc. |
| `recover` | Triages failed or stalled multi-step agent tasks by failure class, re-enters at the correct checkpoint. |
| `resume-subagent` | Rebuilds a killed subagent's progress from witness trace + git state, re-dispatches with remaining work only. |

### Parallel Orchestration

| Skill | Description |
|-------|-------------|
| `parallelize` | Transforms an existing plan into a parallel sub-agent wave orchestration. |
| `fan-in` | Combines K sibling worktree branches into one verified local integration branch with conflict/semantic checks. |
| `fanout-pace` | Rate-limit-aware pacing for wide parallel fan-outs — prevents 429s from killing workers. |
| `recon-dispatch` | Two-wave protocol: shared coordinator recon first, then all subagent lanes dispatched with shared starting points. |
| `verdict-forge` | Arbitrates conflicting evidence from N parallel sub-agents into a RESOLVED/PARTIAL/DEADLOCK verdict. |

### Maintenance & Cleanup

| Skill | Description |
|-------|-------------|
| `maintenance-plan` | Collapses vague maintenance requests into a risk-scored decision artifact (deps/tests/docs). |
| `stale-sweep` | Enumerates stale worktrees, branches, schedules, cache, jobs — classifies and cleans with an auth gate. |
| `project-scaffold` | Bootstraps a long-horizon project with durable resumption scaffolding (feature list, progress file, git baseline). |
| `auto-maintain` | Detects fully-automatable maintenance workflows from recent session telemetry. |

### Iteration & Refinement

| Skill | Description |
|-------|-------------|
| `polish` | Iteratively refines any artifact via a decoupled evaluator → generator loop until criteria are met. |
| `iterate` | Structured evaluator-optimizer loop — scores against a rubric, revises, repeats to cap. |
| `compete` | Dispatches two independent implementations with different seeds, scores both, commits only the winner. |
| `devils-advocate` | Adversarially critiques a proposal via 3 parallel critics (pragmatist, paranoid, architect), ranks alternatives. |

### Integration & Tooling

| Skill | Description |
|-------|-------------|
| `integrate` | One-prompt API integration pipeline — produces a working CLI wrapper + skill + tests. |
| `automate` | Sets up a scheduled headless afk run that pushes a summary to Telegram. |
| `service-setup` | Installs an AFK background process as an OS-supervised service (launchd / systemd). |
| `telegram-setup` | Guides first-time Telegram bot onboarding without leaking the token. |
| `get-started` | Guided first-run onboarding: preflight check, capability setup, migration from Claude Code/Codex. |
| `nextjs-afk-sdk` | Transforms an existing Next.js 14+ (App Router) project into an agent-native application. |
| `agentify` | Bootstraps a dispatchable sub-agent skill for every coding agent CLI installed on the machine. |
| `appmap` | Maps a web UI and generates a Claude automation skill via parallel recon + validation. |
| `provideme` | One-prompt provider bridge — produces a local API server compatible with Claude Code for any agent CLI. |
| `web` | Orchestrates parallel browser automation across independent Chrome tabs. Experimental. |
| `q` | CLI wrapper for Q, the durable job ledger that records all agent work. |
| `q-recall` | Searches the Q ledger for past agent work by keyword, SHA, PR URL, or path. |

---

## Tier 3 — Specialized

Niche or meta-level skills. Useful in specific agent-development, process-integrity, or creative contexts.

### Agent Quality & Safety Gates

| Skill | Description |
|-------|-------------|
| `false-completion-gate` | Catches silent success — verifies every "done" claim against tool-call receipts and fresh read-backs. |
| `ground-then-act` | Wave-gated grounding orchestrator that blocks session close until every committed action is materialized. |
| `dead-reckoning` | Mid-run audit for quiet sunk-cost tunneling — emits VIABLE/STALLED/DEAD-END before budget exhaustion. |
| `trajectory-check` | Mid-task drift detector — classifies On Track / Drifted / Wrong Path with minimum corrective action. |
| `pivot-gate` | Rescues doom-loops: declares trajectory dead, generates ≥3 divergent alternatives, probes for signal. |
| `side-effect-plan` | Classifies actions by reversibility, sequences them with a numbered undo stack, gates irreversibles. |
| `safe-dispatch` | Dry-run-first wrapper for irreversible external actions — discovers, dry-runs, gates, then live-dispatches. |
| `gate-aware-dispatch` | Dispatches approval-gated skills aware of interactive vs. non-interactive context; routes gates to Telegram. |
| `pipeline-gate-guard` | Scans a skill's SKILL.md for interactive gates before delegating to a subagent — prevents silent hangs. |
| `right-size-delegation` | Sizes sub-agent dispatches to fit budget: trivial inline, focused with caps, wide work as a compose DAG. |
| `preflight-resolve` | Resolves coordinator uncertainties via a single cheap preflight subagent before fanning out. |
| `result-triage` | Classifies a subagent result as act / spot-check / full-verify / reject-and-rerun before downstream work. |
| `premise-gate` | Cross-checks named-entity + status-claim pairs in a user request before acting. |
| `state-correction-gate` | Detects when a session's first prompt corrects a prior state error; gates all dispatch on clean-state audit. |
| `self-repair-guard` | Quarantine-aware repair for artifacts that are part of the agent's own dispatch chain. |
| `long-bash-gate` | Wraps long-running bash calls with monitor signatures to prevent silent success/hang antipattern. |
| `read-before-explain` | Forces file reads before explanation — emits GROUNDED/UNVERIFIED per claim. |
| `source-check` | Intercepts zero-read explanation sessions with a parallel spot-check verifier wave. |
| `synthesis-mode` | Classifies a session as text-terminal and restructures orchestration to skip write-gate scaffolding. |

### Parallel Coordination Patterns

| Skill | Description |
|-------|-------------|
| `recon-first` | Three-phase recon pipeline before a fix subagent: find analogous sites, select exemplar, dispatch with it locked in. |
| `recon-gate` | Read-before-write pipeline for stateful systems (DBs, config stores, pipelines) — snapshot then mutate. |
| `snapshot-before-edit` | Materializes a content snapshot before multi-file edits; dispatches agents that read only the snapshot. |
| `snapshot-guard` | Brackets external-source workflows with SHA pinning at T₀/T₁ to catch stale-data reasoning. |
| `audit-dispatch` | Dispatches parallel read-only audit sub-agents with mutation-compliance verification after the fact. |
| `gather` | Parallel context-gathering for a code area — structure + test coverage in one wave. |
| `ground-claim` | Grounds capability claims with file-read evidence; traces runtime wiring paths for CONFIRMED/REFUTED verdicts. |

### Analysis & Introspection

| Skill | Description |
|-------|-------------|
| `scope-drift-audit` | Detects goal-scope drift in closed sessions (research → commit without consent). |
| `scope-debt-collector` | Recovers unrecorded scope-split decisions from session history; writes memory records and issue stubs. |
| `omission-audit` | After high-volume sessions, surfaces things that were never attempted. |
| `fragility-audit` | Retrospectively audits successful sessions for structural fragility masked by outcome success. |
| `error-locality` | Diagnoses whether errors clustered in the orchestration layer while object-layer tools ran clean. |
| `uncertainty-audit` | Audits a session for late-surfaced uncertainty — classifies terminal artifacts and stopping criteria. |
| `pivot-closure` | Audits mid-session goal pivots — verifies original question was answered and pivot deliverable is complete. |
| `basis-calibrate` | Re-annotates a code-review findings report with per-claim calibrated confidence values. |
| `user-vs-hygiene` | Splits a flat review-findings list into user-visible behavioral vs. internal hygiene axes. |
| `drift-lock` | Guards iterative spec drift in high-feedback-coupling tasks by freezing scope.lock and checking at each boundary. |
| `diff-snapshot-audit` | Pins a PR diff at a specific SHA, runs two auditors against the snapshot — catches port divergence. |

### Skill Authoring & Plugin Development

| Skill | Description |
|-------|-------------|
| `forge` | Autonomously generates new amplifier skills gated by forge-gate-check, with qualify iteration loop ≤3×. |
| `forge-gate-check` | Reports whether /forge is thawed; runs L1 eval harness and logs to ceiling ledger. |
| `forge-l2-eval` | Runs L2 capability-gate evaluations — live sub-agent invocations probing qualify contract discrimination. |
| `forge-friction` | Surfaces recurring friction from session telemetry, generates skills for shape-gap themes only. |
| `coverage-forge` | Checks whether a proposed skill already exists before forging — returns NOVEL/THIN/COVERED verdict. |
| `distill` | Advances harvested pattern cards through lifecycle (charged → validated) and emits skill briefs for /forge. |
| `harvest` | Extracts candidate deep patterns from a completed session's facet and qualifies them into Pattern Cards. |
| `audit-fit` | Audits ~/.afk artifacts for correct type categorization (skill vs hook vs config vs doc). |
| `shape-ruling` | Classifies a vague goal into the correct artifact form (skill/hook/config/doc/none). |
| `name-check` | Audits a skill name before creation — ensures an agent reading only the name infers the skill's purpose. |
| `embody` | Translates a structural insight into a named mechanism + decision rule + ≥3 embodiments + falsifier. |

### Architecture Decisions

| Skill | Description |
|-------|-------------|
| `arch-swap-probe` | Validates an architectural swap candidate via an isolated feasibility probe; persists verdict to memory. |
| `novelty-check` | Surfaces divergence risk before implementation — compares proposed feature to named prior art. |
| `fork-wiring-audit` | Audits every subagent fork site to verify a config parameter is explicitly wired, not assumed ambient. |
| `gate-liveness-audit` | Enumerates every config-driven safety gate in a repo and verifies each is LIVE/DARK/UNREACHABLE. |
| `ghost-terminal-audit` | Detects branches in a scheduler that write no state record on completion (ghost terminal anti-pattern). |
| `ledger-completeness` | Audits a dispatch function for terminal-state completeness via per-exit-site probes. |

### Creative & Content Patterns

| Skill | Description |
|-------|-------------|
| `brief-to-primitives` | Translates an abstract conceptual brief into 5–8 medium-native generative directives. |
| `axis-lock` | Decomposes a "like X but novel" brief into a locked variation axis before any build wave. |
| `site-recon` | Three-wave visual recon before site generation — screenshots, antipattern inventory, differentiation gate. |
| `perceptual-gate` | Prevents structural evaluation from substituting for perceptual evaluation in creative/aesthetic sessions. |
| `surface-audit` | Diagnoses product misclassification — maps public-facing surfaces and scores candidate rewrites. |
| `voice-match` | Fetches recent posts from a target platform, extracts style markers, conditions drafts on them. |
| `explain` | Parallel breadth + depth wave for architecture explanations — synthesizes without validation-gate overhead. |
| `read-before-explain` | Forces file reads before explaining code; emits GROUNDED/UNVERIFIED per claim. |

### Miscellaneous Meta

| Skill | Description |
|-------|-------------|
| `signal-to-delivery` | Converts a minimal approval signal ("sure", "👍") into branch push + draft PR + review comment. |
| `split-investigation` | Separates correctness fixes from research findings in a dirty tree — fix PR + research issue as separate artifacts. |
| `target-lock` | Resolves colloquial refactor targets ("the old auth plugin") to confirmed file paths before any edit. |
| `artifact-durability-gate` | Tracks and persists high-value in-context artifacts throughout a session via periodic manifest pulses. |
| `director-retrieve` | Retrieves examples of prior directing decisions for constraint engineering. |
| `scale-sweep` | Tests whether an equivalence claim holds as a scale axis grows — multi-breakpoint RESULTS matrix. |
| `peer-gap-research` | Scrapes a peer tool's docs, discovers capability gaps, classifies each as Clone/Diverge/Skip. |
| `ceiling-test` | Experimental ARC-AGI-2 solver — 20 parallel hypothesis agents + Python verifier. Not a general amplifier. |
| `contract` | Reference convention for sub-agent I/O schemas. Loaded by orchestrator skills. |
| `afk-port` | Ports PRs/issues between the private afk-workshop repo and the public agent-afk repo. Maintainer-only. |
| `afk-release` | Cuts a manual agent-afk npm release end-to-end (preflight → bump → CHANGELOG → publish → verify). |

---

## Tier 4 — Domain-Specific

Skills tied to non-agent-dev domains. Require domain-specific setup or credentials.

| Skill | Domain | Description |
|-------|--------|-------------|
| `rsi-trading` | Finance / options | Wheel options strategy with Bayesian parameter optimization — RSI oversold + EMA + HV signals. |
| `comp-shop` | Real estate | Apartment market survey — discovers communities, gathers floor plans/rents, renders HTML comparison page. |
| `tailor-resume` | Career | Tailors a resume to a specific job listing from a verified candidate profile. No fabrication. |
| `substack` | Publishing | CLI wrapper for Substack's API — read/write posts, notes, comments, subscribers, analytics. |
| `hunter-io` | Sales / lead-gen | Hunter.io API wrapper — domain-search, email-finder, email-verifier for cold outbound enrichment. |
| `cm-repurpose` | Publishing | Turns a Capital Mischief essay into a review-queue of grounded Substack Notes. |
| `vertical-pivot` | Sales / BD | Repositions a general capability for a regulated vertical — compliance probes + pitch synthesis. |
| `nextjs-afk-sdk` | Web dev | Transforms a Next.js 14+ project into an agent-native app with MCP servers, skills, SSE, chat UI. |
| `contacts` | CRM | Undocumented (empty SKILL.md description). |
| `hubspot` | CRM | Undocumented (empty SKILL.md description). |
| `ga` | Analytics | Undocumented (empty SKILL.md description). |

---

## Quick-Find Index

**"I have a bug"** → `/diagnose` → `/heal` → `/deflake` (if flaky)

**"I want to build a feature"** → `/spec` → `/mint` → `/ship`

**"I need to review a PR"** → `/review <PR>` → `/fix-pr <PR>` → `/land <PR>`

**"I'm in a new codebase"** → `/onboard` → `/ground-state`

**"My agent is stuck/looping"** → `/dead-reckoning` → `/pivot-gate` → `/recover`

**"I want to parallelize work"** → `/parallelize` → `/fanout-pace` → `/fan-in`

**"I want a refactor"** → `/target-lock` → `/refactor` → `/simplify`

**"I want to automate a recurring task"** → `/automate`

**"I want to build a skill"** → `/coverage-forge` → `/forge` → `/harvest` → `/distill`

**"I need to hand off / pause"** → `/checkpoint` → `/session-handoff` → `/orient`
