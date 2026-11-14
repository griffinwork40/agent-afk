# Skill Guide

A scannable reference for every skill that ships with agent-afk.

Skills are slash commands (`/mint`, `/ship`, `/diagnose`) that orchestrate multi-step
agent workflows. They compose sub-agents, enforce verification gates, and produce
durable artifacts. This guide covers the skills included in the npm package. The
skill system is extensible via plugins; see [Extending with plugins](#extending-with-plugins).

- **Tier 1 — Core workflow**: the everyday development loop
- **Tier 2 — Power user**: situationally valuable, significant leverage when you need them
- **Tier 3 — Setup & reference**: one-time configuration and skill-authoring utilities

---

## Tier 1 — Core Workflow

Skills that cover the everyday development loop. Learn these first.

| Skill | What it does | Example |
|-------|-------------|---------|
| `mint` | Takes a feature idea and delivers a ship-ready, verified implementation end-to-end (spec → research → build → verify). | `/mint "add rate-limit middleware"` |
| `ship` | Pushes local changes, runs tests, drafts a commit message, and opens a PR. | `/ship` or `/ship --verify` |
| `review` | Parallel multi-dimension code review (security, correctness, API compat, test coverage, perf) across a diff, PR, branch, or commit. | `/review 312` or `/review --staged` |
| `fix-pr` | Fetches unresolved reviewer feedback and red CI from a PR, fixes everything in an isolated worktree, and pushes. | `/fix-pr 286` |
| `diagnose` | Parallel root-cause analysis for bugs and failing tests — dispatches sub-agents to form and validate hypotheses. | `/diagnose "login returns 401 after refresh"` |
| `research` | Dispatches two sub-agents in parallel to gather external and local context for the current task. | `/research` |
| `spec` | Transforms a loose idea into a structured, actionable spec ready for implementation. | `/spec "notification preferences page"` |
| `ground-state` | Pre-flight reconnaissance — triangulates git state, project structure, and prior-session memory before any edit. | `/ground-state` |
| `refactor` | Safe large-scale structural changes — enumerates sites, groups by dependency layer, applies in parallel with test gates. | `/refactor "rename UserService → AccountService"` |
| `simplify` | Discovers complexity, duplication, and dead code; produces a ranked behavior-preserving reduction plan. | `/simplify src/utils` |

---

## Tier 2 — Power User

Situationally valuable skills that unlock significant leverage once you know when to reach for them.

### Verification & Quality

| Skill | What it does |
|-------|-------------|
| `shadow-verify` | Adversarial parallel re-derivation of key claims after any high-stakes sub-agent finding. Use before acting on audit results, security reviews, or large refactor recommendations. |
| `devils-advocate` | Critiques a proposal via 3 parallel critics (pragmatist, paranoid, architect), each inventing an alternative approach, then ranks all options. |
| `false-completion-gate` | Catches silent success — verifies every "done" claim against tool-call receipts and a fresh read-back of the named artifact. |
| `ground-claim` | Grounds capability claims with file-read evidence. Pass `mode: runtime-wiring` to trace actual call sites and get CONFIRMED/REFUTED verdicts. |

### Context & Orchestration

| Skill | What it does |
|-------|-------------|
| `gather` | Parallel context-gathering for a code area — maps structure and test coverage in one wave. Use when you need to understand a module before editing. |
| `consumer-map` | Read-only consumer graph and blast-radius analysis for a diff, symbol, module, or config key. Emits a scored Impact Report with a PROCEED/NARROW_SCOPE/HUMAN_GATE verdict. |
| `parallelize` | Transforms an existing plan into a parallel sub-agent wave orchestration. |
| `orient` | End-of-session survey that drafts a priming prompt for the next session to orient itself. |
| `polish` | Iteratively refines any artifact (prose, spec, prompt, code) via a decoupled evaluator → generator loop until criteria are met or cap is reached. |
| `automate` | Sets up a scheduled headless afk run that pushes a summary to Telegram. Requires Telegram and daemon configured first (run `/telegram-setup` and `/service-setup`). |

---

## Tier 3 — Setup & Reference

One-time configuration and skill-authoring utilities.

| Skill | What it does |
|-------|-------------|
| `get-started` | Guided first-run onboarding: preflight check, capability setup (Exa, Telegram, service), migration from Claude Code/Codex. |
| `service-setup` | Installs an AFK background process (telegram bot or daemon) as an OS-supervised service — launchd on macOS, systemd on Linux. |
| `telegram-setup` | Guides first-time Telegram bot onboarding without leaking the bearer token. |
| `audit-fit` | Audits `~/.afk` artifacts (skills, commands, agents, hooks) for correct type categorization. |
| `contract` | Reference convention for sub-agent I/O schemas. Loaded by orchestrator skills, not invoked directly. |

---

## Quick-Find Index

**"I have a bug"** → `/diagnose` → if flaky, describe the pattern for deeper analysis

**"I want to build a feature"** → `/spec` → `/mint` → `/ship`

**"I need to review a PR"** → `/review <PR>` → `/fix-pr <PR>` (if feedback needs fixing)

**"I want a refactor"** → `/refactor` → `/simplify`

**"Verify a sub-agent's findings"** → `/shadow-verify`

**"I want to automate a recurring task"** → `/automate`

**"First time using AFK"** → `/get-started`

---

## Extending with Plugins

The skills above ship with the `agent-afk` npm package. The skill surface is
extensible — plugins can add new skills, agent types, and hooks.

```bash
# Install a plugin
afk plugin install <name>

# List installed plugins and their skills
afk plugin list
```

Plugin-contributed skills appear in your session's skill list alongside the
bundled ones. Run `afk plugin list` to see what each installed plugin provides.
