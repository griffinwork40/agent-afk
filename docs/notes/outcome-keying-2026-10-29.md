# Outcome keying diagnosis — 2026-10-29

Status: **diagnosis only, no code fix**. The briefed gap does not reproduce on the
live stores. No candidate hypothesis explains more than 80% of the residual gap
that does exist, so per the task's stop rule nothing was changed in `src/`.

Measured read-only on this machine on 2026-10-29 at about 22:30 EDT. The stores
were still growing during the measurement.

## 1. The briefed premise does not hold

| Brief claimed | Measured |
|---|---|
| ledger 1,413 lines, 101 sessionIds, 302 `git commit` lines | 1,419 lines, 103 distinct `sessionId` values (102 UUIDs + `null`), 304 `git commit` lines. Consistent with growth since the brief. |
| outcomes: 172 files, 169 `label: unknown` | 174 files, 171 `unknown` (2 `interrupted`, 1 `blocked`). Consistent. |
| **0** outcomes with non-empty `artifacts.commits` | **45** have non-empty commits (checked with both `jq '(.artifacts.commits\|length)>0'` and python). |
| **0** with `artifacts.prs` | **27** |
| **zero** overlap between ledger commit sessionIds and outcome file names | **49 of 53** commit sessionIds (52 UUIDs + `null`) have an outcomes file named `<sessionId>.json`. |

Joined at the record level: there are 152 `pending` ledger records whose
`args` contain `git commit`. **145 (95.4%)** carry a `sessionId` that has an
outcomes file. The residual is **7 records across 4 keys**.

Reproduce with `python3` over `~/.afk/state/effect-ledger.jsonl` and
`~/.afk/agent-framework/outcomes/*.json`, joining `record.sessionId` against the
file stem.

Labels being mostly `unknown` is a labeling or LF issue, not a keying issue.
The only content-level gap is in the 49 joined commit sessions: 25 of them have
empty `artifacts.commits` even though the ledger shows an `executed` commit
whose result contains a SHA (e.g. `4cb30d8e`: `f4a6a63 docs: cut map …`).
That is extraction, which belongs to the `artifacts.ts` owner, and is out of
scope here.

## 2. Hypotheses vs evidence

### H1 — ledger stores child/fork ids that outcomes skip: **falsified (0%)**

- Of the 102 non-null ledger `sessionId`s, 102 are top-level session dirs under
  `~/.afk/state/sessions/<id>/`. Every `<id>.json` sidecar has
  `parentSessionId: null`.
- 0 ledger ids match any of the 1,301 child labels under
  `~/.afk/state/sessions/*/subagents/*.jsonl`. Child labels are slugs like
  `compose-A1-1793327201150-3`, not UUIDs.
- 22 of the 152 pending commit records have a command that appears verbatim in
  a subagent journal of the same root. All 22 are keyed to the root id in the
  ledger. Subagent commits are already root-keyed.
- No outcomes file name is a child id (0/174).

### H2 — two id namespaces: **confirmed for one path, explains 3/7 residual commit records (43%) and 11/11 null-`sessionId` ledger records**

On a fresh, non-resumed session, a mid-session cwd re-anchor (the `afk -w`
born-named worktree path, `setCwd`) rebuilds the tool dispatcher with
`config.sessionId`. That value is populated only under `--resume`/`--continue`.
The first build uses the minted id instead. After the re-anchor, every
PreToolUse context loses `sessionId`, so the effect ledger writes records with
no `sessionId`.

- First build uses the resolved or minted id:
  `src/agent/providers/anthropic-direct/query/dispatcher-wiring.ts:136-146`
  (`resolveTopLevelSessionId`) → `:184`/`:221` (`sessionId: resolvedSession.id`).
- The rebuild uses the resume-only field:
  `src/agent/providers/anthropic-direct/query/cwd-dependents.ts:132`
  (`sessionId: args.config.sessionId`). The rebuilt system prompt has the same
  problem at `:106`.
- `config.sessionId` is resume-only: `src/agent/providers/shared/presence-lifecycle.ts:88`.
  The mint happens at `:196-210`.
- The dispatcher forwards only a defined id:
  `src/agent/tools/dispatcher.pre-dispatch-gates.ts:559`. The ledger stores
  `context.sessionId` as-is: `src/agent/effect-ledger/hook.ts:105,139,169`.
- SessionEnd still sees the real id, so the outcomes file is written under the
  minted id: `src/agent/outcomes/session-end-hook.ts:128-133`. Ledger and
  outcomes therefore disagree only for post-re-anchor records.

