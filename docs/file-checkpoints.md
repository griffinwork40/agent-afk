# File checkpoints

`AgentConfig.enableFileCheckpointing` defaults to `false` for embedders. The
interactive REPL turns it on unless `afk.config.json` sets `fileCheckpoints:
false` (#4271); chat, Telegram, the daemon, and subagent forks never set it.
Both providers attach a per-turn checkpoint registry to the tool dispatcher.
`write_file`, `edit_file`, non-dry-run `patch_apply`, and foreground `bash` in git
repos snapshot prior file bytes. Bash outcomes are tracked via `bash` turn-log
entries (see below); git-ignored and out-of-repo files are excluded from bash
capture. Creating a registry without file writes creates no turn directory.

## Content-addressed storage

The provider-agnostic store keeps state below the configured AFK state directory:

```text
file-checkpoints/<sessionId>/
  turns.jsonl                      ordered turn log (see below)
  .owner                           pid of the process checkpointing here
  .rewind-lock                     pid, present only while a restore runs
  .blobs/<sha256(content)>/content
  <turnId>/<sha256(absolutePath)>.entry/
    content
    metadata.json
```

A blob is published by atomic nonempty-directory rename. Turn entries hardlink
its bytes, deduplicating identical content across paths and turns within a
session. Filesystems without hardlink support copy bytes into the entry instead.
There is no cross-session sharing. Content files use mode `0600`; newly created
state directories use `0700` where the platform supports POSIX modes.

Metadata records the original path, existence, file mode, and optional
`contentHash`. A blob is published first by one atomic rename into `.blobs/`;
content and metadata then become visible together by a second atomic rename
that publishes the entry directory. Empty existing files and previously missing files can share
empty content but retain separate existence metadata. Concurrent publishers do
not overwrite committed entries or blobs. Failed publications clean temporary
directories; a complete but unreferenced blob can remain after an entry failure.

The additive digest keeps the v3 entry format readable by older consumers. New
readers also accept v3 entries without a digest and legacy snapshot formats.
Rewind verifies new entries' content digest before using their bytes; corruption
fails closed for that file (including dry-run). Checkpoint state is not a security
boundary against processes running as the same user.

## Turn log

`turns.jsonl` is the only record of turn ORDER (`src/agent/file-checkpoint/turn-log.ts`).
It is append-only, one JSON object per line:

- `{"kind":"turn","turnId":…}` when a checkpointed turn starts, even if it writes nothing;
- `{"kind":"post","turnId":…,"paths":{absPath: sha256|null}}` at turn end, hashing every touched path;
- `{"kind":"restore","paths":{…}}` after a live restore, superseding earlier hashes for those paths;
- `{"kind":"bash","turnId":…,"status":"captured"|"partial"|"skipped","reason"?:…,"files"?:number}` for each bash call in the turn.

`bash` entry status meanings:

| Status | Meaning |
|---|---|
| `captured` | The before/after diff was published; `files` counts published paths. This does not imply the command exited successfully. |
| `partial` | Capture is incomplete: detach, truncation, skipped non-regular paths, or a publication failure. |
| `skipped` | No usable capture: disabled, background, non-git, timeout/error, or abort before spawn. |

The bash hook appends these entries via `appendTurnLog`.
When rewinding, `rewind-plan.ts` folds `bash` entries in the suffix and collects
human-readable warnings for any non-`captured` entry, plus a standing ignored/
outside-repo warning whenever bash ran. These appear in
`ProviderRewindResult.uncaptured` and are printed by `/rewind` during the preview,
so the user understands which shell side-effects are NOT undone by the file restore.

Appends are best-effort and a torn final line is skipped. Each provider also
links the in-memory user message object to its checkpoint turnId
(`turn-lifecycle.ts`), so `RewindTarget.checkpointTurnId` tells `/rewind` which
checkpoint belongs to a picked prompt. The link is keyed by object identity:
after a resume, a `/model` switch, or compaction that replaced the message, the
target has no `checkpointTurnId` and the files option is unavailable rather
than guessed. The anthropic-direct and openai-compatible journals also record a
`checkpoint` mark per turn as durable provenance.

## Restore and limits

`AgentSession.rewindFiles(userMessageId, { dryRun: true })` previews; omitting
`dryRun` restores. Rewinding to turn N restores the state at the START of turn N
across every later turn (`rewind-plan.ts`): it folds the snapshots of every turn
logged at or after N and keeps the earliest snapshot per path, so each path is
written once. A turn absent from the log (pre-#4271 checkpoints) falls back to
that turn's own snapshots.

Current write grants and the protected-path denylist are rechecked, rather than
treating saved metadata as permission. Restore is all-or-report: every path is
attempted and each failure is returned in `failures`; `canRewind` is false when
any path failed. It is still per-file, not transactional: paths already restored
stay restored.

Drift guard: a path whose current bytes differ from its latest `post` or
`restore` hash was changed outside the agent. It is listed in `conflicts`, and a
live restore leaves it alone (reporting it as a failure) unless
`overwriteConflicts: true`.

`/rewind [conversation|files|both]` is the REPL surface. It previews every file
before restoring and, in `both`, truncates the conversation only when every
file restored. Esc-Esc runs `/rewind conversation`.

## Retention

`retention.ts` sweeps `file-checkpoints/` at top-level session start (deferred
5 s, `unref`ed, at most once per 6 hours via a `.last-sweep` stamp). Whole
session directories are evicted past `AFK_FILE_CHECKPOINT_MAX_AGE_DAYS`
(default 14), then oldest-first until under `AFK_FILE_CHECKPOINT_MAX_BYTES`
(default 1 GiB). The running session is excluded by identity, anything touched
in the last hour is kept, and a directory whose `.owner` or `.rewind-lock` pid
is a live process is skipped (re-checked immediately before removal), so an idle
REPL in another terminal keeps its checkpoints. A marker left by a crashed
process does not pin a directory. `AFK_FILE_CHECKPOINT_RETENTION_DISABLE=1`
turns the sweep off.

## Bash capture

Foreground `bash` calls capture the enclosing git working tree before execution
and at completion, including non-zero exits, timeout kills, and aborts. This
covers tracked files and untracked, non-ignored files anywhere in that repo,
even when the command runs in a subdirectory. Prior bytes are published into the
same per-turn registry as file tools: the earliest snapshot wins across both,
and bash-recorded paths participate in the post-turn drift guard.

Git uses a session-private `.git-index` and `.git-objects` under the checkpoint
session directory, never the user's index, refs, or object store. Retention
reclaims this storage with the rest of the session.

Capture is best-effort, bounded, and never fails the command. Each call writes a
`bash` outcome (`captured`, `partial`, or `skipped`) to the turn log. `/rewind`
previews incomplete-capture notes and always warns when bash ran that ignored
and outside-repo files are not restorable. Those paths are not enumerated; the
warning is a standing limitation, not a list of detected changes.

- Git repositories only; non-git workspaces skip capture.
- Git-ignored files and files outside the repo are excluded. Network calls,
  services, git refs/index changes, and other external effects are not undone.
- Symlinks, submodules, and changes above the file cap are skipped and reported
  as partial capture.
- `run_in_background: true` writes a skipped entry and takes no snapshots.
- Ctrl+B detachment takes the final snapshot at detach and reports partial:
  later changes made by the still-running process are not captured.
- Subagent forks do not have checkpoint registries; their writes are not logged.

| Variable | Default | Effect |
|---|---|---|
| `AFK_FILE_CHECKPOINT_BASH_DISABLE` | unset | Set to `1` or `true` to skip bash capture. |
| `AFK_FILE_CHECKPOINT_BASH_TIMEOUT_MS` | `5000` | Milliseconds allowed per capture/diff, and for publishing prior states. |
| `AFK_FILE_CHECKPOINT_BASH_MAX_FILES` | `1000` | Changed paths captured per call; larger diffs are partial. |

## Not yet covered

A branch tree with `/branches` (stage 3) remains tracked in #4271. Subagent
writes, ignored/outside-repo files, and post-detach/background changes remain
outside checkpoint coverage.
