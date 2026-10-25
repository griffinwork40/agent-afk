/**
 * Warm MCP spare for `afk web` session creation.
 *
 * Creating a web session used to block on connecting every configured MCP
 * server (`mcp_connect_done` ~1.4 s warm, ~10 s on a cold machine) before the
 * session could even initialize. `afk web` now connects ONE spare manager per
 * cwd at startup; `create()` takes it and a replacement is connected in the
 * background, so a new session normally waits for nothing.
 *
 * Invariant: each session still owns a distinct McpManager. Sharing one would
 * be cheaper but `onServerError` / `onToolsRefreshed` are single callback
 * slots that each session overwrites, so a shared manager would route one
 * session's MCP-failure notice into another session. The pool is opt-in per
 * cwd (`prewarmWebMcp`): unit tests and other callers that never prewarm get
 * the old connect-on-demand behaviour and never spawn background servers.
 *
 * @module web-server/session-owner.mcp-warm
 */
import type { McpManager } from '../agent/mcp/index.js';
import { emitSessionPhase } from '../agent/trace/emit.js';
import type { TraceSink } from '../agent/trace/writer.js';

type Connect = (traceSink?: TraceSink) => Promise<McpManager | undefined>;

interface Spare {
  startedAt: number;
  manager: Promise<McpManager | undefined>;
}

const spares = new Map<string, Spare | null>();

function connectSpare(connect: Connect): Spare {
  const manager = connect(undefined).catch(() => undefined);
  return { startedAt: Date.now(), manager };
}

/** Start connecting a spare for `cwd`. Returns a disposer for shutdown. */
export function prewarmWebMcp(cwd: string, connect: Connect): () => Promise<void> {
  if (!spares.get(cwd)) spares.set(cwd, connectSpare(connect));
  return async () => {
    const spare = spares.get(cwd);
    spares.delete(cwd);
    const manager = await spare?.manager;
    await manager?.disconnectAll().catch(() => {});
  };
}

/**
 * Take the warm spare for `cwd` (refilling it in the background), or connect
 * on demand when the pool is not enabled for this cwd. The taken spare's wait
 * is recorded as an `mcp_connect_start`/`mcp_connect_done` pair with
 * `metadata.source = 'warm'` so the session trace still explains MCP latency.
 */
export async function takeWebMcpManager(cwd: string, traceSink: TraceSink | undefined, connect: Connect): Promise<McpManager | undefined> {
  const spare = spares.get(cwd);
  if (!spare) return connect(traceSink);
  spares.set(cwd, connectSpare(connect));
  const waitStart = Date.now();
  void emitSessionPhase(traceSink, { phase: 'mcp_connect_start', metadata: { source: 'warm' } });
  const manager = await spare.manager;
  void emitSessionPhase(traceSink, {
    phase: 'mcp_connect_done',
    durationMs: Date.now() - waitStart,
    metadata: { source: 'warm', spareAgeMs: waitStart - spare.startedAt, serverCount: manager?.getServerStates().length ?? 0 },
  });
  return manager;
}