Live evidence: there are 22 ledger lines (11 records) with no `sessionId`. All
11 resolve uniquely to 4 top-level sessions whose `cwd` is under
`.afk-worktrees/`:

| Root session | Null-id records | First records |
|---|---|---|
| `75c2db56` | 1 | 2 records with id before the cwd switch, then null |
| `158c906b` | 5 | 0 records with id |
| `5eb7443c` | 1 | 4 records with id before the switch |
| `692bc05b` | 4 | 0 records with id; 2026-10-29, afk 5.340.0, so this is current code |

All 4 roots do have outcomes files. Their `artifacts.commits` are empty, so the
null-keyed commits are invisible to anything joining by id.

### H3 — lifecycle: **explains 4/7 residual records (57%), with three different causes**

- `4ce6c208` (1 record) was a **live** session at measurement time (no
  `endedAt`). It is the orchestrator session itself. This is not a bug.
- `60622a4c` (2 records, afk 5.339.0) has `exitReason: exit-command` in the
  sidecar, but `events.jsonl` has no `closed` event and there is no receipt.
  The SessionEnd hooks evidently did not run or finish before process exit.
- `339a0d84` (1 record) is one of 6 sessions from 2026-10-11 (`339a0d84`,
  `b662afb1`, `f6a80421`, `e3ebdf39`, `974cddf4`, `773e3dda`). All 6 have
  `closed` events and receipts but **no outcomes file**. Sessions on 10-10 and
  10-12 do have outcomes files. Probable cause is an outcomes-hook regression
  window that day (fix commits `f147fd64`/#3571 on 10-11 and `45ddcb2e`/#3593
  on 10-12). **Not verified.**
- The outcomes dir is not a pruned window. Its earliest `session_ended_at` is
  2026-10-10, and the ledger range is 2026-10-11 → 2026-10-29.

### Receipts

Receipt files are keyed by a writer or trace label, not by session id: only 1
of 180 `receipts/*.json` has a file stem equal to its `sessionId`. The JSON
`sessionId` field does join: 169 of 180 match an outcomes file and 99 match
ledger ids. 50 of 52 commit sessionIds have a receipt whose `sessionId` field
matches. Join receipts on the field, never on the file name.

## 3. Root key definition (recommended)

The root key is the top-level session's resolved id, `resolvedSession.id` from
`resolveTopLevelSessionId`. This is the value that names
`~/.afk/state/sessions/<id>/`, `outcomes/<id>.json`, and the receipt's
`sessionId` field.

Recommended fix, not applied because of the stop rule:

- Thread `resolvedSession.id` into `createCwdDependentsFactory`, replacing
  `args.config.sessionId` at `cwd-dependents.ts:106,132`.
- Optionally add `rootSessionId` to ledger records, computed as
  `context.rootSessionId ?? context.parentSessionId ?? context.sessionId`.

A failing test would build a provider query without `config.sessionId`, invoke
the cwd factory, and assert the rebuilt dispatcher's PreToolUse context carries
the minted id.

## 4. Historical mapping rule for a backfill

Inputs: `~/.afk/state/effect-ledger.jsonl`,
`~/.afk/state/sessions/<id>.json` (sidecar: `startedAt`, `endedAt`/`savedAt`,
`parentSessionId`), and `~/.afk/state/sessions/<id>/journal.jsonl`.

1. **Record has `sessionId` S.** If `sessions/S.json` exists with
   `parentSessionId == null`, then root = S. This held for 102/102 ids here.
   If the parent is non-null, follow `parentSessionId` up to the top. That
   never occurred here.
2. **Record has no `sessionId`.**
   - Candidates are the top-level sessions whose
     `[startedAt, endedAt ?? savedAt]` contains `record.timestamp`.
   - Among those, root is the one whose `journal.jsonl` contains an `append`
     entry with an assistant `tool_use` whose `input.command` matches
     `record.args.command`.
   - Compare on the prefix before the first `[REDACTED]`, because the ledger
     redacts args. Unescape journal JSON before comparing.
   - This resolved 11/11 uniquely here. If 0 or more than 1 candidates match,
     leave the record unmapped.
3. **Root has no `outcomes/<root>.json`.** The cause is H3 lifecycle. Either
   synthesize an outcome from the journal or exclude the root. Do not attribute
   its records to another session.
4. Join receipts by the receipt's JSON `sessionId` field, not by the file name.
