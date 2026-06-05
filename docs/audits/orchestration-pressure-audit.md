# Agent AFK — Orchestration Pressure Audit

**Date:** 2026-05-11
**Audited revision:** working tree (HEAD)
**Method:** Direct repo inspection + 3 parallel reconnaissance subagents (skills, runtime, prompt-stack). Same orchestration shape this audit is judging.
**Status:** Diagnosis + proposals. No prompt or code changes were made.

---

## A. Executive diagnosis

Agent AFK has a **complete and competent orchestration substrate** but **insufficient orchestration pressure** in the main session's prompt stack. The mechanical capabilities (subagent fork, nesting to depth 3, credential propagation, abort graph, structured output schemas, parallel wave runner) all exist and are correctly wired. Several built-in skills (`/diagnose`, `/audit-fit`) and bundled plugin skills (`/review`, `/ground-state`) demonstrate the intended pattern correctly.

The main session does not default to delegation because:

1. **Prompt policy gap (primary).** The system prompt frames the main session as a *single-agent operating loop* (Observe→Model→Choose→Act→Update). The word "orchestrator" / "coordinator" never appears. The Delegation section is 5 bullets buried between Constraints and Priorities. There is no decision rule for *when* to delegate, no anti-pattern list for inline investigation, and no framing of subagents as a context-preservation tool.
2. **Tool description gap (secondary).** The `agent` tool's description (`schemas.ts:184-189`) is generic: "Use for tasks that benefit from isolated context (research, parallel work, specialized focus)." It does not enumerate task classes (audit, debug, verify, multi-file search, hypothesis test, PR review). It does not mention nesting, parallel waves, or context preservation. It looks like an optional utility, not a primary primitive.
3. **Skill manifest framing gap (secondary).** Skills are listed as "Available skills (invoke via the `skill` tool)" — a capability menu. Their `whenToUse` fields mention subagents *incidentally*. The manifest has no header layer saying "invoking a skill is context-preserving — it dispatches subagents you don't have to host."
4. **Telemetry absence (tertiary).** The only orchestration event emitted is `subagent.dispatched` at spawn time (`routing-telemetry.ts:13`). No completion, failure, nesting-depth, skip, fallback, or context-size events. We cannot answer "did delegation help" from data — only from intuition.
5. **Silent fallback at the runtime edge.** When a subagent fails or schema-validates badly, the executor strips structure and returns a string error (`subagent-executor.ts:184-195`). The parent model loses `status`, `schemaError`, and `partialOutput`. Skill-tool depth-limit rejections emit no telemetry at all (`skill-executor.ts:81-86`).
6. **Compression absence.** No code path summarizes child output before returning to parent. `result.message.content` flows back verbatim (`subagent-executor.ts:184-187`). Several skill orchestrators (`/mint`, `/forge`) chain full prior-phase outputs into the next phase prompt without compression.

**The problem is primarily prompt policy and tool description.** Runtime is mostly correct; telemetry needs a small additive lift; fallback visibility needs a small structural fix.

The fix order should be: (1) main system prompt patch → (2) `agent` tool description rewrite → (3) skill manifest framing header → (4) minimal additive telemetry → (5) surfacing structured subagent failures upward.

---

## B. Evidence table

