# Shared Agent Workspace A/B Experiment Report

**Date:** 2026-08-20
**Experimenter:** afk session @ 4c0759dc
**Repo:** agent-afk @ 50000443 (main)

## Hypothesis

The shared workspace (PR #1213–#1227) reduces cross-agent file-read duplication
(baseline: 59%) by enabling sibling subagents to share findings, so later agents
skip files already analyzed by earlier ones.

## Method

### Arm B (Treatment — workspace enabled, default)

Two compose tasks dispatched from the same session, workspace enabled:

1. **Task 1** (non-overlapping files): 3 agents investigating different
   subdirectories (anthropic-direct, openai-compatible, shared infra).
2. **Task 2** (overlapping files): 3 agents investigating the SAME 5 files
   (subagent.ts, session.ts, providers/index.ts, fork-child-config.ts,
   dispatcher.ts) from different angles (errors, permissions, lifecycle).

### Arm A (Control — workspace disabled)

`afk chat` with `AFK_WORKSPACE_DISABLED=1` was attempted but failed: one-shot
`afk chat` in non-TTY mode exits immediately (session sealed as `failed`,
0 turns). Root cause: OAuth keychain auth doesn't initialize properly in piped
subprocess context. This is a known gap in the chat command's non-interactive
support.

## Results

### Task 1 — Non-overlapping files (3 agents, workspace enabled)

| Metric                   | Value |
|--------------------------|-------|
| Total read_file calls    | 8     |
| Unique fingerprints      | 8     |
| Cross-agent duplicates   | 0     |
| Cross-agent dedup ratio  | 0.0%  |
| Distinct agents          | 2     |
| Total tool calls (all)   | 93    |
| workspace_publish calls  | 0     |

### Task 2 — Overlapping files (3 agents, workspace enabled)

| Metric                   | Value |
|--------------------------|-------|
| Total read_file calls    | 13    |
| Unique fingerprints      | 13    |
| Cross-agent duplicates   | 0     |
| Cross-agent dedup ratio  | 0.0%  |
| Distinct agents          | 3     |
| Total tool calls (all)   | 117   |
| workspace_publish calls  | 0     |

### Full session (both tasks combined, shadow-verified)

| Metric                   | Value |
|--------------------------|-------|
| Total read_file calls    | 15    |
| Unique fingerprints      | 14    |
| Cross-agent duplicates   | 1     |
| Cross-agent dedup ratio  | 6.7%  |
| Distinct agents          | 5     |
| Total tool calls (all)   | 140   |
| bash calls               | 110   |
| grep calls               | 5     |
| workspace_publish calls  | 0     |

## Findings

### F1: Workspace was never used (0 workspace_publish calls) [CONFIRMED]

Shadow-verified: the compose subagents did not call `workspace_publish` in either
task (0 matches in the full 544-line trace). This means the treatment arm was
functionally identical to the control arm — the workspace existed but no agent
used it.

### F2: Near-zero cross-agent read dedup despite file overlap [CORRECTED]

~~Original claim: 0% dedup~~ → Shadow-verified: **6.7%** (1 of 15 read_file calls)
across the full session. One fingerprint (`8eb5ea77…`) was read by 2 agents with
identical args. The metric uses `argsFingerprint` (SHA-256 of full serialized
args including path + offset + limit), confirmed by script inspection. This makes
the metric **stricter than "same file"** — different byte ranges of the same file
produce distinct fingerprints.

### F3: Agents overwhelmingly prefer grep/bash over read_file [CORRECTED]

Shadow-verified full-session counts:
- 110 bash calls, 5 grep calls, vs 15 read_file calls (7:1 bash-to-read ratio)
- ~~Original claim: 49 bash vs 13 read_file~~ — undercounted; only covered one
  compose task instead of the full session trace
- The dedup metric only tracks `read_file`, missing the dominant access pattern

### F4: Compose parallelism defeats workspace sharing [CORRECTED]

~~Original claim attributed this to `dag.ts:97-108`~~ → Shadow-verified: `dag.ts`
is **workspace-agnostic** (0 workspace references). Workspace preamble injection
happens in the compose handler / subagent fork path, not the DAG executor.
The empirical claim — that edgeless parallel nodes all start before any can
publish — is plausible but **UNVERIFIABLE from dag.ts alone**. The DAG executor
delegates `node.run()` opaquely; workspace timing depends on the fork site.

### F5: One-shot `afk chat` fails in non-TTY context [CONFIRMED + ROOT-CAUSED]

Shadow-verified: all 4 control sessions show `status: "failed"`, 0 turns, 22ms.

**Root cause (traced):** The macOS keychain blob (`Claude Code-credentials`)
has `mcpOAuth` but **no `claudeAiOauth` entry** — the OAuth session expired and
was never re-authenticated. The credential resolution chain:
1. `preloadClaudeKeychainOAuth()` → no token to refresh → `undefined`
2. `loadCredential()` → `loadAnthropicCredential()` → all 4 sources return `undefined`
3. `src/cli/index.ts:223`: `!credential && provider === 'anthropic-direct'`
4. `src/cli/index.ts:224`: `!process.stdin.isTTY` → **`process.exit(1)`**

The REPL session works because it ran with `stdin.isTTY === true`, so the
guard at line 224 fell through to the interactive auth wizard which obtained a
credential cached in-process (`refreshedClaudeCodeOauthToken`). Subprocesses
don't inherit that in-process cache.

**Fix:** `run-workspace-ab-test.sh` now pre-checks for credentials and gives a
clear diagnostic. To run: `afk login` first (refreshes keychain), or
`export ANTHROPIC_API_KEY=sk-ant-...` before the script.

This is NOT a product bug — non-TTY + no credential → exit with error is correct
behavior. The bug is the missing credential in the keychain.

## Conclusions

1. **The A/B experiment cannot produce a valid comparison** without fixing the
   `afk chat` non-TTY issue (F5) or finding an alternative control arm mechanism.

2. **Even with workspace enabled, agents don't use it** (F1). The workspace_publish
   tool is available but compose subagents are not prompted to publish findings.
   This is expected — the tool exists but the system prompt for subagents doesn't
   instruct them to use it. The auto-publish-on-completion behavior described in
   the RFC (build step 2) is not implemented yet.

3. **The dedup metric is too strict** (F2). It measures exact-args identity, but
   agents reading the same file at different offsets produce distinct fingerprints.
   A file-path-only dedup metric would be more useful for measuring workspace
   benefit.

4. **The dominant access pattern (grep/bash) evades measurement** (F3). A
   meaningful experiment needs to track all file-access tool calls, not just
   `read_file`.

5. **Parallel composition defeats workspace by design** (F4). The workspace's
   value proposition — later agents skip files earlier agents analyzed — requires
   sequential task ordering, which trades off against parallelism (speed).

## Recommendations

1. **Add file-path-only dedup metric** to `measure-read-dedup.ts` — group by
   file path extracted from args, ignoring offset/limit.

2. **Implement auto-publish** (RFC build step 2): on child completion,
   automatically publish the child's final findings to the workspace. This is the
   missing piece that would make workspace useful even when agents don't
   explicitly call workspace_publish.

3. **Test with sequential (edged) compose tasks** rather than parallel fan-out.
   Example: research → implement → verify pipeline where the workspace carries
   research findings to the implementer.

4. **Fix `afk chat` non-TTY auth** to enable automated A/B experiments. Or add
   an `--api-key` flag for one-shot runs.

## Session References

- This session: `4c0759dc-9ddf-476d-9de4-fbffb9472410`
- Failed control sessions: `0db15163`, `c78c630c`, `a547832b`, `08d4bdac`
- Measurement script: `scripts/measure-read-dedup.ts`
- AFK_WORKSPACE_DISABLED toggle: PR #1216 (commit 35822fc2)
