/**
 * Exit-time guardian for stdio MCP server children.
 *
 * The gap it closes: `McpManager.disconnectAll()` gives each client a 1 s
 * budget and then resolves. The SDK's `StdioClientTransport.close()` ends the
 * child's stdin, waits up to 2 s, sends SIGTERM, waits 2 s more, then SIGKILL —
 * but every one of those waits is an UNREF'D timer. When afk exits right after
 * `disconnectAll()` (the CLI, daemon, and telegram teardown paths all do), the
 * event loop drains before the SIGTERM step and a server that ignores stdin
 * EOF is orphaned, reparented to init, and lives forever.
 *
 * The fix is deliberately additive and exit-only:
 *   - Every stdio child this process spawns is tracked by pid from the moment
 *     the SDK reports a successful spawn until the child's stdio closes.
 *   - ONE `process.once('exit')` handler, installed lazily on the first
 *     registration, synchronously SIGTERMs every still-tracked pid.
 *
 * Invariant: nothing here runs during a normal disconnect. `disconnectAll()`
 * timing and the SDK's EOF → SIGTERM → SIGKILL ladder are untouched; the
 * guardian only acts on children that are still alive when the process is
 * already exiting. SIGTERM only — no SIGKILL, no process groups, no
 * `detached` — so a server's own grandchildren and shutdown hooks keep their
 * existing semantics. (On Windows `process.kill(pid, 'SIGTERM')` is a hard
 * kill; that is also what the SDK's own ladder does there.)
 *
 * SSE / streamable-HTTP transports have no child process and never reach
 * this module.
 *
 * @module agent/mcp/stdio-exit-guardian
 */

import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const trackedPids = new Set<number>();
let exitHandlerInstalled = false;

/** Track a spawned stdio child so it is SIGTERMed if still alive at exit. */
export function registerStdioChild(pid: number): void {
  trackedPids.add(pid);
  if (!exitHandlerInstalled) {
    exitHandlerInstalled = true;
    process.once('exit', terminateTrackedChildren);
  }
}

/** Stop tracking a child (it exited, or its stdio closed). */
export function unregisterStdioChild(pid: number): void {
  trackedPids.delete(pid);
}

/** Snapshot of currently tracked pids. Exported for tests. */
export function trackedStdioChildren(): number[] {
  return [...trackedPids];
}

/**
 * Synchronously SIGTERM every still-tracked child and forget it. Runs inside
 * the `exit` handler, so it must never throw or await. ESRCH (already gone)
 * and EPERM (pid not ours any more) are expected and swallowed.
 * Exported for tests.
 */
export function terminateTrackedChildren(): void {
  for (const pid of trackedPids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // ESRCH / EPERM — nothing to clean up.
    }
  }
  trackedPids.clear();
}

/**
 * `StdioClientTransport` that registers its child with the guardian once the
 * spawn succeeds and unregisters it when the child's stdio closes (normal
 * disconnect, SDK ladder completing, or the server crashing on its own).
 *
 * Contract: `Protocol.connect()` assigns `transport.onclose` BEFORE calling
 * `start()`, so chaining onto it after `super.start()` resolves preserves the
 * SDK's own close handling.
 */
export class TrackedStdioClientTransport extends StdioClientTransport {
  override async start(): Promise<void> {
    await super.start();
    const pid = this.pid;
    if (typeof pid !== 'number') return;
    registerStdioChild(pid);
    const sdkOnClose = this.onclose;
    this.onclose = () => {
      unregisterStdioChild(pid);
      sdkOnClose?.();
    };
  }
}
