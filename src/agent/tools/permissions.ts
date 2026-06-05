/**
 * Tool permission gate.
 *
 * Allowlist-based permission checking for the session-level tool system.
 * Read-only tools are auto-allowed by default; write tools (bash, write_file,
 * edit_file) require explicit configuration.
 *
 * @module agent/tools/permissions
 */

export interface ToolPermissionConfig {
  allowedTools?: string[];
}

export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
}

export function checkToolPermission(
  toolName: string,
  config?: ToolPermissionConfig,
): PermissionCheckResult {
  if (!config?.allowedTools) {
    return { allowed: true };
  }

  const allowed = config.allowedTools.includes(toolName);
  if (!allowed) {
    return {
      allowed: false,
      reason: `Tool "${toolName}" is not in the configured allowlist`,
    };
  }
  return { allowed: true };
}
