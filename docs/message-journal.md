# Message journal

The message journal is the durable, provider-neutral record of a session's
**full conversation**: every user and assistant message, every `tool_use` with
its full input, and every `tool_result` with its **full content**. One file is
both the audit record ("what did that tool actually return?") and the source
for `--resume` and `/fork`, the same shape Claude Code uses
(`~/.claude/projects/<slug>/<sessionId>.jsonl` plus a `tool-results/` spill dir).

## Why

Before the journal, no store kept full tool results:

| Store | What it kept of a tool result |
|---|---|
| `sessions/<id>/events.jsonl` (ledger) | ~80-char "first line…+N lines" preview (`stream-consumer.preview.ts`), clipped to 400 |
| `witness/<label>/trace.jsonl` | `resultBytes`, `isError`, `durationMs`, 200-char `errorHead` |
| `sessions/<id>.json` sidecar `turns[]` | `tool_result` blocks built from the **same preview**, replayed to the model on `--resume` |

The last row was a correctness bug: a resumed session replayed previews to the
model as if they were the real results. The journal replaces that path.

## Layout

```
$AFK_STATE_DIR/sessions/<sessionId>/
  events.jsonl                  ledger (unchanged; small records for live tailers)
  journal.jsonl                 top-level conversation journal
  subagents/<subagentId>.jsonl  one journal per forked child
  blobs/<sha256>.<ext>          spilled payloads, content-addressed
```

Paths: `src/paths.journal.ts` (re-exported from `src/paths.ts`).

## Record format

JSONL, one record per line, `v: 1`. Types: `src/agent/journal/types.ts`.

| kind | fields | effect on the folded array |
|---|---|---|
| `meta` | `sessionId`, `writerId`, `subagentId?`, `provider?`, `model?`, `cwd?`, `forkedFrom?` | none (written once per writer open) |
| `append` | `index`, `message` | `array[index] = message` (`index === length`) |
| `truncate` | `length`, `reason?` | `array.length = length` |
| `mark` | `label`, `detail?` | none (annotation: compact, rewind, clear, resume, fork, model_switch) |

**Invariant:** folding records in file order reproduces the provider's
in-memory message array. Records are never rewritten; a truncate leaves the
dropped messages in the file, so compaction and rewind lose nothing for audit
while the fold gives exactly what the model would see next.

Messages are **provider-neutral** (`JournalMessage` / `JournalBlock`): text,
thinking (with optional signature), redacted_thinking, tool_use, tool_result
(with typed parts), image, document. Each provider owns one `JournalAdapter`
that maps its native type both ways, so a session written by one provider can
be resumed by another.

### Spill policy

Applied by the writer before a record is serialized:

- A text block or tool_result text part larger than **32 KiB** is written to
  `blobs/<sha256>.txt` and replaced by `text_ref { ref, preview }` (preview =
  first 2 KiB).
- Every base64 image/document is decoded to `blobs/<sha256>.<ext>` and
  replaced by `{ kind: 'ref', ref }`.
- `BlobRef.path` is relative to the sessions root, so forks can reference a
  parent's blobs without copying bytes. Content addressing dedups repeat reads
  of the same file within a session.
- The blob is written before the record that references it.

## Write path: `JournalSync`

Providers do not hook each mutation site (the Anthropic provider mutates its
array at ~10 sites and more keep appearing). Instead each provider wraps
`config.messageJournal` in a `JournalSync<T>` with its adapter and calls
`sync(messages)` at **commit points**:

1. immediately before each model request (after orphan repair and
   compaction; see the known gap below for per-request transforms);
2. after the assistant message is appended, before tool dispatch (so a child
   killed mid-tool still leaves its tool calls on disk);
3. at turn end (captures the final assistant message).

`sync` diffs by object reference against the last snapshot and emits
`truncate(k)` + `append`s for everything after the first divergence. Pushes
become appends; compaction, rewind, orphan repair, and `/clear` become
truncate + re-append. `seed(messages)` declares the starting array (`[]`
fresh, the seeded messages on resume); if it does not match the journal's
folded length, the journal is resynced from the first message that is not an
adopted original (see Provenance below), so a crash-resume repair appends its
synthetic tool results instead of rewriting the file.