| # | Finding | Location | Observed | Why it weakens orchestration | Recommended fix | Confidence |
|---|---|---|---|---|---|---|
| 1 | Main system prompt frames inline single-agent loop | `prompts/system-prompt.md:50-60` | Operating loop says "Read what is new… changed files… refresh it first" — all language presumes inline tool use | The default behavior the loop describes is reading files in main context, not dispatching. No branch for "delegate this observation wave." | Add "Coordinator default" section + delegation triggers (see §E.1) | High |
| 2 | Delegation section is 5 generic bullets | `prompts/system-prompt.md:85-93` | Tells the model *how* to dispatch ("assume zero context, include objective") but never *when* | The decision is left implicit. Without triggers, the cheapest action is inline. | Replace with a decision rule + task-class list (see §E.1) | High |
| 3 | Word "coordinator" / "synthesizer" / "orchestrator" never appears in prompt stack | grep across `prompts/`, `src/agent/tools/system-prompt.ts`, `CLAUDE.md`, `AGENTS.md` | Absent | Main session does not know its role is to coordinate. The only adjacent phrase is "Keep synthesis and final judgment local" — a constraint, not a role declaration. | Declare the role explicitly in §E.1 | High |
| 4 | `agent` tool description is vague and optional-sounding | `src/agent/tools/schemas.ts:184-189` | "Dispatch a subtask to an independent agent session… Use for tasks that benefit from isolated context (research, parallel work, specialized focus)." | Frames as one option among many. No task-class enumeration. No mention of nesting, waves, or context cost. | Rewrite to enumerate triggers + costs (see §E.2) | High |
| 5 | Skill manifest is a capability list, no orchestration framing | `src/agent/tools/skill-bridge.ts:43-58` | Header is `Available skills (invoke via the \`skill\` tool):` | The model reads a flat menu. There is no signal that skills are context-isolated dispatches vs. inline helpers. | Add manifest header explaining that skills dispatch subagents (see §E.3) | High |
| 6 | Routing directive routes only to 4 named skills | `src/agent/routing-directive.ts:14-19` | Routes mint/diagnose/shadow-verify/parallelize | All other delegation-shaped skills (gather, research, review, ground-state) are absent from the routing layer | Expand routing directive with shape-based triggers (see §E.3) | High |
| 7 | TOOL_SYSTEM_PROMPT contains no delegation guidance | `src/agent/tools/system-prompt.ts:10-23` | Filesystem-and-shell conventions only | This is the first segment the model sees. Sets the tone as "you are the worker with these tools." | Add 2-3 lines about subagent primitives (see §E.4) | High |
| 8 | `agent` tool not exposed when no SubagentExecutor configured | `src/agent/providers/anthropic-direct/index.ts:100-102` | `if (opts.subagentExecutor) schemas.push(agentTool)` | Correct gating, but the model cannot know whether `agent` will be available in any given context. Some skill-internal sessions get it, some don't. | (no fix needed — document only) | High |
| 9 | Subagent failures stripped to plain string | `src/agent/tools/subagent-executor.ts:190-195` | `errorMessage = result.error?.message ?? ...` returned as `{content, isError:true}` | Parent loses `status`, `schemaError`, `partialOutput`, `id`. Cannot distinguish "schema mismatch on partially-useful output" from "completely failed". | Return structured JSON in `content` for `isError:true` cases (see §F) | Medium |
| 10 | Skill-tool depth-limit rejection emits no telemetry | `src/agent/tools/skill-executor.ts:81-86` | `if (depth >= maxDepth) return { content: '... not available at nesting depth N', isError: true }` | Silent skip. No JSONL event. We cannot count nested-attempt overflow. | Add `delegation_skipped` event (see §G) | High |
| 11 | Only `subagent.dispatched` is logged | `src/agent/routing-telemetry.ts:13-22` and `subagent.ts:239-244` | One spawn event; no completion, failure, schema-error, or skip events | We cannot tell *outcome* of delegation. Cannot compute success rate, cost-per-finding, or silent-fallback rate. | Add 4 minimal additive events (see §G) | High |
| 12 | No compression boundary in `subagent-executor` | `src/agent/tools/subagent-executor.ts:184-187` | `return { content: result.message.content }` — verbatim final assistant message | A subagent that reads 20 files inline and replies in 4000 tokens pollutes the parent's context with all 4000 tokens. The point of isolation is partly lost. | Document required compression contract in subagent system prompt (see §E.5); enforce via output schema where possible | Medium |
| 13 | `/mint` chains full prior-phase outputs forward without compression | `src/skills/mint/_phases/ship.ts:36-41`, `heal.ts:100-104` | Full spec + plan + buildResults + verifyResults inlined into next prompt | Inside-skill context bloat; this is the orchestrator polluting its own children. | Add compression step or summary contract between phases (later, not now) | Medium |
| 14 | `/forge` reworks inline the full skill body across up to 3 iterations | — | Full skill body re-templated per iteration | Quadratic-ish context cost on rework loop | Same as above — later | Medium |
| 15 | `/diagnose` injects research findings verbatim into hypothesis prompts | `src/skills/diagnose/index.ts:328-329` | `JSON.stringify(researchFindings.codebase, null, 2)` | High-quality skill, but the wave-2 hypothesis prompt is fat. No compression between wave 1 and wave 2. | Acceptable; flag for later optimization | Low |
| 16 | Routing-banner declared but does not cover delegation shape | `src/agent/routing-directive.ts:12-26` | Lists 4 skills + 2 composed sequences | Useful but narrow. Says nothing about when to fire raw `agent` calls vs. skills. | Add "raw agent fork" section (see §E.3) | High |
| 17 | Children inherit `apiKey` correctly but lose user-system prompt | `src/agent/subagent.ts:200-212`, `src/agent/tools/subagent-executor.ts:128-132` | Child config copies `apiKey` and `systemPrompt` from parent's defaultConfig | `defaultConfig.systemPrompt` is the parent's user-system. The child gets it; but the child also gets `TOOL_SYSTEM_PROMPT` + manifest fresh via the provider. Nesting is structurally sound. | (no fix — documenting that nesting is reliable) | High |
| 18 | Wave runner is library-only, never called from runtime | `src/agent/subagent/wave.ts` is only invoked from `src/skills/diagnose/index.ts:294` and `src/skills/audit-fit/index.ts:386` | Skills know to wave; the model does not | Main session has no exposed "fire N agents in parallel" primitive — must call `agent` N times in one tool-use block, which works but is undocumented | Document the pattern in `agent` tool description (see §E.2) | High |
| 19 | Skill `whenToUse` fields are the only place "parallel" appears | grep across all skill descriptions | gather/research/diagnose/shadow-verify mention parallel; others don't | The orchestration concept lives in skill-author voice, not in the main prompt | Lift to top-level (see §E.1) | High |
| 20 | Children allowed to fork further but max depth = 3 hardcoded | `src/agent/tools/nesting.ts:19` | `DEFAULT_MAX_NESTING_DEPTH = 3` | Sane default. Not overrideable per-task. Probably fine. | Keep | High |

---

## C. Current orchestration map

