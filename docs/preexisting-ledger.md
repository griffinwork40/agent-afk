# Pre-existing Defect Ledger

Agent sessions often flag a defect as "pre-existing" (not caused by this change) and
move on, so the same issue gets re-diagnosed repeatedly across parallel sessions. This
feature provides a **local, prose-free record** of those flags and a one-time backfill
over historical transcripts.

## What is stored

Only structured data — never transcript prose:

| Field | Type | Description |
|---|---|---|
| `ts` | ISO 8601 string | Timestamp of the session-end hook run |
| `sessionId` | string | AFK session identifier |
| `turn` | integer | Turn index within the session (for dedup on re-recording) |
| `repo` | string | `context.cwd` at session end (the working directory / repo root) |
| `signal` | `'preexisting-sentence'` \| `'deferred-bullet'` | Which detection signal triggered |
| `category` | `'failing-test'` \| `'gate'` \| `'size-ceiling'` \| `'other'` | Coarse deterministic category |
| `loci` | string[] | Extracted locus tokens (file paths, test names, gate names) |

### Ledger location

```
~/.afk/agent-framework/preexisting-ledger.jsonl
```

Alongside `forge-telemetry.jsonl` and `routing-decisions.jsonl` — AFK-surface
telemetry that spans sessions, not per-session state.

## Where the hook reads text from

The hook prefers `SessionEndContext.assistantTexts`, the assistant messages from
the session's in-memory history, threaded by `SessionShutdown`. One-shot
`afk chat`, daemon, and web sessions never write a session sidecar, so a
sidecar-only read would record nothing for them. When the context carries no
texts, the hook falls back to `loadStoredSession`. `assistantTexts` stays
in-process: command hooks receive an explicit field allowlist
(`buildStdinPayload`), so this text never reaches an external hook process.

## Deduplication on read

The hook deduplicates within a single session end: two detections for the same
`(signal, sorted-loci)` key collapse into one record. The `turn` field allows
consumers to further deduplicate on re-recording (e.g. if a session is replayed).

Across sessions, the same locus may appear in many records. The backfill script
clusters by locus and ranks by distinct session count; use it for the aggregated view.

## Detection signals

### 1. Pre-existing sentences

A sentence in assistant text that:

- Contains a **pre-existing phrase** (case-insensitive): `pre-existing`, `preexisting`,
  or `pre existing`.
- Contains a **defect cue word**: `fail`, `fails`, `failed`, `failing`, `failure`,
  `red`, `error`, `violation`, `stale`, `drift`, `bug`, `broken`, `flaky`,
  `grew`, `ceiling`, `exceed`, `oversized`, `lint`, `warning`.
- Names at least one **concrete locus**: a repo-relative file path, a test file name
  (e.g. `trigger.test.ts`), a CI/audit gate name (e.g. `audit:filesize:check`), or
  a backtick-enclosed module identifier with a dash or underscore (e.g. `anthropic-direct`).

**Not excluded** by "unrelated", "not mine", or "not introduced" — those phrasings
mark the REAL defects.

**Excluded** by absence of a defect cue: "the 45 pre-existing tests pass" and "the
PR's own pre-existing worktree" produce no entries.

### 2. Deferred bullets

Lines matching `Deferred: <body>` (including bold variants `**Deferred:**`, list
forms `- Deferred:`, etc.) that name at least one concrete locus. `Deferred: none`,
`Deferred: N/A`, `Deferred: nothing` are skipped.

## Opt-out

Set `AFK_PREEXISTING_LEDGER_DISABLE=1` to skip the hook entirely:

```bash
AFK_PREEXISTING_LEDGER_DISABLE=1 afk chat "..."
```

Or add it to `~/.afk/config/afk.env`.

## Backfill

Liveness in the backfill resolves prose loci (bare names, partial paths)
against `git ls-files`. A name that matches more than one tracked file (for
example `config.test.ts`, which exists under both `src/browser/` and
`src/cli/`) is reported as `ambiguous (N files)` rather than checked, because
testing the first match would report the wrong file's status.


The one-time backfill script scans `~/.afk/state/transcripts/*.md`, reuses the
same detector, clusters by normalized locus, and ranks by distinct sessions + recency.

```bash
# Scan all transcripts and write ledger:
pnpm backfill:preexisting

# Also run vitest on the top 3 test loci:
pnpm backfill:preexisting --test-top 3
```

Output ledger: `~/.afk/agent-framework/preexisting-backfill.md`

The backfill ledger contains only loci, counts, dates, transcript filenames, and
liveness. No transcript prose is persisted.

Liveness per cluster:
- **File path**: `exists (N loc)` or `NOT FOUND` (does the file exist in the repo?).
- **Test file**: `recheck: pnpm test <file>` or vitest pass/fail if `--test-top N` was given.
- **Gate name**: `recheck: pnpm <gate>` (e.g. `recheck: pnpm audit:filesize:check`).
