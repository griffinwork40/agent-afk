---
name: orient
description: At end-of-session, dispatches a read-only sub-agent to survey recent work and drafts a vaguely-specific priming prompt the next session can paste to orient itself and plan its next sprint. Produces orientation, not prescription — candidate directions are framed as questions, not decisions.
context: load
---

## Sub-agent contract
/contract

Dispatch one read-only research sub-agent to survey recent work across four narrow targets, then produce a single markdown prompt block the user can paste into a fresh session.

**Sub-agent surveys:**
- Memory: the **`memory_search` tool** (2–3 keyword queries on the current work; FTS5 syntax) + hot memory at `~/.afk/state/memory/HOT.md`. Do **not** grep `~/.claude/projects/**/memory/` — that path is vestigial and empty on both trees; the archive is SQLite and only `memory_search` reaches it. Report which stores you consulted.
- Git activity in this repo + sibling repos the session touched (`git log --oneline -10`, open PRs, dirty state)
- `experiments/` docs (if present) relevant to the current work
- Telemetry/state files the session interacted with (e.g. `~/.afk/agent-framework/*.jsonl`)

**Return exactly this shape (≤ 60 lines total):**
1. One-line project identity + one-line "where we are" (current phase / latest milestone)
2. 3–5 bullets on what shipped recently — commits, PRs, empirical closures; be specific
3. Memory pointers by filename only (next session's memory system auto-loads — don't restate)
4. 2–4 **candidate directions** framed as questions or possibilities, **never** as a decided plan
5. Closing line inviting the next session to run `/ground-state` first, then propose a plan

**Discipline the contract enforces:** orientation, not execution. Handoff briefs drift toward prescription by default; the "questions-as-possibilities" framing is the guardrail so the receiving session plans with fresh judgment.

Relay the prompt to the user. On request, save to `/tmp/orient-<ISO8601>.md`.

**Skip when:** no substantive work to carry forward, user wants a bare `/compact`, or user already has a decided plan (use `/mint` or draft directly).