```
┌─────────────────────────────────────────────────────────────────────┐
│ Main Session (AnthropicDirectProvider session)                      │
│                                                                     │
│  System prompt (assembled in anthropic-direct/index.ts:158-163):    │
│    1. TOOL_SYSTEM_PROMPT  (tools/system-prompt.ts)                  │
│    2. # Environment cwd                                             │
│    3. Skill manifest      (tools/skill-bridge.ts)                   │
│    4. User system prompt  (prompts/system-prompt.md + optional      │
│                            ROUTING_DIRECTIVE)                       │
│                                                                     │
│  Tools available:                                                   │
│    - bash, read_file, write_file, edit_file, glob, grep,            │
│      list_directory                                                 │
│    - agent       (if subagentExecutor wired)                        │
│    - skill       (if skillExecutor wired)                           │
│                                                                     │
│  Routing pressure:                                                  │
│    - PROMPT: "Delegate search, test, build, and verify" (one line)  │
│    - ROUTING_DIRECTIVE: 4 named skills (mint, diagnose,             │
│      shadow-verify, parallelize)                                    │
│    - TOOL DESC: "Use for tasks that benefit from isolated context"  │
│                                                                     │
│  Default gravity: INLINE. The loop and 7 inline tools form the      │
│  most-visible affordance.                                           │
└──┬──────────────────────────────────────────────────────────────────┘
   │
   │ `agent` tool call
   ▼
┌─────────────────────────────────────────────────────────────────────┐
│ SubagentExecutor (tools/subagent-executor.ts)                       │
│   - Parses input                                                    │
│   - At depth < maxDepth: creates child SubagentManager + child      │
│     SubagentExecutor + child SkillExecutor, recursively threading   │
│     `agent` and `skill` tools down                                  │
│   - At depth >= maxDepth: child loses agent+skill (graceful)        │
│   - Forks via SubagentManager.forkSubagent                          │
│     → emits `subagent.dispatched` JSONL                             │
│     → dispatches SubagentStart hook (blocking-capable)              │
│   - Awaits runToResult                                              │
│   - Returns { content: result.message.content }  (verbatim, no      │
│     compression)                                                    │
│   - On failure: { content: errorMessage, isError: true } — STRIPS   │
│     status/schemaError/partialOutput                                │
└──┬──────────────────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────────────────────┐
│ SubagentManager (agent/subagent.ts) + AbortGraph                    │
│   - Permission bubbling: parent canUseTool → children               │
│   - apiKey auto-fill: parent → child if child config lacks it       │
│   - Hook registry threaded down                                     │
│   - Abort propagation: parent abort → all children                  │
│   - Output schema (Zod) optional per fork                           │
└──┬──────────────────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Child AgentSession (new query)                                      │
│   - Resumes parent sessionId + forkSession=true (independent fork)  │
│   - Same TOOL_SYSTEM_PROMPT + manifest + user system                │
│   - Same provider class                                             │
│   - Can recurse to depth 3                                          │
└─────────────────────────────────────────────────────────────────────┘

Skill path runs parallel to the above:

  `skill` tool → SkillExecutor (tools/skill-executor.ts)
    → registry skill (inline OR fork=true via SubagentManager)
    → OR plugin SKILL.md → forkSubagent with SKILL.md body as system

  Inside well-orchestrated skills (diagnose, audit-fit, review):
    skill handler → SubagentManager.runWave([…]) → parallel children

Telemetry surface:
  - ~/.afk/agent-framework/routing-decisions.jsonl  (spawn only)
  - ~/.afk/agent-framework/forge-telemetry.jsonl    (skill-internal)

  - SubagentStart / SubagentStop hooks               (in-process)

  Gaps: no completion, no failure, no schema-error, no depth-limit,
        no fallback, no compression-size events.

Intended vs actual:
  Intended: main session = coordinator; delegation = default for
            multi-file / parallel / verifying work.
  Actual:   main session = worker by default; delegation = ad-hoc,
            triggered when the model happens to remember the
            routing directive's 4 named skills.
```

---

## D. Proposed delegation policy

### Main session role

**Coordinator. Planner. Synthesizer. Final accountable agent.**

The main session:
- Reads the user's intent and turns it into a plan.
- Decides what to delegate and what to keep local.
- Receives compressed findings from subagents.
- Synthesizes across findings.
- Owns the final decision and the final artifact.
- Owns the terminal state declaration.

### Subagent role

**Investigator. Verifier. Specialist. Evidence gatherer.**

A subagent:
- Operates with zero prior context.
- Receives objective, paths, constraints, expected deliverable shape, expected length.
- Returns: answer + evidence + confidence + risks + recommended next action + unresolved questions + what was not checked.
- Does not return: raw logs, large file dumps, search traces, intermediate hypotheses, redundant snippets.

### Nested subagent role

**Focused second-level investigator. Scope isolator. Hypothesis tester.**

A nested subagent:
- Is used when a subagent discovers a *separable* sub-investigation.
- Returns to its parent in the same compressed shape.
- Is bounded by `DEFAULT_MAX_NESTING_DEPTH = 3` (configurable).
- Is preferred over the subagent doing the second-level work inline when the second level would consume >30% of the subagent's context budget.

### Delegation triggers (when to dispatch)

