/**
 * Opt-in read-only git surface for read-only children (#3754, item 2).
 *
 * `readonly-bash.ts` is a best-effort classifier, not a security boundary:
 * read-only children evaded it with obfuscated writes (`'write'+'FileSync'`
 * via node, a python heredoc `open(path,'w')`). Adding denylist patterns does
 * not converge. When `AFK_READONLY_GIT_TOOL` is enabled, every provider built
 * with the read-only bash gate (`readOnlyBash: true`) has `bash` swapped for
 * the structured `git_read` tool in its allowlist, and the dispatcher's
 * read-only gate refuses any `bash` call outright as a backstop. Flag off:
 * every function here is the identity, so behaviour is unchanged.
 *
 * @module agent/tools/readonly-git-surface
 */

import { env } from '../../config/env.js';
import { isExplicitlyEnabled } from '../../config/env-helpers.js';
import type { ToolPermissionConfig } from './permissions.js';
import type { AnthropicToolDef } from './types.js';
import { gitReadTool } from './schemas.git-read.js';
import { GIT_READ_SUBCOMMANDS } from './git-read.policy.js';

export const GIT_READ_TOOL_NAME = 'git_read';

/** True when `AFK_READONLY_GIT_TOOL` is set to 1/true/yes/on. Read live per call. */
export function isReadOnlyGitToolEnabled(): boolean {
  const raw = env.AFK_READONLY_GIT_TOOL;
  return raw !== undefined && isExplicitlyEnabled(raw);
}

/**
 * Replace `bash` with `git_read` in a tool list. A list without `bash` is
 * returned unchanged (copied): a read-only surface that never had a shell
 * gains nothing, preserving least privilege for narrow `tools:` declarations.
 */
export function swapBashForGitRead(tools: readonly string[]): string[] {
  if (!tools.includes('bash')) return [...tools];
  const out = tools.filter((t) => t !== 'bash');
  if (!out.includes(GIT_READ_TOOL_NAME)) out.push(GIT_READ_TOOL_NAME);
  return out;
}

/**
 * Provider-construction transform. Applies {@link swapBashForGitRead} to the
 * allowlist when the flag is on AND the provider carries the read-only bash
 * gate. Returns `permissions` unchanged (same reference) otherwise, including
 * an undefined allowlist (that case is covered by the dispatcher backstop).
 */
export function applyReadOnlyGitPermissions(
  permissions: ToolPermissionConfig | undefined,
  readOnlyBash: boolean | undefined,
): ToolPermissionConfig | undefined {
  if (readOnlyBash !== true || permissions?.allowedTools === undefined || !isReadOnlyGitToolEnabled()) return permissions;
  return { ...permissions, allowedTools: swapBashForGitRead(permissions.allowedTools) };
}

/** Model-visible denial for a `bash` call on a read-only surface while the flag is on. */
export const READONLY_BASH_DISABLED_REASON =
  'Bash is disabled for read-only agents (AFK_READONLY_GIT_TOOL). Use git_read for git ' +
  `(${GIT_READ_SUBCOMMANDS.join('/')}) and read_file/grep/glob/list_directory ` +
  'for files. If the task needs a shell or a write, stop and report that to your caller.';

/**
 * Denial override for the static allowlist gate. With the flag on, the swap
 * removes `bash` from a read-only surface's allowlist, so a `bash` call dies
 * at the permission check with the generic "not in the configured allowlist"
 * text, BEFORE the read-only bash gate that carries
 * {@link READONLY_BASH_DISABLED_REASON}. Returns that reason in exactly that
 * case so the model learns about git_read on its first denied call;
 * `undefined` (keep the generic reason) otherwise.
 */
export function readOnlyBashDenialOverride(toolName: string, readOnlyBash: boolean): string | undefined {
  return toolName === 'bash' && readOnlyBash && isReadOnlyGitToolEnabled() ? READONLY_BASH_DISABLED_REASON : undefined;
}

/**
 * Invariant: the tool grant and the agent's BELIEF about its tools must change
 * together (see `withRegistryGrants` in agents/builtins.ts). The swap above
 * changes the grant at provider construction; this note changes the belief for
 * a byte-pinned vendored prompt that still says "You have Bash". Appended at
 * registry composition only while the flag is on, so the flag-off prompt is
 * byte-identical.
 */
export function withGitReadSubstitution(body: string): string {
  if (!isReadOnlyGitToolEnabled()) return body;
  return `${body}

## Tool substitution by this runtime

Bash is NOT available. This runtime replaces it with the structured \`git_read\` tool, superseding any earlier statement that you have Bash or may pipe output. Read, Grep, and Glob are unchanged.

- \`subcommand\`: one of ${GIT_READ_SUBCOMMANDS.join(', ')}.
- \`args\`: allowlisted flags and revisions only. \`paths\`: file paths (git_read inserts \`--\` itself).
- Example: \`git log -n 5 --oneline -- src/x.ts\` becomes \`{"subcommand":"log","args":["--max-count=5","--oneline"],"paths":["src/x.ts"]}\`.
- Example: \`git grep -n foo HEAD -- src/\` becomes \`{"subcommand":"grep","pattern":"foo","args":["-n","HEAD"],"paths":["src/"]}\`.
- A rejection names the allowed options. Do not retry the same shape.`;
}

/**
 * Schemas to append to a provider's builtin list: `[gitReadTool]` while the
 * flag is on, `[]` otherwise (default surface byte-identical). Evaluated at
 * provider construction.
 */
export function readOnlyGitSchemas(): AnthropicToolDef[] {
  return isReadOnlyGitToolEnabled() ? [gitReadTool] : [];
}
