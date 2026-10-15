/**
 * Judge resolver: picks the appropriate `Judge` based on the user's
 * `--judge` choice and Jev availability.
 *
 * Resolution logic:
 *   - `'auto'`  → Jev when `connectJev()` succeeds, else Claude
 *   - `'jev'`   → Jev; throws a clear error when unavailable
 *   - `'claude'`→ Claude (always available)
 *
 * @module whatif/judge/index
 */

import type { CompleteFn, Judge } from '../types.js';
import { createClaudeJudge } from './claude.js';
import { createJevJudge } from './jev.js';
import type { connectJev } from './jev-connect.js';

export interface ResolveJudgeDeps {
  complete: CompleteFn;
  model: string;
  connectJev: typeof connectJev;
}

/**
 * Resolve and return the appropriate `Judge`.
 *
 * Closes the Jev connection when Jev is selected — the Judge owns the
 * connection lifetime through `judge.close()`.
 */
export async function resolveJudge(
  choice: 'auto' | 'jev' | 'claude',
  deps: ResolveJudgeDeps,
): Promise<Judge> {
  const { complete, model, connectJev: connectFn } = deps;

  if (choice === 'claude') {
    return createClaudeJudge(complete, model);
  }

  // Try Jev.
  const jevConn = await connectFn().catch(() => undefined);

  if (choice === 'jev') {
    if (!jevConn) {
      throw new Error(
        `resolveJudge: --judge jev was requested but the 'jev' MCP server is not ` +
          `configured or failed to connect. Configure it in ~/.afk/config/mcp.json ` +
          `or use --judge claude to stay within Anthropic.`,
      );
    }
  }

  if (jevConn) {
    const jevJudge = createJevJudge({ callTool: jevConn.callTool });
    // Attach close() to the returned judge so callers can tear down cleanly.
    return {
      ...jevJudge,
      close: jevConn.close.bind(jevConn),
    };
  }

  // 'auto' fallback: Jev unavailable, fall back to Claude.
  return createClaudeJudge(complete, model);
}
