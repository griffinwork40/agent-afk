// Invariant: this module is a LEAF (no imports). `permissions.ts` sits under
// every dispatcher and was import-cycle-free before operator denies existed;
// importing the resolver (which pulls tool schemas and CLI config tiers) from
// there dragged it into 100+ cycles. Keep matching logic here and the heavy
// resolver in `operator-denied.ts`.

/** Marker shared by the permission gate and the dispatcher denial formatter. */
export const OPERATOR_DENIED_MARKER = 'disabled by operator settings';

/** Model-facing reason for a tool the operator disabled via `tools.disabled`. */
export function operatorDeniedReason(toolName: string): string {
  return `Tool "${toolName}" is ${OPERATOR_DENIED_MARKER} (tools.disabled in afk.config.json).`;
}

/** Validate the only wildcard syntax supported by operator settings. */
export function isMcpDenyEntry(entry: string): boolean {
  return /^mcp__[^*]+__[^*]+$/.test(entry) || /^mcp__[^*]+__\*$/.test(entry);
}

/** Match exact names or an MCP server wildcard, never arbitrary globs. */
export function isToolDenied(name: string, denied: readonly string[] = []): boolean {
  return denied.some((entry) => entry === name || (
    isMcpDenyEntry(entry) && entry.endsWith('__*') && name.startsWith(entry.slice(0, -1))
  ));
}
