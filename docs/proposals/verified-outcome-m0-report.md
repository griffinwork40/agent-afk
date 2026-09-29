# Verified Outcome M0 — Distribution Report

Generated: 2026-09-28T11:54:26.192Z  
Source: all  
Sessions processed: 16255 / 16255 available  
  JSON sidecars: 1000  
  Events-only:   15255  

## Label distribution

| Label | Count | % |
|---|---|---|
| succeeded | 270 | 2% |
| failed | 18 | 0% |
| interrupted | 166 | 1% |
| blocked | 63 | 0% |
| unknown | 15738 | 97% |

### By session kind

| Kind | Total | succeeded | failed | interrupted | blocked | unknown |
|---|---|---|---|---|---|---|
| mutating | 2041 | 228 | 6 | 25 | 18 | 1764 |
| text | 14214 | 42 | 12 | 141 | 45 | 13974 |

### By source

| Source | Total | succeeded | failed | interrupted | blocked | unknown |
|---|---|---|---|---|---|---|
| json | 1000 | 258 | 5 | 0 | 8 | 729 |
| events | 15255 | 12 | 13 | 166 | 55 | 15009 |

## Artifact recovery

- Sessions with recovered commits: **425** (3%)
- Sessions with recovered PR URLs: **223** (1%)

## Per-LF coverage

Coverage = share of sessions where LF voted non-zero.  

| LF | Non-zero | +1 | -1 | Abstain | Coverage |
|---|---|---|---|---|---|
| closure | 166 | 0 | 166 | 0 | 1% |
| budget_cap | 0 | 0 | 0 | 0 | 0% |
| error_tail | 14 | 0 | 14 | 0 | 0% |
| verification | 30 | 30 | 0 | 0 | 0% |
| in_session_correction | 126 | 0 | 126 | 0 | 1% |
| self_report | 0 | 0 | 0 | 16255 | 0% |
| pr_fate | 278 | 270 | 8 | 0 | 2% |
| commit_survival | 94 | 94 | 0 | 0 | 1% |

## Labels resting on each strong LF

(Non-unknown labels where LF cast a strong vote)

| LF | Sessions |
|---|---|
| pr_fate | 267 |
| closure | 166 |
| commit_survival | 94 |
| verification | 30 |
| error_tail | 14 |

## M0 exit criterion

Required: at least 300 non-unknown labels.

**PASS** — 517 non-unknown labels.

## Caveats

- **Closure LF**: For JSON-sidecar sessions, joining the closure LF requires
  scanning 17k+ trace directories — skipped in M0 (will be at M2 teardown).
  For events-only sessions, the closure LF IS populated from the
  `closed.reason=abort` record in events.jsonl.
- **Subagent tool events**: session JSON may only contain the parent session's
  turns. Worktree-isolated children's tool events appear in separate session
  files, invisible to parent artifact recovery.
- **fix_of_fix LF**: skipped (weak -1, cannot flip succeeded). M2 daemon job.