**Provenance (#2464):** each adapter's `fromJournalMessages` records, in a
`WeakMap` keyed by the native object (`src/agent/journal/provenance.ts`), the
span it built: the contiguous native messages and the journal messages they
came from (OpenAI fans one user message out to N `tool` messages; Anthropic
merges consecutive same-role messages). `JournalAdapter.adopt` hands the
ORIGINAL journal messages back while the span is present in order and
unedited, so `seed()` counts match and `snapshot()` is lossless. A divergence
or `invalidateFrom` inside an adopted span backs off to the span's start, so
the span re-maps whole and tool pairing is never split. Edit detection is a
two-level shallow shape compare (message properties, then each block's own
properties), never a stringify, so it does not scale with tool-result size.

**Known gap:** an in-place edit of an already-synced message object is not
diff-visible (the diff is by reference), so the journal keeps the pre-edit
form until the next divergence or resync re-appends that message. Harness
notes pushed into a message that has not been synced yet (e.g. the wind-down
note) are captured normally. Microcompaction, which does edit synced messages
in place, is handled explicitly: it calls `JournalSync.invalidateFrom(index)`
so the next sync re-appends from the first edited message. Many-image
degradation and the tool-result hoist are re-applied to the outgoing request
before every model call rather than committed to the array, so the fold keeps
the pre-degradation form for those: the audit holds more than the model was
sent, and a resume re-applies the same transforms.

**Cross-provider resume and switch:** resuming or switching onto another
provider seeds that provider's adapter from the fold. Adopted spans map back
to their originals, so the switch writes nothing and switching back keeps
thinking signatures, redacted thinking, and documents the other wire could
not carry. Only messages the new provider creates are journaled in its form.
Thinking blocks carry `origin` (provider family); Anthropic replays signed
thinking only when `origin` is `anthropic` or absent (pre-#2464 records). If
Anthropic still rejects a recovered signature with a 400, the round retries
once with thinking stripped from earlier turns
(`anthropic-direct/loop/signature-retry.ts`). That retry is a rare fallback:
a live A→B→A run (2026-09-28, `claude-opus-5-5` → `gpt-6-luna` →
`claude-opus-5-5`) replayed four recovered signed thinking blocks after six
OpenAI-written turns and Anthropic accepted the request with no 400. Not yet
verified live: switching back to a DIFFERENT Claude model than the one that
signed the thinking.

**Mid-session `/model` swap:** a cross-provider switch rebuilds the provider
runtime through the router (`src/agent/providers/router/provider-router.ts`).
The router takes the outgoing runtime's `ProviderQuery.journalSnapshot()` (the
live conversation in journal form) and seeds the new runtime with it as
`resumeMessages`, so the new model continues with tool calls and full results
rather than a text summary. The process-start `resumeMessages` is never
carried into a swap (it would be stale). Without a journal the router falls
back to its text `shadowHistory`, as before.

## Sessions, subagents, lifecycle

- The session layer builds the journal (`createMessageJournal`) with a lazy
  session-id accessor and puts it on `AgentConfig.messageJournal`. Records
  buffer in memory until the id resolves.
- Subagent forks resume the parent's session id, so they must NOT write the
  parent's journal. The fork config gets `parent.forSubagent(subagentId)`,
  writing `subagents/<subagentId>.jsonl`. The journal travels on the fork
  PARENT (`JournalParent.messageJournal` in `fork-types.ts`), not on the child
  config: `fork-child-config.ts` overwrites any inherited journal with
  `parent.messageJournal?.forSubagent(id)` and clears `resumeMessages`, so a
  child can never write its parent's file.
- Coverage: every fork of a journaled session gets its own subagent journal.
  - Top-level parents: all executor wiring sites (REPL `bootstrap-infra.ts`,
    `afk chat`, daemon/scheduler `daemon-session-factory.ts`, Telegram, web
    server) hand the executors a deferred parent whose `messageJournal` getter
    reads the live session (`IAgentSession.messageJournal`).
  - `agent`, `skill` and `compose` forks. DAG nodes fork with
    `{ sessionId, messageJournal }` (`dag-subagent.ts`), so each node journals
    to its own file.
  - Depth-2+ `agent` forks: after the fork returns, `subagent-executor.ts`
    backfills the child executor's stub parent with the child's own journal
    (`handle.session.messageJournal`) next to the `sessionId` backfill.
  - Depth-2+ skill forks: `fork-dispatch.ts` passes a `JournalParentHolder`
    through `buildForkedChildConfig` and fills it the same way. The nested
    skill factory (`nesting.ts`) reads it lazily.
  - Layout is flat: every descendant shares the root session id, so a
    grandchild writes `sessions/<rootId>/subagents/<grandchildId>.jsonl`, a
    different file from its parent's `subagents/<childId>.jsonl`. The tree
    shape is not encoded in the path.
  - Remaining gap: a stub parent with no journal source (tests, bare harnesses,
    unjournaled sessions) still produces unjournaled children.
- `/clear` closes the journal and opens a fresh one before the provider
  runtime is rebuilt (non-CLI surfaces mint a new session id on reset, so the
  old journal must not capture the new conversation). On the CLI the id is
  unchanged, so the new writer resumes the on-disk file; `mark('clear')` plus
  the new runtime's `seed([])` truncate the fold to 0. Lifecycle glue:
  `src/agent/session/journal-lifecycle.ts`.
- A resumed session gets `mark('resume')`; `/model` gets `mark('model_switch')`
  only when the resolved model actually changes.
- Journal `length` is read from the on-disk fold on first access after the id
  resolves, so a resumed process appends at the right index.

## Resume and fork

- `resumeConfigFor` loads `loadJournalMessages(sessionId)` (fold + hydrate) and
  sets `config.resumeMessages`. Providers seed from it with their adapter and
  ignore `resumeHistory`. Sidecars without a journal (older sessions, journal
  disabled) keep the legacy `resumeHistory` path unchanged.
- The resumed context equals the last live context (compaction is part of the
  fold), which fit the window when it was live.
- New sidecar turns stop writing `userContentBlocks` / `assistantContentBlocks`
  (they held previews). Old sidecars that have them still replay as before when
  no journal exists.
- `/fork` calls `forkJournal(parent, newId)`, which writes the folded
  conversation into the new session's journal with `forkedFrom`.
- The OpenAI-compatible provider previously resumed text-only; with a journal
  it resumes tool calls and results too.

## Retention

`sessions/<id>/` directories (ledger, journal, blobs, subagents) are swept by
`sweepSessionDirs` (`src/agent/session-sidecar-sweep.dirs.ts`), called from the
session sidecar sweep and using the same `AFK_SESSION_MAX_AGE_DAYS` knob. Age is
the newest mtime across a directory's contents (POSIX does not bump a
directory's mtime on appends), the active session and anything touched in the
last hour are kept, and each directory is re-walked just before removal. A
directory named by a surviving journal's `forkedFrom` chain is also kept,
because a fork's blob refs point into its parent's `blobs/` rather than copies.

## Concurrency

One writer per process per journal, O_APPEND, no locks, like the ledger. Each
writer stamps a `writerId` on its `meta` record. Two processes resuming the same
session at once interleave appends; the fold tolerates index gaps (reported as
anomalies) rather than failing.

## Disable

`AFK_MESSAGE_JOURNAL_DISABLED=1` turns the journal off; resume falls back to the
sidecar path. No redaction is applied (same as Claude Code); files are 0600 in
0700 directories.

## Readers

| API | Use |
|---|---|
| `loadJournalMessages(id)` | resume |
| `findToolResult(id, toolUseId)` | web UI full tool output, `afk trace show --results` |
| `readJournalRecords` + `foldJournal` | audit, analysis |
| `forkJournal(src, dst)` | `/fork` |

Import everything from `src/agent/journal/index.ts`.

## Follow-ups (not in the first PR)

- `AFK_CAPTURE_SUBAGENT_OUTPUT` / `AFK_CAPTURE_SUBAGENT_PROMPTS` are subsumed by
  subagent journals and can be retired.
- Facets / harvest could read the journal instead of sidecar `toolEvents`.
