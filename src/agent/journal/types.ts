/**
 * Message journal: shared types (the contract every lane codes against).
 *
 * The journal is the durable, provider-neutral record of a session's full
 * conversation: every user / assistant message, every tool_use with its full
 * input, and every tool_result with its FULL content. It is both the audit
 * record and the source for `--resume` / `/fork` (the same file, like Claude
 * Code's per-session transcript). Design + rationale: docs/message-journal.md.
 *
 * Invariant: the journal is an EVENT LOG over the provider's in-memory
 * message array, with exactly two mutation kinds. Folding the records in file
 * order reproduces the array:
 *   - `append { index, message }`  → array[index] = message (index === length)
 *   - `truncate { length }`        → array.length = length
 * Every provider-side mutation (push, compaction splice, rewind, orphan
 * repair, /clear, provider switch) is expressible as truncate + append, which
 * is what {@link JournalSync} emits. `mark` records are annotations only and
 * never change the folded array.
 *
 * @module agent/journal/types
 */

/** Current on-disk record schema version. */
export const JOURNAL_VERSION = 1 as const;

/**
 * A pointer to bytes spilled out of the JSONL line into the session's blob
 * store (`sessions/<id>/blobs/<sha256>.<ext>`). `path` is RELATIVE to the
 * sessions root (`getSessionsDir()`), so a forked journal can reference its
 * parent's blobs without copying them.
 */
export interface BlobRef {
  path: string;
  bytes: number;
  sha256: string;
  mediaType: string;
}

/** Binary payload (image / document): inline base64 until spilled, then a ref. */
export type JournalBinary =
  | { kind: 'base64'; mediaType: string; data: string }
  | { kind: 'url'; url: string }
  | { kind: 'ref'; ref: BlobRef };

/** One part of a tool_result's content. */
export type JournalResultPart =
  | { type: 'text'; text: string }
  /** Large text spilled to the blob store. `preview` is the head of the text. */
  | { type: 'text_ref'; ref: BlobRef; preview: string }
  | { type: 'image'; source: JournalBinary }
  | { type: 'document'; source: JournalBinary; title?: string };

/** Provider-neutral content block. Superset-compatible with Anthropic blocks. */
export type JournalBlock =
  | { type: 'text'; text: string }
  | { type: 'text_ref'; ref: BlobRef; preview: string }
  /**
   * `origin` is the provider family that produced the block (e.g.
   * `'anthropic'`); a signature is only valid for its own family. Absent on
   * blocks written before #2464.
   */
  | { type: 'thinking'; thinking: string; signature?: string; origin?: string }
  | { type: 'redacted_thinking'; data: string; origin?: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result';
      toolUseId: string;
      isError?: boolean;
      /**
       * True when the tool result carries a subagent's capped or wind-down
       * partial answer. Mirrors `ToolResult.incomplete` / `ProviderEvent['tool.output'].incomplete`.
       * Present only when true; absent for clean completions.
       * Read since #2970; WRITTEN by the provider journal adapters since #2978
       * (via `result-flags.ts`, since the native block cannot carry it). Older
       * journal files that lack this field are read as `undefined` (absent =
       * not incomplete).
       */
      incomplete?: boolean;
      /** Reason paired with `incomplete` (compose: `'compose_partial_nodes'`). Since #2978. */
      incompleteReason?: string;
      /**
       * Compose only: how many DAG nodes wound down partial in this call.
       * Present only alongside `incomplete: true`. Since #2978.
       */
      partialNodeCount?: number;
      content: JournalResultPart[];
    }
  | { type: 'image'; source: JournalBinary }
  | { type: 'document'; source: JournalBinary; title?: string };

/**
 * Shared return-type alias for both the sync (`findToolResult` in reader.ts)
 * and async (`findToolResultAsync` in reader.async.ts) tool-result lookup
 * paths. Consumers that use either function should import this type to keep
 * both sides in sync.
 *
 * @see findToolResult
 * @see findToolResultAsync
 */
export interface ToolResultLookup {
  /** Hydrated tool_result block. */
  block: Extract<JournalBlock, { type: 'tool_result' }>;
  /** Subagent id, when the result lives in a subagent journal. */
  subagentId?: string;
}

export interface JournalMessage {
  role: 'user' | 'assistant';
  content: JournalBlock[];
}

/** A span adopted by {@link JournalAdapter.adopt}: its original journal messages and how many natives it covers. */
export interface JournalAdoption {
  readonly entries: readonly JournalMessage[];
  readonly count: number;
}

/** Why a truncate happened, when the emitter knows. Advisory only. */
export type JournalTruncateReason = 'resync' | 'compact' | 'rewind' | 'clear' | 'repair' | 'provider_switch';

