# docs/ — Index

68 documents. One line each, grouped by concern.

---

## Core Reference

- [architecture.md](architecture.md) — Three-layer source structure (`src/`), module map, and key runtime concepts; start here for contributor orientation.
- [reference.md](reference.md) — Full env-var table, slash-command taxonomy, and plugin/marketplace deep-dive.
- [development.md](development.md) — Build, test, release mechanics, and codebase conventions for contributors.
- [env-registry.md](env-registry.md) — Generated registry of all 195 environment variables across 13 categories; do not edit by hand (`pnpm scan:env`).
- [philosophy/afk-contract.md](philosophy/afk-contract.md) — Foundational thesis: the agent must constrain execution and bear witness to it.
- [failure-geometry.md](failure-geometry.md) — Design pattern: name the default failure mode, choose a preferred one, add structure that transforms one into the other.
- [sdk-dependency.md](sdk-dependency.md) — Generated snapshot of SDK dependency versions (2026-09-23).

---

## Agent & Subagent Runtime

- [subagent-steering.md](subagent-steering.md) — Mid-run steering: how an external actor redirects a running subagent between tool-call boundaries.
- [subagent-tool-budget.md](subagent-tool-budget.md) — Reference for `budget-preamble.ts`: how a forked child's tool-round cap is disclosed to the child itself.
- [subagent-attachment-propagation.md](subagent-attachment-propagation.md) — Proposal (unimplemented): optionally attach a parent-session image to a dispatched subagent prompt.
- [skill-load-mode.md](skill-load-mode.md) — Three skill execution modes (`inline` / `fork` / `load`) and the 2026-06 load-by-default amendment.
- [signal-block.md](signal-block.md) — SIGNAL block convention (v0, passive-observation only): read-only infrastructure, not yet authoritative for routing.
- [model-slots.md](model-slots.md) — Four capability tiers (`local` / `small` / `medium` / `large`) and how they bind to concrete models.
- [provider-router.md](provider-router.md) — Per-model provider routing: how `ProviderRouter` selects a provider for any model across configured backends.
- [headless.md](headless.md) — `--format stream-json` headless output mode for CI pipelines and shell-script consumers.
- [mcp.md](mcp.md) — MCP (Model Context Protocol) integration: connecting to MCP servers and bridging their tools into a session.
- [bundled-plugins.md](bundled-plugins.md) — How `awa-bundled/` ships pinned-hash snapshots of bundled skills and how the integrity test works.
- [queued-message-flush-on-background.md](queued-message-flush-on-background.md) — Flushing a queued message into the parent turn on Ctrl+B; implemented in PR #891 via `ToolResult.harnessUserMessage`.

---

## Providers

- [anthropic-direct-loop.md](anthropic-direct-loop.md) — Reference for `anthropic-direct/loop.ts`: the per-turn agentic loop driving the Messages API and tool dispatcher.
- [anthropic-fast-mode.md](anthropic-fast-mode.md) — Session-scoped fast mode for eligible Anthropic Direct turns (`/fast on` / `/fast off`).
- [openai-responses-and-chatgpt-oauth.md](openai-responses-and-chatgpt-oauth.md) — Opt-in paths routing over the OpenAI Responses API instead of Chat Completions; ChatGPT-subscription OAuth.
- [xai-provider.md](xai-provider.md) — xAI / Grok provider: SuperGrok OAuth, dual inference endpoints, OpenAI-compatible wire path.
- [parity-agent-sdk.md](parity-agent-sdk.md) — Gap assessment: agent-afk vs. the Claude Agent SDK as of 2026-06-26, with gap-closing plan.

---

## TUI & Rendering

