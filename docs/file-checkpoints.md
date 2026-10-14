# File checkpoints

`AgentConfig.enableFileCheckpointing` is opt-in (default `false`). Both providers
already attach a per-turn checkpoint registry to the tool dispatcher. Only
`write_file`, `edit_file`, and non-dry-run `patch_apply` snapshot prior file bytes;
Bash changes are not captured. Creating a registry without file writes creates
no checkpoint directories.

## Content-addressed storage

The provider-agnostic store keeps state below the configured AFK state directory:

```text
file-checkpoints/<sessionId>/
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

## Restore and limits

`AgentSession.rewindFiles(userMessageId, { dryRun: true })` previews changed
tracked files; omitting `dryRun` restores their saved bytes or deletes files that
were missing at capture time. Current write grants and the protected-path denylist
are rechecked, rather than treating saved metadata as permission. Restore remains
per-file, not transactional: an error can report files already changed.

A turn checkpoint records the pre-write state of paths touched in that turn; it
is not a whole-workspace snapshot and does not roll back unrelated paths touched
only in later turns. There is no automatic blob garbage collection or retention
policy yet. Bash capture, conversation/files/both slash-command UX, and broader
cross-turn rewind semantics remain separate work under #3246.