/** Annotation labels. Never affect the folded array. */
export type JournalMarkLabel = 'compact' | 'rewind' | 'clear' | 'resume' | 'fork' | 'model_switch';

interface RecordBase {
  v: typeof JOURNAL_VERSION;
  ts: number;
}

export type JournalRecord =
  | (RecordBase & {
      kind: 'meta';
      sessionId: string;
      /** Set on a subagent journal (`sessions/<id>/subagents/<subagentId>.jsonl`). */
      subagentId?: string;
      /** Random id of the writing process/instance; detects concurrent writers. */
      writerId: string;
      provider?: string;
      model?: string;
      cwd?: string;
      /** Set when this journal was created by /fork. */
      forkedFrom?: { sessionId: string; length: number };
    })
  | (RecordBase & { kind: 'append'; index: number; message: JournalMessage })
  | (RecordBase & { kind: 'truncate'; length: number; reason?: JournalTruncateReason })
  | (RecordBase & { kind: 'mark'; label: JournalMarkLabel; detail?: Record<string, unknown> });

/** Records a writer accepts (the writer stamps `v` and `ts`). */
export type JournalRecordInput =
  | Omit<Extract<JournalRecord, { kind: 'append' }>, 'v' | 'ts'>
  | Omit<Extract<JournalRecord, { kind: 'truncate' }>, 'v' | 'ts'>
  | Omit<Extract<JournalRecord, { kind: 'mark' }>, 'v' | 'ts'>;

/**
 * Session-scoped journal sink. One instance per conversation stream: the
 * top-level session owns one; each subagent fork gets its own via
 * {@link MessageJournal.forSubagent}. Providers never construct this; they
 * receive it on `AgentConfig.messageJournal` and wrap it in a
 * {@link JournalSync}.
 *
 * Contract: every method is fire-and-forget and MUST NOT throw. Disk errors
 * are swallowed (reported once to stderr). Writes are applied in call order
 * (spilled blobs are written before the record that references them).
 */
export interface MessageJournal {
  /** Folded array length the journal currently represents (in-memory, not re-read). */
  readonly length: number;
  append(index: number, message: JournalMessage): void;
  truncate(length: number, reason?: JournalTruncateReason): void;
  mark(label: JournalMarkLabel, detail?: Record<string, unknown>): void;
  /** Journal for a forked child: `sessions/<sessionId>/subagents/<subagentId>.jsonl`. */
  forSubagent(subagentId: string): MessageJournal;
  /** Resolve once every queued write has hit disk. For tests and shutdown. */
  flush(): Promise<void>;
  /** Flush and stop accepting writes. Idempotent. */
  close(): Promise<void>;
}

/**
 * Bidirectional mapping between a provider's native message type and the
 * neutral journal format. Each provider owns exactly one adapter.
 *
 * Contract:
 *   - `toJournal` maps ONE native message to at most one journal message.
 *     Return `null` for messages that are not conversation content (e.g. an
 *     OpenAI `system` entry); {@link JournalSync} skips them and keeps its own
 *     index mapping.
 *   - `fromJournalMessages` maps a WHOLE folded journal array to a native
 *     array ready to seed the provider on resume. It is array-level because
 *     providers re-group: OpenAI splits a user message holding N tool_results
 *     into N `tool` messages; Anthropic merges consecutive same-role messages.
 *   - Round trip: for every array the provider itself produces,
 *     `fromJournalMessages(arr.map(toJournal))` must be send-equivalent to it.
 *   - Messages written by OTHER providers (cross-provider resume) must be
 *     accepted and degraded gracefully, e.g. dropping thinking signatures the
 *     provider cannot replay, or rendering images it cannot send as text.
 *   - Input is already hydrated: no `text_ref` / `ref` sources remain.
 *   - `adopt` (optional, #2464): when the natives starting at `at` are a span
 *     `fromJournalMessages` built and are unchanged, return the ORIGINAL
 *     journal messages for the whole span; {@link JournalSync} then uses them
 *     instead of `toJournal`, so a provider switch writes nothing and hands
 *     over losslessly. See `JournalProvenance` (provenance.ts).
 *     **Lossless-resume contract**: `adopt` is required for a lossless
 *     cross-provider resume. Omitting it (or returning `undefined` for a span)
 *     silently falls back to `toJournal` per message, which loses
 *     thinking signatures and may rewrite the journal in the new provider's
 *     lossier shape.
 */
export interface JournalAdapter<T> {
  toJournal(message: T): JournalMessage | null;
  fromJournalMessages(messages: readonly JournalMessage[]): T[];
  adopt?(messages: readonly T[], at: number): JournalAdoption | undefined;
}