Delegate to one subagent when the task involves:
- Reading or grepping >3 files to answer one question.
- Verifying a claim independently from the chain that produced it.
- Investigating a failing test or unexplained behavior.
- Producing a compressed map of an unfamiliar area.

Delegate to **multiple parallel subagents** when:
- ≥2 sub-questions are independent.
- Each sub-question would otherwise consume substantial inline context.
- Adversarial / shadow-verifier patterns apply.

Use **nested subagents** when a child finds a separable sub-investigation.

### Inline-work exceptions (when not to delegate)

Stay inline when:
- The task is a single-file edit or a localized fix you can see in <2 reads.
- The task is a conversational answer that needs no investigation.
- The user explicitly asked for a direct tool call.
- The cost of dispatching exceeds the cost of doing it (typo fix, 1-line patch, single grep).
- The action is not parallelizable AND requires no isolation (e.g., the chosen fix in `/diagnose`'s synthesis step).

### Cost / latency / confidence guardrails

- A subagent costs ~5-30 seconds of latency plus its own token budget. Worth it when the inline alternative would consume >2k tokens of main context or risk pollution.
- If confidence in the inline path is high AND the path is short, prefer inline.
- If confidence is low or the path is open-ended, prefer a subagent — main-session exploration is the most expensive form.
- Urgency does not lower delegation pressure — parallel subagents are usually *faster*, not slower.

### Context compression contract

Every subagent prompt should specify the return shape. Default shape:

```
Answer: <one paragraph>
Evidence: <bulleted file:line citations>
Confidence: low | medium | high
Risks / unknowns: <bulleted>
Recommended next action: <one line>
Not checked: <bulleted>
```

Target length ≤500 lines. Parent should never receive >2000 lines from any single subagent.

### Failure / fallback behavior

- If a subagent fails, the executor returns a *structured* error to the parent — not silently retried inline.
- The main session **explicitly notes** in its synthesis that fallback occurred and why.
- Silent inline fallback after delegation failure is forbidden.
- If 2 subagents disagree, the main session surfaces both rather than picking arbitrarily.

### Telemetry requirements

Minimum events (additive, JSONL):
- `subagent.dispatched` (exists)
- `subagent.completed` (add)
- `subagent.failed` (add)
- `delegation.skipped` (add)
- `fallback.inline` (add)

---

## E. Prompt patch recommendations

> **All patches below are additive and backward-compatible. None remove existing behavior.** Each can ship independently.

### E.1 Main system prompt — add "Coordinator default" section

**Target:** `prompts/system-prompt.md`
**Current weakness:** The system prompt frames the agent as a single-agent worker. No explicit role declaration. The Delegation section is 5 bullets with no triggers.
**Patch:** Insert immediately after the `## Operating posture` section, before `## Decision commitment`:

```markdown
## Coordinator default

The main session is the coordinator. Subagents are investigators.

Default to delegation for any task that would otherwise:
- read or grep more than 3 files inline,
- verify a claim independently from the chain that produced it,
- investigate a failing test or unexplained behavior,
- run two or more independent investigations that could happen in parallel,
- consume more main-session context than the subagent's compressed answer would.

Stay inline for: single-file edits, localized fixes visible in <2 reads, conversational answers, explicit user requests for a direct tool call, and tasks where dispatch overhead exceeds the work.

Parallelize independent subagents in one wave. Nest a subagent only when a child finds a separable sub-investigation that would otherwise pollute its own context.

Subagents return compressed findings, not raw exploration. A good subagent reply contains: answer, evidence with file:line citations, confidence, risks, recommended next action, unresolved questions, and what was not checked. If a subagent returns raw logs or wholesale file dumps, treat its result as a draft and synthesize before acting.

Never silently fall back to inline work after a delegation failure. State the failure and the chosen fallback before proceeding.
```

**Why it helps:** Declares the role, gives 5 concrete delegation triggers, names 5 anti-patterns inline, defines the return contract, and forbids silent fallback. Roughly +25 lines.
**Risk:** Slight prompt bloat (~+220 tokens per session). Could over-delegate trivial tasks — mitigated by the explicit inline-exception list.
**Safe to ship quickly:** Yes. Additive. Reversible.

### E.2 Rewrite `agent` tool description

**Target:** `src/agent/tools/schemas.ts:184-189`
**Current weakness:** Generic single-sentence description. No task-class enumeration. No mention of nesting, waves, compression, or context preservation.
**Current text:**
```
Dispatch a subtask to an independent agent session. The agent runs with
its own conversation context and tool access. Use for tasks that benefit
from isolated context (research, parallel work, specialized focus).
The agent runs to completion and returns its final response.
```

**Proposed replacement:**
```
Dispatch an independent subagent with its own context window and tool access. Use for tasks that protect the main session's context: codebase exploration, multi-file inspection, repo search, verification, debugging, failing-test investigation, PR review, parallel hypothesis testing, independent re-derivation of a claim, audit work, stale-path detection, feature-wiring checks, and any research-shaped investigation.

Parallelize: dispatch multiple `agent` calls in a single tool-use turn to run independent investigations concurrently.

Nest: a subagent may itself dispatch further subagents (depth limit 3) when it discovers a separable sub-investigation.

Subagents return their final assistant message verbatim — instruct them explicitly to compress their findings into: answer, evidence with file:line citations, confidence, risks, recommended next action, unresolved questions, and what was not checked. Specify expected response length.

Do not use this tool for: trivial one-file edits, conversational answers, direct tool calls the user explicitly requested, or tasks where dispatch overhead exceeds the work.
```

**Why it helps:** Enumerates task classes the runtime designers had in mind. Documents parallel + nesting as first-class. Tells the model the compression contract. Bounds with anti-patterns.
**Risk:** Heavier tool description (~3x current size). Adds ~200 tokens to every session's tool definitions block. Could over-bias toward delegation if anti-patterns are skimmed.
**Safe to ship quickly:** Yes. Tool descriptions are designed to be thorough.

### E.3 Skill manifest framing header + expand routing directive

**Target A:** `src/agent/tools/skill-bridge.ts:56-58`
**Current weakness:** Header is just "Available skills (invoke via the `skill` tool):" — flat menu.
**Proposed replacement:**
```typescript
return [
  'Available skills (invoke via the `skill` tool):',
  '',
  'Each skill dispatches one or more context-isolated subagents internally. Calling `skill` is a delegation primitive — it preserves the main session\'s context. Prefer a skill over inline investigation when the task shape matches.',
  '',
  ...lines,
].join('\n');
```

**Target B:** `src/agent/routing-directive.ts:14-26`
**Current weakness:** Routes 4 named skills only. Missing the delegation-shape primitives (gather, research, review, ground-state, shadow-verify, devils-advocate).
**Proposed addition** (append after the existing "Common composed sequences" block, before "Skip orchestration for..."):

```typescript
Reach for context-isolated investigators when the task is exploratory:

- Map an unfamiliar module before editing → `/gather` or `/research`
- Re-derive a load-bearing claim independently → `/shadow-verify`
- Audit a diff before merge → `/review`
- Survey git + infra + memory before non-trivial work → `/ground-state`
- Generate alternatives before committing to a plan → `/devils-advocate`

Or dispatch a raw `agent` call when no skill matches but the work is parallelizable, verification-heavy, or would otherwise consume substantial inline context.
```

**Why it helps:** Tells the model the *category* (context-isolated investigators), names the skills that fit that category, and provides an escape hatch to raw `agent` for shapes that don't match any skill.
**Risk:** Routing directive doubles in size (~80 tokens). Low risk; users can disable auto-routing.
**Safe to ship quickly:** Yes.

### E.4 Add 2 lines to `TOOL_SYSTEM_PROMPT`

**Target:** `src/agent/tools/system-prompt.ts:10-23`
**Current weakness:** First system-prompt segment the model sees. Says nothing about subagents.
**Proposed addition** (append after the existing bullet list, before the `<command-name>` tag rule):

```
- Prefer `agent` (and `skill`) for multi-file investigation, verification, parallel hypotheses, and any work that would otherwise consume large amounts of inline context. The main session is the coordinator; subagents are the investigators.
```

**Why it helps:** Sets the tone in the very first prompt segment. Reinforces the coordinator framing introduced in §E.1.
**Risk:** ~50 tokens; trivial.
**Safe to ship quickly:** Yes.

### E.5 Document the compression contract for subagent prompts

This is a *prompt-authoring* convention, not a runtime change. Add to `CONTRIBUTING.md` or `src/agent/README.md`:

```markdown
## Subagent return contract

When dispatching a subagent (raw `agent` tool or skill-internal `forkSubagent`), the dispatching prompt should specify the return shape. Default shape:

- Answer: one paragraph
- Evidence: file:line citations
- Confidence: low | medium | high
- Risks / unknowns: bulleted
- Recommended next action: one line
- Not checked: bulleted

Target length ≤500 lines. The dispatching session should never receive >2000 lines from one subagent. If raw evidence is required, save it to a file and reference the path — don't inline it into the return.
```

**Why it helps:** Lifts the implicit norm into a documented standard for future skill authors.
**Risk:** None. Documentation only.
**Safe to ship quickly:** Yes.

### E.6 Fallback-reporting line for the main prompt

**Target:** `prompts/system-prompt.md` — add to the "Failure handling" section
**Patch:**

```markdown
- **Delegation failure.** If a subagent fails (error, schema mismatch, timeout, depth limit), do not silently inline the work. State the failure, the chosen fallback, and proceed only if the fallback is acceptable for the task.
```

**Why it helps:** Closes the silent-fallback loophole at the prompt layer.
**Risk:** None.
**Safe to ship quickly:** Yes.

---

## F. Runtime patch recommendations

### Must-have

**F.1 Surface structured subagent failures to the parent model**

**File:** `src/agent/tools/subagent-executor.ts:184-195`
**Issue:** `result.status`, `result.schemaError`, `result.partialOutput`, `result.id` are dropped when `isError: true` is returned.
**Proposed change:** Return a structured JSON string in `content`:
```typescript
if (result.status === 'succeeded' && result.message) {
  return { content: result.message.content };
}
const payload = {
  status: result.status,
  error: result.error?.message ?? 'Subagent failed with no output',
  schemaError: result.schemaError?.message,
  partialOutput: result.partialOutput,
  subagent_id: result.id,
};
return { content: JSON.stringify(payload), isError: true };
```
**Expected behavior:** Parent model sees structured failure and can decide whether the partial output is usable.
**Risk:** Existing callers that read `content` as plain text now get JSON. Mitigated because `isError: true` already signals a non-normal path.
**Test needed:** Unit test for each failure status (`failed`, `timeout`, `aborted`, schema-error).
**Backward compat:** Behavior changes only on the error path. Success path unchanged.

**F.2 Emit `subagent.completed` and `subagent.failed` telemetry**

**File:** `src/agent/tools/subagent-executor.ts` (and/or `src/agent/subagent/handle.ts`)
**Issue:** Only spawn is logged. Cannot compute outcome rates.
**Proposed change:** After `await handle.runToResult(...)`, call `appendRoutingDecision` with `event: 'subagent.completed'` (status, duration_ms, content_chars, parent_subagent_id) or `'subagent.failed'` (status, error_message).
**Risk:** None — telemetry is best-effort and swallows errors.
**Test needed:** Telemetry write verified in integration test.
**Backward compat:** Additive.

**F.3 Emit `delegation.skipped` when skill or agent tool refuses at depth limit**

**File:** `src/agent/tools/skill-executor.ts:81-86`, `src/agent/tools/subagent-executor.ts` (when no `childProviderFactory`)
**Issue:** Depth-limit rejections are invisible.
**Proposed change:** Add `appendRoutingDecision({ event: 'delegation.skipped', reason: 'max_depth' | 'no_executor', depth, subagent_id_parent })`.
**Risk:** None.

### Should-have

**F.4 Emit `parallel_group.dispatched`/`completed` when N agent calls arrive in one tool-use turn**

**File:** wherever tool calls are batched in `src/agent/providers/anthropic-direct/`
**Issue:** Cannot distinguish parallel waves from serial calls in telemetry.
**Proposed change:** Tag the routing-decision payload with a `wave_id` shared across calls dispatched in the same model turn.
**Risk:** Requires correlating tool calls in one turn — small implementation lift. Defer until at least one analysis script needs it.

### Later

**F.5 Surface a "manager-root" abstraction at the tool layer that lets a skill author dispatch a wave with one call.**
The `runWave` library exists (`src/agent/subagent/wave.ts`) but is invisible to the model. Either expose it as a new tool (`agent_wave`?) or just document the pattern in the `agent` tool description (already covered in §E.2).

**F.6 Add a `compression_budget` field to subagent fork config**
Hard-cap the size of the returned message. If exceeded, the executor injects a "compress your previous answer to ≤N lines" follow-up turn before returning.
This is speculative — defer until we observe the failure mode.

### Do not do yet

- Don't build a dashboard. JSONL + ad-hoc scripts is enough until volume justifies it.
- Don't add per-session "delegation score" enforcement. Behavioral pressure first; runtime enforcement only after we can measure it.
- Don't refactor `/mint` or `/forge` to add inter-phase compression — those are working skills with high test coverage. Address in their own future patch.
- Don't expose nesting depth as a model-facing parameter. Sane default (3) is fine; making it tunable invites recursion abuse.

---

## G. Telemetry spec

**Storage:** `~/.afk/agent-framework/routing-decisions.jsonl` (already exists). Same surface, additive events. Best-effort writes, never propagate errors. Skip in test environments (`VITEST` / `NODE_ENV=test`).

**Event schema** — every event has `{ ts: ISO8601Z, surface: 'afk', event: string, ...payload }`.

### G.1 Events

| Event | When emitted | Required fields | Optional fields |
|---|---|---|---|
| `subagent.dispatched` *(exists)* | After `forkSubagent` succeeds | `subagent_id`, `id_prefix`, `parent_session_id` | `model`, `max_turns`, `depth` |
| `subagent.completed` *(new)* | After `runToResult` returns succeeded | `subagent_id`, `parent_session_id`, `duration_ms`, `content_chars`, `status` | `schema_validated: bool` |
| `subagent.failed` *(new)* | After `runToResult` returns non-succeeded OR throws | `subagent_id`, `parent_session_id`, `duration_ms`, `status`, `error_message` | `schema_error: string`, `partial_output_chars` |
| `delegation.skipped` *(new)* | When skill/agent tool refuses at depth or with no executor | `parent_subagent_id`, `reason: 'max_depth' \| 'no_executor' \| 'unknown_skill'`, `depth`, `requested_name` | |
| `parallel_group.dispatched` *(new, optional)* | When ≥2 agent tool calls land in one model turn | `wave_id`, `parent_session_id`, `child_count`, `id_prefixes: string[]` | |
| `fallback.inline` *(new)* | Recorded by skill code when it had to drop back to inline after a child failure | `parent_session_id`, `original_subagent_id`, `reason` | |

### G.2 Example payloads

```jsonl
{"ts":"2026-05-11T22:14:01Z","surface":"afk","event":"subagent.dispatched","subagent_id":"audit-skills-1716...","id_prefix":"audit-skills","parent_session_id":"sess-abc","depth":0,"model":"sonnet"}
{"ts":"2026-05-11T22:14:38Z","surface":"afk","event":"subagent.completed","subagent_id":"audit-skills-1716...","parent_session_id":"sess-abc","duration_ms":37204,"content_chars":4812,"status":"succeeded"}
{"ts":"2026-05-11T22:15:02Z","surface":"afk","event":"subagent.failed","subagent_id":"verify-3-1716...","parent_session_id":"sess-abc","duration_ms":12001,"status":"failed","error_message":"Response timeout","schema_error":null}
{"ts":"2026-05-11T22:15:10Z","surface":"afk","event":"delegation.skipped","parent_subagent_id":"diagnose-wave2-...","reason":"max_depth","depth":3,"requested_name":"shadow-verify"}
{"ts":"2026-05-11T22:14:01Z","surface":"afk","event":"parallel_group.dispatched","wave_id":"wv-1716...","parent_session_id":"sess-abc","child_count":3,"id_prefixes":["audit-skills","runtime-audit","prompt-pressure"]}
```

### G.3 What questions this answers

| Question | Query |
|---|---|
| Are subagents being used at all? | count `subagent.dispatched` per session |
| Are subagents succeeding? | ratio of `subagent.completed` / (completed + failed) |
| What's the median subagent latency? | `duration_ms` histogram on completed events |
| Are parallel waves happening? | count of `parallel_group.dispatched` per session |
| Is nesting actually used? | distribution of `depth` on dispatched events |
| Are we hitting the depth limit? | count `delegation.skipped` with `reason: max_depth` |
| Are there silent fallbacks? | presence of `fallback.inline` events from skill code |
| Is the main session over-delegating? | ratio of `subagent.dispatched` to user turns; if >5/turn consistently, possibly noise |
| Is the main session under-delegating? | sessions with high inline tool-call counts (need separate counter) but zero dispatches |
| Is the main session ignoring child failures? | sessions with `subagent.failed` followed by no `fallback.inline` and no other dispatch |

### G.4 What NOT to log

- Subagent prompts and responses (privacy + size; route through dedicated facets if needed)
- File contents read by subagents
- Tool inputs and outputs
- Stack traces (use the `error_message` field)
- Hook handler outputs

### G.5 Privacy / safety boundary

`routing-decisions.jsonl` already lives under `~/.afk/agent-framework/`, treated as local-only telemetry. Same boundary applies. No secrets, no credentials, no user content. IDs are random, not derived from user input.

### G.6 First useful summary report

A 30-line script that reads the JSONL, groups by session, and prints:

```
Session  Dispatched  Completed  Failed  Skipped  ParallelWaves  AvgChildDur(ms)  MaxDepth
sess-abc      12         11        1       2          3              4830           2
sess-xyz       0          0        0       0          0                 -           0
sess-def      31         29        2       5          7              5210           3
```

Sessions with 0 dispatches and high tool-call counts are the under-delegation candidates. Sessions with `MaxDepth = 3` and high `Skipped` counts are the over-nesting candidates.

---

## H. Behavioral test plan

> Test runner can be a thin script that sends a prompt to a fresh session, captures the tool-call sequence + the routing-decisions JSONL, and asserts on counts/shapes. Doesn't need to evaluate output quality — only behavior shape.

### H.1 Should delegate

| # | Prompt | Expected mode | Expected telemetry | Pass condition | Failure signal |
|---|---|---|---|---|---|
| 1 | "Audit this codebase for auth bugs." | parallel subagents (3+) | ≥3 `subagent.dispatched` in one wave; `parallel_group.dispatched` | child_count ≥ 3, no inline grep marathons | main session greps >5 times before any dispatch |
| 2 | "Find why this test is failing: `path/to/test`." | `/diagnose` skill OR ≥2 parallel agents | skill dispatch OR parallel agents | `/diagnose` invoked, or research+hypothesis waves visible | main session reads test + impl inline and guesses |
| 3 | "Compare two possible implementations of X." | 2 parallel subagents (one per option) | 2 `subagent.dispatched` in one wave | both options evaluated by independent agents, then synthesized | sequential single-agent comparison |
| 4 | "Review this PR for risky assumptions." | `/review` skill (which itself spawns wave) | skill dispatch with nested children | review skill fired; nested children visible | inline diff reading |
| 5 | "Search the repo for stale/dead paths." | parallel subagents per area | ≥2 `subagent.dispatched` | parallel; results compressed | sequential greps |
| 6 | "Verify whether feature X is wired end-to-end." | ≥1 subagent + optional shadow-verify | dispatch + optional shadow-verify | independent verification visible | inline tracing |
| 7 | "Run an orchestration self-audit." | parallel subagents (this very audit) | ≥2 `subagent.dispatched` | the audit itself uses orchestration | inline-only audit |
| 8 | "Find where credentials are propagated into child sessions." | 1 focused subagent | 1 `subagent.dispatched` with constrained scope | single focused investigator with compressed return | main session greps across whole repo |

### H.2 Should NOT delegate (anti-over-delegation)

| # | Prompt | Expected mode | Pass condition | Failure signal |
|---|---|---|---|---|
| 9 | "Fix this typo in README.md line 47: 'teh' → 'the'." | main-only, single `edit_file` call | 0 `subagent.dispatched`; edit applied | spawns a subagent for a 1-char fix |
| 10 | "What does the `glob` tool do?" | main-only, conversational | 0 `subagent.dispatched`; direct answer from system prompt | spawns a subagent to read its own description |
| 11 | "Run `pnpm test` and report the result." | main-only, `bash` | 0 `subagent.dispatched` | spawns a subagent to wrap a single command |
| 12 | "Show me the contents of `package.json`." | main-only, `read_file` | 0 `subagent.dispatched` | spawns a subagent for a direct read |

### H.3 Should delegate AND nest

| # | Prompt | Expected mode | Pass condition |
|---|---|---|---|
| 13 | "Audit auth across the codebase and verify any flagged finding independently." | parent → wave of audit agents → one or more nested verifier agents | `subagent.dispatched` events with `depth: 0` and `depth: 1` both present |
| 14 | "Diagnose this failing test, then have shadow-verify check your fix proposal." | `/diagnose` → `/shadow-verify` (composed) | both skills fire; nested children visible |

### H.4 Failure-path tests

| # | Scenario | Pass condition |
|---|---|---|
| 15 | A skill at depth 3 calls `/shadow-verify` | `delegation.skipped` event emitted with `reason: max_depth`; parent receives structured error |
| 16 | A subagent fails with schema error | `subagent.failed` event with `schema_error` populated; parent sees structured payload in `content`; main session declares the fallback rather than silently re-doing inline |
| 17 | A subagent times out | `subagent.failed` event with `error_message` containing "timeout"; parent declares fallback |

---

## I. Risk assessment

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Over-delegation** after prompt patch | Medium | Inline-exception list in §E.1 is explicit; "Skip orchestration for: single-line edits, trivial Q&A…" already in routing directive. Watch telemetry: if mean dispatches/turn > 5 on routine requests, tighten. |
| **Cost explosion** from parallel waves | Medium | Subagent default model is `sonnet`, not the parent's model. Nesting capped at depth 3. Per-call `max_turns` capped at 50. Wave size is implicitly bounded by the model's one-turn tool-call budget. |
| **Latency** worsens on simple tasks | Low | Inline exceptions cover most simple tasks. Subagent dispatch latency is dwarfed by avoided inline reading on multi-file work. |
| **Recursive loops** at nesting | Low | Hard cap at depth 3, abort-graph propagation works, depth-limit refusal is graceful (returns isError). |
| **Noisy summaries** in main context | Medium | Return-shape contract is documented (§E.5) but not enforced. The first patch is prompt-only; observable degradation triggers F.6 (compression_budget). |
| **Credential propagation bugs** | Low | Already covered: `subagent.ts:205` auto-fills `apiKey` from parent; nesting threads it through via `defaultConfig.apiKey`. |
| **Parent/child context contamination** | Low | `forkSession=true` creates an independent fork; each child gets its own provider instance and system prompt rebuild. |
| **Loss of simplicity** in prompt | Medium | §E.1 adds ~25 lines. Worth it; the prompt today is missing role declaration. Could be tightened in a v2 once we see usage. |
| **Prompt bloat** | Low | Total additive tokens across all proposed prompt patches: ~500. Negligible vs. typical session size. |
| **Telemetry noise** | Low | Schema is 6 event types. JSONL stays under 100MB for years at realistic dispatch rates. |
| **The patches don't actually change behavior** | Medium | Possible — prompt changes are signals, not guarantees. The telemetry from §G is the empirical check. Ship prompts → observe dispatch rates → tune. |

---

## J. Final recommendation

**Primary cause:** prompt policy + tool description. The runtime is mostly right; the model is just not *told* to use it.

**Ship order:**

1. **Smallest useful audit** — this document, in `docs/audits/orchestration-pressure-audit.md`. ✅ done.
2. **Prompt + tool description patches** (§E.1–E.4, E.6). Additive, reversible, ~500 tokens total. Ship in one PR.
3. **Minimal telemetry** (§G.1, F.2, F.3, F.4). Three new events, all additive, all best-effort. Ship in one PR after the prompt patches so we can measure their effect.
4. **Structured failure surfacing** (F.1). One small targeted runtime patch with a unit test.
5. **Behavioral test harness** (§H). Build after the above so we measure against the new behavior, not the old.
6. **Compression contract documentation** (§E.5). Documentation-only.
7. **Runtime enforcement / compression_budget / dashboards** — deferred until telemetry shows we need them.

**What this audit deliberately does NOT recommend:**

- No removal of any existing behavior.
- No refactor of skills that already orchestrate correctly (`/diagnose`, `/audit-fit`, `/review`, `/ground-state`).
- No new tools — `agent` and `skill` are sufficient; lift framing, not mechanism.
- No dashboards; JSONL + a 30-line summary script is enough.
- No enforcement of delegation in the runtime — pressure first via prompts, measure, then enforce only if measurement shows the prompts didn't take.

**Closing note.** This audit was itself produced by Agent AFK using the orchestration shape it is recommending — three parallel investigators (skills, runtime, prompt-stack), each returning compressed findings, synthesized by the main session. Token cost in the main context: ≈3 short subagent summaries, not the ~30 file reads they replaced. The dispatch shape works. The problem is that without the patches in §E, this is the exception rather than the default.
