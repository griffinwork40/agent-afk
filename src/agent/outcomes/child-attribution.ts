/**
 * Child artifact attribution — PostToolUse hook.
 *
 * Forked children never write a session JSON sidecar, so their git commit
 * SHAs and gh pr create URLs are invisible to the parent's teardown pass.
 * This hook captures them at tool-call time via the shared hook registry.
 *
 * Mechanism: forked children inherit the parent's hook registry and set
 * `parentSessionId` on every PostToolUse context they dispatch. When a bash
 * tool result from a child (parentSessionId set) contains a commit SHA or
 * PR URL, this hook appends it to the ROOT session's outcome record.
 *
 * Root session id: for a single level of nesting, parentSessionId IS the root
 * id. For deeper nesting (grandchildren), the grandchild's parentSessionId is
 * the intermediate child — but the intermediate child also fires this same
 * hook on the root's registry (since all levels share the same registry),
 * so the root is always the context's eventual parent via registry inheritance.
 * We use parentSessionId directly as the attribution target, which correctly
 * attributes to the nearest parent; the nearest parent then attributes to its
 * parent if it is also a child, but that second hop fires on the grandparent's
 * registry which carries the root's session id. In practice single-level nesting
 * is the dominant case (worktree-isolated children created by the root).
 *
 * Safety: fire-and-forget, best-effort. Never throws into dispatch.
 * Races: appendArtifacts does a read-modify-write with atomic rename.
 *
 * @module agent/outcomes/child-attribution
 */

import type { HookHandler } from '../hooks.js';
import { appendArtifacts } from './store.js';
import { isPRCreateEvent, recoverCommitSHAs } from './artifacts.js';
import type { ToolEvent } from './artifacts.js';

// ---------------------------------------------------------------------------
// Hook factory
// ---------------------------------------------------------------------------

/**
 * Returns a PostToolUse hook that detects artifact-producing bash tool calls
 * from forked children (parentSessionId present) and appends any recovered
 * commits / PR URLs to the parent's outcome record.
 */
export function createChildAttributionHook(): HookHandler {
  return (context) => {
    // Only PostToolUse from forked children
    if (context.event !== 'PostToolUse') return {};
    if (!('parentSessionId' in context)) return {};
    if (!context.parentSessionId) return {};
    // Credit to the root session (depth-0). For depth-1 children rootSessionId
    // equals parentSessionId; for grandchildren rootSessionId skips the
    // intermediate session that never writes a sidecar.
    const parentSessionId = context.rootSessionId ?? context.parentSessionId;
    if (context.toolName !== 'bash') return {};
    if (context.isError === true) return {};

    // Build a minimal ToolEvent compatible with the artifact recovery logic
    const inputCmd =
      context.input !== undefined && typeof context.input === 'object' && context.input !== null
        ? (context.input as Record<string, unknown>)['command']
        : undefined;
    const inputStr = typeof inputCmd === 'string' ? inputCmd : '';
    const outputStr = typeof context.output === 'string' ? context.output : '';

    const ev: ToolEvent = {
      toolName: 'bash',
      input: inputStr,
      result: outputStr,
      isError: false,
    };

    // Check for commit SHAs
    const commits = recoverCommitSHAs([{ toolEvents: [ev] }]);

    // Check for PR creation
    const prs: string[] = [];
    if (isPRCreateEvent(ev)) {
      const PR_URL_RE = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/g;
      const matches = outputStr.match(PR_URL_RE);
      if (matches) prs.push(...matches);
    }

    if (commits.length === 0 && prs.length === 0) return {};

    // Fire-and-forget: append to parent's record
    void Promise.resolve().then(() => {
      try {
        appendArtifacts(parentSessionId, { commits, prs });
      } catch {
        // best-effort — never surface into dispatch
      }
    }).catch(() => {});

    return {};
  };
}
