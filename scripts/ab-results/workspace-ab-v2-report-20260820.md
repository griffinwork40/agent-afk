# Workspace A/B Experiment v2 — Tool-Round Measurement

**Date:** 2026-08-20
**Session:** 4c0759dc-9ddf-476d-9de4-fbffb9472410
**Repo:** agent-afk @ 01143628 (main)
**Design:** Revised per devils-advocate critique — in-process compose (shared
WorkspaceStore), tool-round metric instead of file-read dedup.

## Design

### What changed from v1
- **v1 flaw (fatal):** spawned separate `afk chat` subprocesses — each creates its
  own `WorkspaceStore` in-memory, so the two arms could never share workspace
  entries by design. The experiment was architecturally invalid.
- **v2 fix:** both arms run as `compose` calls from within a single REPL session,
  where all subagents share one in-process `WorkspaceStore`.

### Task
3 parallel agents investigating the **same 5 files** from different angles
(error handling, permissions, lifecycle) — identical across both arms.

### Arms
- **Arm A (control):** agents told "do NOT use workspace_publish or
  workspace_query. Work independently."
- **Arm B (treatment):** agents told "call workspace_query before reading each
  file; call workspace_publish after analyzing each file."

### Metric
**Total tool rounds** across the 3 investigator subagents (excluding root
orchestrator). A "round" = one assistant turn requesting ≥1 tool calls.

## Results

| Metric                    | Arm A (Control) | Arm B (Treatment) | Delta |
|---------------------------|----------------:|------------------:|------:|
| Subagent tool calls       |              27 |                29 |    +2 |
| **Subagent tool rounds**  |          **10** |             **9** | **-1** |
| workspace_publish calls   |               0 |                 0 |     0 |
| workspace_query calls     |               0 |                 0 |     0 |
| Distinct agents           |               3 |                 3 |     0 |

### Per-agent breakdown

**Arm A (Control — no workspace)**
| Agent              | Calls | Rounds | Primary tools |
|--------------------|------:|-------:|---------------|
| ctrl-error-agent   |    13 |      5 | bash: 13      |
| ctrl-perm-agent    |     9 |      4 | bash: 9       |
| ctrl-lifecycle     |     5 |      1 | read_file: 5  |
| **Total**          |**27** | **10** |               |

**Arm B (Treatment — workspace instructed)**
| Agent              | Calls | Rounds | Primary tools |
|--------------------|------:|-------:|---------------|
| ws-error-agent     |    11 |      4 | bash:5 read:4 |
| ws-perm-agent      |    11 |      3 | bash:6 read:4 |
| ws-lifecycle       |     7 |      2 | read:5 bash:1 |
| **Total**          |**29** |  **9** |               |

## Findings

### F1: Agents still never called workspace_publish or workspace_query (0 calls)

Despite explicit instructions to "call workspace_query before reading" and "call
workspace_publish after analyzing," **zero workspace tool calls** were made in
either arm. The agents either:
1. Don't have workspace_publish/workspace_query in their tool list (compose
   subagents may not receive workspace tools)
2. Chose to ignore the instruction in favor of direct file reads

This is the same result as v1. The workspace feature is wired but agents don't
use it — the tool exists but the model doesn't call it.

### F2: Tool rounds were nearly identical (10 vs 9)

The 1-round difference is within noise. With 0 workspace tool calls, there was no
mechanism for the workspace to reduce work — the treatment arm functioned
identically to the control.

### F3: Tool usage patterns shifted slightly

Arm B agents used more `read_file` (13 vs 5) and less `bash` (12 vs 22). This is
likely prompt-wording effect (workspace instructions primed agents toward file-level
operations) rather than a workspace effect.

### F4: Arm B agents called get_runtime_state (3 calls)

Each Arm B agent made 1 `get_runtime_state` call — likely attempting to discover
workspace tools. This suggests the agents tried to follow workspace instructions
but couldn't find or use the tools.

## Root Cause Analysis

The workspace feature has three layers, and the gap is between layers 2 and 3:

1. **WorkspaceStore** (layer 1) — ✅ Built and working. SQLite in-memory,
   publish/queryRelevant API.
2. **Workspace preamble injection** (layer 2) — ✅ Built. `injectWorkspacePreamble`
   in `fork-child-config.ts` adds relevant workspace entries to child system prompt
   at fork time.
3. **Workspace tools available to agents** (layer 3) — ❓ Unclear. The
   `workspace_publish` tool is registered in `workspace-tools.ts` and added to
   provider schemas, but compose subagents may not receive it in their tool list
   depending on the `CHILD_ALLOWED_TOOLS` gating in `nesting.ts`.

The HANDOFF.md notes: "workspace_query excluded from v1 model surface to minimize
agent-policy confounds in the deduplication experiment." This is a deliberate
design choice — workspace_query was excluded from subagent tools intentionally.

## Conclusions

1. **The workspace cannot reduce tool rounds if agents can't publish to it.**
   The auto-publish mechanism (RFC build step 2: "on child completion, auto-publish
   findings") is the missing piece.

2. **The correct experiment waits for auto-publish.** Once findings are
   automatically published on child completion, sequential compose nodes (with
   edges: A→B→C) would receive prior findings via workspace preamble. THAT is
   the experiment to run — sequential pipeline, not parallel fan-out.

3. **Tool rounds are the right metric** (confirmed). The 10-vs-9 result is
   genuinely comparable; the metric works. The feature just isn't exercised yet.

## Recommendations

1. **Implement auto-publish** (RFC build step 2): on child completion, publish the
   child's final findings to the workspace. This requires no model cooperation.
2. **Test with sequential compose** (A→B→C with edges): agent B gets A's findings
   via workspace preamble, should skip redundant investigation.
3. **Optionally add workspace_publish to CHILD_ALLOWED_TOOLS** so agents CAN
   publish mid-run (not just on completion).

## Artifacts

- Measurement script: `scripts/measure-tool-rounds.ts`
- Dedup script: `scripts/measure-read-dedup.ts`
- v1 report: `scripts/ab-results/workspace-ab-report-20260820.md`
- This report: `scripts/ab-results/workspace-ab-v2-report-20260820.md`
- Trace lines: Arm A = lines 1005–1110, Arm B = lines 1111+ of session trace
