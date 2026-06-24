/**
 * Telegram session construction with witness-trace wiring.
 *
 * Extracted as a tiny exported seam so the trace-writer wiring is unit-testable
 * without booting the bot — the real `createSession` closure lives inside
 * `telegram.ts`'s `main()` entry point and cannot be reached from a test.
 *
 * Mirrors the chat / REPL pattern: open a fresh default trace writer and thread
 * it into the AgentSession config so the Telegram session's subagent + skill
 * lifecycle events become durable on disk (the AFK away-from-keyboard surface).
 * Returns the config unchanged when tracing is disabled — i.e. when
 * `AFK_TRACE_DISABLED=1`, `createDefaultTraceWriter()` returns `null`.
 *
 * One writer per session: each call generates its own sessionLabel/UUID,
 * matching the chat/REPL convention.
 *
 * @module telegram/construct-session
 */

import { AgentSession } from '../agent/session.js';
import type { AgentConfig } from '../agent/types.js';
import { createDefaultTraceWriter, type CreatedTraceWriter } from '../agent/trace/factory.js';
import type { TraceWriter } from '../agent/trace/index.js';

/** Injection seams for tests; both default to production behavior. */
export interface ConstructTelegramSessionDeps {
  /** Trace-writer factory. Defaults to {@link createDefaultTraceWriter}. */
  createTraceWriter?: () => CreatedTraceWriter | null;
  /**
   * Pre-created trace writer to reuse for this session. When supplied, the
   * `createTraceWriter` factory is NOT called — the caller is responsible for
   * having already created the writer (e.g. so the same writer can be shared
   * with `loadTelegramMcpManager` for the MCP connect phase).
   *
   * Setting this to `null` explicitly suppresses tracing even when a factory
   * is available (mirrors `AFK_TRACE_DISABLED=1` behavior).
   */
  traceWriter?: TraceWriter | null;
  /** Session constructor. Defaults to `new AgentSession(config)`. */
  newSession?: (config: AgentConfig) => AgentSession;
}

/**
 * Create the witness trace writer for a Telegram session without yet
 * constructing the session. Exported so the caller can share the same writer
 * with `loadTelegramMcpManager` — the MCP connect phase runs before the
 * session is constructed, so the writer must be created first and threaded
 * into both call sites.
 *
 * Returns `null` when tracing is disabled (`AFK_TRACE_DISABLED=1`), mirroring
 * `createDefaultTraceWriter`'s own contract.
 */
export function createTelegramTraceWriter(
  factory: () => CreatedTraceWriter | null = createDefaultTraceWriter,
): TraceWriter | null {
  return factory()?.writer ?? null;
}

/**
 * Construct an AgentSession with a fresh witness trace writer merged into its
 * config (when tracing is enabled). When tracing is disabled the base config is
 * passed through unchanged, so this is a behavior-preserving wrapper around
 * `new AgentSession(...)`.
 */
export function constructTelegramSession(
  baseConfig: AgentConfig,
  deps: ConstructTelegramSessionDeps = {},
): AgentSession {
  // Use a pre-created writer when provided (allows sharing with loadTelegramMcpManager
  // so MCP connect events land in the same trace). Fall back to the factory when not.
  // `undefined` means "not supplied — run the factory"; `null` means "explicitly disabled".
  const writer: TraceWriter | null =
    'traceWriter' in deps
      ? (deps.traceWriter ?? null)
      : ((deps.createTraceWriter ?? createDefaultTraceWriter)()?.writer ?? null);
  // Default trace writer is spread FIRST so an operator-supplied
  // baseConfig.traceWriter still wins — escape-hatch parity with the daemon's
  // spawnSession (where ...sessionConfig is spread last). `surface: 'telegram'`
  // is stamped last (always telegram here) for trace `origin` attribution.
  const config: AgentConfig = writer
    ? { traceWriter: writer, ...baseConfig, surface: 'telegram' }
    : { ...baseConfig, surface: 'telegram' };
  const construct = deps.newSession ?? ((c: AgentConfig) => new AgentSession(c));
  return construct(config);
}