- [rendering-architecture-current.md](rendering-architecture-current.md) — **⚠ Superseded (2026-07-02).** Phase-0 snapshot of the renderer before five root-cause fixes landed; kept as historical record.
- [rendering-architecture-desired.md](rendering-architecture-desired.md) — **⚠ Superseded (2026-07-02).** Target model that motivated the five fixes; all have since shipped.
- [tui-invariants.md](tui-invariants.md) — Three externally-governed TUI invariant classes (VT spec, `log-update`, compositor lifecycle) and the comment shape each requires.
- [tui-resize-reflow.md](tui-resize-reflow.md) — Root causes, fix architecture, and industry context for resize/reflow bugs; companion to `scrollback.md` and `tui-invariants.md`.
- [tui-rhythm.md](tui-rhythm.md) — Rhythm contract: every emitted block owns exactly one trailing blank line.
- [scrollback.md](scrollback.md) — Mechanics of `TerminalCompositor.commitAbove()`: pushing lines into scrollback while keeping a live UI pinned at the bottom.
- [tmux.md](tmux.md) — tmux compatibility guide: recommended config, known quirks, and how tmux and the AFK REPL interact.
- [visual-redesign-proposal.md](visual-redesign-proposal.md) — Design proposal (2026-09-24, read-only): visual redesign of the subagent activity tree in the TUI.

---

## Browser Control

- [browser-control.md](browser-control.md) — Five native browser tools, one Playwright backend per AFK process, one `BrowserContext` per `AgentSession`.
- [browser-control-scope.md](browser-control-scope.md) — Scope document (no implementation): grounded file-reference survey of browser control as of 2026-05-28.
- [browser-real-chrome.md](browser-real-chrome.md) — `afk browser connect`: driving your real, logged-in Chrome profile via Chrome DevTools Protocol.

---

## Remote Control & Telegram

- [afk-remote-control.md](afk-remote-control.md) — Bidirectional Telegram handoff: implemented design record for iterations 1–4 of the remote-control feature.
- [afk-telegram-native-host.md](afk-telegram-native-host.md) — Architecture "D" feasibility + risk brief: running AFK natively inside the Telegram bot; v1 implemented, v2 deferred.

---

## Gates & CI

- [file-size-ceiling.md](file-size-ceiling.md) — 350 code-line ceiling: Phase 0 gate implemented; refactor waves not yet started; protocol for future waves.
- [publish-workflow.md](publish-workflow.md) — Publish workflow history and trust model: why the test suite is not re-run at publish time.
- [improve-eval-run.md](improve-eval-run.md) — `afk improve eval-run`: deterministic validation of eval cases without LLM, patch/apply, or git.
- [issue-silent-model-loop-debuggability.md](issue-silent-model-loop-debuggability.md) — Issue writeup: making silent model-loop failures (`stop_reason: refusal`, empty completions) debuggable without hand-instrumentation.

---

## Benchmarks

- [benchmarks/abort-cascade.md](benchmarks/abort-cascade.md) — Abort-cascade correctness benchmark (v1, 2026-09-17).
- [benchmarks/concurrent-emitter.md](benchmarks/concurrent-emitter.md) — Concurrent-emitter trace integrity benchmark (v1, 2026-09-17).
- [benchmarks/crash-to-resume.md](benchmarks/crash-to-resume.md) — Crash-to-resume DAG checkpoint correctness benchmark (v1, 2026-09-17).
- [benchmarks/hook-block-fidelity.md](benchmarks/hook-block-fidelity.md) — Hook-block fidelity benchmark (v1, 2026-09-17).
- [benchmarks/trace-completeness.md](benchmarks/trace-completeness.md) — Trace completeness under `kill -9` benchmark (v1, 2026-09-17).

---

## Audits

- [audits/failure-geometry-audit.md](audits/failure-geometry-audit.md) — Failure-geometry audit (2026-06-08, v3.89.7): runtime token budgeting, context handling, trace fidelity, control-plane enforcement.
- [audits/orchestration-pressure-audit.md](audits/orchestration-pressure-audit.md) — Orchestration pressure audit (2026-05-11): direct repo inspection + 3 parallel reconnaissance subagents.
- [audits/impact-map-agents-wrapper-layer.md](audits/impact-map-agents-wrapper-layer.md) — Pre-change blast-radius analysis for deleting the `src/skills/_agents/` TS-wrapper layer (ADR 0002 item 2).
- [audit-throughput-inflection-2026-09.md](audit-throughput-inflection-2026-09.md) — Throughput inflection audit (Sept 15–22, 2026): five parallel probes covering merge quality, issue backlog, PR substance, and waste.
- [audit-self-correction-loop-2026-09.md](audit-self-correction-loop-2026-09.md) — Self-correction loop integrity audit (Sept 15–22, 2026): did the correction loop tighten post-inflection?

