import { format } from 'node:util';

/**
 * Route `console.warn` / `console.error` through the REPL's persistent
 * compositor while it owns the terminal.
 *
 * Invariant: the armed TerminalCompositor paints every row by absolute cursor
 * positioning (CUP) and parks the cursor at the END of the last row it painted,
 * with no trailing newline. A foreign write straight to stderr therefore lands
 * mid-row — e.g. a failing hook's `[hooks] command exited with code 1: …`
 * started at column ~165 right after the turn-separator rule, hard-wrapped at
 * the terminal edge, and every following line (the stack trace) started at
 * column 0, outside the AFK_CENTER_CONTENT margin. Committing the text through
 * `commitAbove` gives it its own rows, the current centering margin, band
 * reflow on resize, and queueing while the compositor is suspended.
 *
 * Agent-layer code (hooks, subagents, permissions store, …) must not import the
 * CLI compositor, so the bridge lives at the surface that owns the terminal and
 * is scoped to exactly the armed lifetime: {@link installConsoleBridge} returns
 * the inverse, which the REPL loop's `finally` runs BEFORE `surface.dispose()`.
 *
 * Contract:
 * - Arguments are formatted with `util.format`, matching what `console.warn`
 *   would have printed; one trailing newline run is dropped so the commit does
 *   not append a spurious blank row.
 * - Re-entrancy (the compositor itself warning from inside `commitAbove`) and a
 *   throwing sink both fall back to the original method, so a warning is never
 *   lost and can never recurse.
 * - The returned restore is idempotent and only reinstates a method it still
 *   owns, so a later wrapper (e.g. a test spy) is not clobbered.
 */
export interface ConsoleBridgeSink {
  commitAbove(text: string): void;
}

type BridgedMethod = 'warn' | 'error';
type ConsoleTarget = Pick<Console, BridgedMethod>;

const BRIDGED: readonly BridgedMethod[] = ['warn', 'error'];

export function installConsoleBridge(
  sink: ConsoleBridgeSink,
  target: ConsoleTarget = console,
): () => void {
  let inBridge = false;
  const installed = BRIDGED.map((method) => {
    const original = target[method];
    const bridged = (...args: unknown[]): void => {
      if (inBridge) {
        original.apply(target, args);
        return;
      }
      inBridge = true;
      try {
        sink.commitAbove(format(...args).replace(/\n+$/, ''));
      } catch {
        original.apply(target, args);
      } finally {
        inBridge = false;
      }
    };
    target[method] = bridged;
    return { method, original, bridged };
  });

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const { method, original, bridged } of installed) {
      if (target[method] === bridged) target[method] = original;
    }
  };
}