---

## Architecture Decision Records (ADRs)

- [decisions/0001-bash-tool-path-containment.md](decisions/0001-bash-tool-path-containment.md) — **Accepted.** Bash tool path containment (C4); closes issue #354.
- [decisions/0002-readonly-agent-type-consolidation.md](decisions/0002-readonly-agent-type-consolidation.md) — **Partially accepted.** Collapse the two read-only agent types into one; headline proposal still pending maintainer decision.
- [decisions/0003-credibility-signals-no-download-counts.md](decisions/0003-credibility-signals-no-download-counts.md) — **Accepted.** Credibility signals: PR/test counts over npm download counts; closes issue #1282.
- [decisions/0004-workspace-persistence-wont-fix.md](decisions/0004-workspace-persistence-wont-fix.md) — **Won't-fix.** Cross-session workspace persistence; closes issue #1541.

---

## Specs

- [specs/day-4d-open-pr-handler.md](specs/day-4d-open-pr-handler.md) — Spec for Day 4d: open-PR handler for the speculative branch farm (replaces a stub).
- [specs/env-flag-registry.md](specs/env-flag-registry.md) — Spec: centralized env module + generated registry (refactor + feature).
- [specs/imported-plugin-enabled-state.md](specs/imported-plugin-enabled-state.md) — Spec: honor source enabled/disabled state for imported plugins (behavioral fix + config-shape change).
- [specs/phase-2-rendering-refactor.md](specs/phase-2-rendering-refactor.md) — Spec: Phase 2 rendering-subsystem refactor + 5 bug fixes; awaiting approval before implementation begins.
- [specs/provider-agnostic-wire-seam.md](specs/provider-agnostic-wire-seam.md) — Spec: provider-agnostic wire seam; Phases 2C–2D partially implemented.
- [specs/readline-keybindings-spec.md](specs/readline-keybindings-spec.md) — Spec: readline-style keybindings + multi-line ergonomics (`feat/readline-keybindings`).

---

## Proposals

- [proposals/first-class-worktree-isolation.md](proposals/first-class-worktree-isolation.md) — MVP implemented (2026-07-10): `isolation: "worktree"` for the `agent` tool; design + implementation scope record.
- [proposals/idle-turn-proposal.md](proposals/idle-turn-proposal.md) — Next-action suggestion at the idle prompt; Tier-3 "ghost" design rejected, superseded by the DECISION section approach.
- [proposals/subagent-prompt-capture.md](proposals/subagent-prompt-capture.md) — Capture parent→child subagent prompts; **design superseded in part by §8** (2026-08-01); capture seam and trace-event addition changed.
- [proposals/tui-compositor-rewrite.md](proposals/tui-compositor-rewrite.md) — Unify the compositor commit model to dissolve the scrollback-gap class; Stage 0 validated, Stage 2 core landed in #540.

---

## Dev Notes & Scoping Records

- [pr845-followup-scoping.md](pr845-followup-scoping.md) — Pure scoping document for PR #845 follow-up work; no implementation.
- [dev/grant-manager-divergence.md](dev/grant-manager-divergence.md) — Three-way divergence diff of grant-manager copies pre-consolidation (@ cd37ef1).
- [dev/real-terminal-matrix.md](dev/real-terminal-matrix.md) — Real-terminal validation matrix for compositor changes; human-in-the-loop gate required before any commit-path change lands.
- [windows-setup.md](windows-setup.md) — Running agent-afk on Windows: current status, known gaps, and workarounds.
