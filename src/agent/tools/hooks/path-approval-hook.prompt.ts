/**
 * Elicitation prompt logic for the path-approval hook.
 *
 * Extracted from `path-approval-hook.ts` to keep that file within the
 * 350-code-line ceiling. This module owns the three helpers that do not depend
 * on the shared `PathApprovalState` closure:
 *   - `extractCandidatePath` — pull the first path from a tool-call input
 *   - `extractAllPaths` — pull all paths (for patch_apply display)
 *   - `promptForApproval` — issue the elicitation and translate the response
 *
 * All security-relevant gate ordering is preserved in the parent module
 * (`path-approval-hook.ts`); this module is called only after all containment
 * and subagent checks have passed.
 *
 * @module agent/tools/hooks/path-approval-hook.prompt
 */

import { elicitationRouter } from '../../elicitation-router.js';
import type { GrantManager } from '../grant-manager.js';
import { realpathSafe } from '../handlers/_cwd-utils.js';
import { appendGrant } from '../../permissions-store.js';
import type { HookDecision } from '../../hooks.js';
import { errorMessage } from '../../../utils/errors.js';
import type { PathApprovalState, PathApprovalSurface } from './path-approval-hook.js';

/**
 * Extract the path argument from a typed file-tool input. Returns undefined
 * when no path is present (e.g. glob without explicit `path`, which falls
 * back to cwd and is therefore inside the resolveBase).
 */
export function extractCandidatePath(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  // read_file / view_image / write_file / edit_file / json_query all use `file_path`.
  if (
    toolName === 'read_file' ||
    toolName === 'view_image' ||
    toolName === 'write_file' ||
    toolName === 'edit_file' ||
    toolName === 'json_query'
  ) {
    const p = input['file_path'];
    return typeof p === 'string' ? p : undefined;
  }
  // list_directory uses `path`.
  if (toolName === 'list_directory') {
    const p = input['path'];
    return typeof p === 'string' ? p : undefined;
  }
  // glob/grep — `path` is optional. When absent, the handler uses cwd which
  // is trusted; return undefined so we skip the prompt.
  if (toolName === 'glob' || toolName === 'grep') {
    const p = input['path'];
    return typeof p === 'string' ? p : undefined;
  }
  // patch_apply has a `changes` array; each element has a `path` field.
  // Path containment is enforced per-change by patch-validate.ts
  // (resolveAndContain). Return the first path to anchor the containment
  // check and grant flow; the full file list is shown in the approval prompt
  // via promptForApproval (which receives all paths via extractAllPaths).
  if (toolName === 'patch_apply') {
    const changes = input['changes'];
    if (Array.isArray(changes) && changes.length > 0) {
      const first = changes[0] as Record<string, unknown>;
      const p = first['path'];
      return typeof p === 'string' ? p : undefined;
    }
    return undefined;
  }
  return undefined;
}

/**
 * Extract all paths from a patch_apply input for display in the approval
 * prompt. For other tools, returns a single-element array (or empty).
 */
export function extractAllPaths(
  toolName: string,
  input: Record<string, unknown>,
): string[] {
  if (toolName === 'patch_apply') {
    const changes = input['changes'];
    if (!Array.isArray(changes)) return [];
    const paths: string[] = [];
    for (const change of changes) {
      const c = change as Record<string, unknown>;
      if (typeof c['path'] === 'string') paths.push(c['path']);
    }
    return paths;
  }
  const candidate = extractCandidatePath(toolName, input);
  return candidate !== undefined ? [candidate] : [];
}

export function pathApprovalKey(mode: 'read' | 'write', resolvedPath: string): string {
  return `${mode}:${resolvedPath}`;
}

/**
 * Issue the elicitation prompt and translate the response into a hook
 * decision + grant mutation.
 */
export async function promptForApproval(args: {
  toolName: string;
  resolvedPath: string;
  /** All paths in the patch (patch_apply only); used to build the prompt message. */
  allPaths?: string[];
  /** cwd captured at PreToolUse time; stored in the onceApproved entry. */
  capturedCwd: string | undefined;
  mode: 'read' | 'write';
  grantManager: GrantManager;
  state: PathApprovalState;
  surface: PathApprovalSurface;
  /** Turn/dispatch abort signal — cancels the pending prompt on teardown. */
  signal?: AbortSignal;
  /**
   * Session id of the session whose tool call triggered this prompt. Forwarded
   * into the router so the pending approval marks THIS session's presence file
   * as blocked-on-human. Optional — absent means no marker is written.
   */
  sessionId?: string;
}): Promise<HookDecision> {
  const { toolName, resolvedPath, allPaths, capturedCwd, mode, grantManager, state, surface, signal, sessionId } =
    args;

  // Show the symlink-resolved target when it differs from the displayed path so
  // the consent decision reflects the REAL destination — a workspace symlink
  // pointing outside (e.g. `./link -> /etc`) would otherwise be approved under
  // its innocuous symlink label. realpathSafe never throws (it resolves the
  // nearest existing ancestor for not-yet-created write targets).
  const realTarget = realpathSafe(resolvedPath);
  const realTargetSuffix = realTarget !== resolvedPath ? `\n  (resolves to: ${realTarget})` : '';

  // For patch_apply, show the full list of files being written so the operator
  // knows the complete scope of the operation, not just the first path.
  const pathsForDisplay =
    allPaths && allPaths.length > 1
      ? allPaths.map((p) => `  ${p}`).join('\n')
      : `  ${resolvedPath}${realTargetSuffix}`;
  const message =
    `Tool \`${toolName}\` wants to ${mode === 'write' ? 'WRITE to' : 'read'} ` +
    (allPaths && allPaths.length > 1
      ? `${allPaths.length} paths outside this session's granted roots:\n\n${pathsForDisplay}`
      : `a path outside this session's granted roots:\n\n${pathsForDisplay}`) +
    `\n\nChoose how to handle this and future requests for this path.`;

  // Form-mode elicitation with a single enum field, four choices. The REPL
  // and Telegram handlers know how to render this (REPL: numbered prompt;
  // Telegram: inline keyboard).
  const result = await elicitationRouter.route(
    {
      serverName: 'agent-afk',
      message,
      mode: 'form',
      title: 'Path access approval',
      requestedSchema: {
        type: 'object',
        properties: {
          choice: {
            type: 'string',
            title: 'Choose one',
            enum: ['once', 'session', 'persist', 'deny'],
            description:
              "'once' allows this single call only. 'session' allows this path until the session ends. " +
              "'persist' writes a grant to ~/.afk/config/permissions.json so future sessions inherit it. " +
              "'deny' blocks this call and returns an error to the model.",
          },
        },
        required: ['choice'],
      },
    },
    // The elicitation router has NO time-based deadline — a path-approval
    // prompt waits as long as the operator needs (the 5-min auto-decline was
    // deliberately removed; it cut off AFK operators who stepped away). The
    // hook's `longRunning` flag prevents the registry's 30s timeout from
    // firing, so the ONLY unblock-on-teardown path is the turn/dispatch
    // signal forwarded here. Falling back to a never-aborting signal (no
    // forwarded signal) preserves prior behavior for surfaces/tests that
    // dispatch without one.
    {
      signal: signal ?? new AbortController().signal,
      ...(sessionId !== undefined ? { sessionId } : {}),
    },
  );

  if (result.action !== 'accept') {
    const outcome = result.action === 'cancel' ? 'cancel' : 'block';
    // eslint-disable-next-line no-console
    console.error(
      `[path-approval] surface=${surface} tool=${toolName} path=${resolvedPath} outcome=${outcome}`,
    );
    return {
      decision: 'block',
      reason:
        result.action === 'cancel'
          ? `User cancelled the access prompt for ${resolvedPath}`
          : `User denied access to ${resolvedPath}`,
    };
  }

  const choice = String(result.content?.['choice'] ?? '').toLowerCase();
  const key = pathApprovalKey(mode, resolvedPath);

  switch (choice) {
    case 'once':
      // Add to grant lists so resolveAndContain passes, AND record in the
      // once-approved map so the PostToolUse hook revokes after the call.
      // Invariant: addReadRoot/addWriteRoot must precede the onceApproved
      // map write so an interleaved PostToolUse cannot revoke before the
      // pre-handler check sees the grant. Ordered-operation invariant per
      // AFK.md.
      //
      // capturedCwd is stored in the entry so postToolUseImpl can reconstruct
      // the key using the SAME cwd anchor even if opts.getCwd() drifts between
      // Pre and Post (M1 cwd-divergence fix).
      if (mode === 'write') {
        grantManager.addWriteRoot(resolvedPath, 'tool');
      } else {
        grantManager.addReadRoot(resolvedPath, 'tool');
      }
      state.onceApproved.set(key, { resolvedPath, mode, capturedCwd });
      // eslint-disable-next-line no-console
      console.error(
        `[path-approval] surface=${surface} tool=${toolName} path=${resolvedPath} outcome=once`,
      );
      return {};

    case 'session':
      // Mutate the in-memory grant lists (no persistence). Also cache the
      // (mode, path) key so subsequent calls in the same session don't
      // re-prompt even if the model passes the path through a different
      // tool that resolves to the same absolute.
      if (mode === 'write') {
        grantManager.addWriteRoot(resolvedPath, 'tool');
      } else {
        grantManager.addReadRoot(resolvedPath, 'tool');
      }
      state.sessionApproved.add(key);
      // eslint-disable-next-line no-console
      console.error(
        `[path-approval] surface=${surface} tool=${toolName} path=${resolvedPath} outcome=session`,
      );
      return {};

    case 'persist':
      // Same as session, plus write to ~/.afk/config/permissions.json.
      if (mode === 'write') {
        grantManager.addWriteRoot(resolvedPath, 'tool');
      } else {
        grantManager.addReadRoot(resolvedPath, 'tool');
      }
      state.sessionApproved.add(key);
      // eslint-disable-next-line no-console
      console.error(
        `[path-approval] surface=${surface} tool=${toolName} path=${resolvedPath} outcome=persist`,
      );
      try {
        appendGrant({
          path: resolvedPath,
          mode,
          decision: 'allow',
          source:
            surface === 'telegram'
              ? 'elicit:telegram'
              : surface === 'repl'
                ? 'elicit:repl'
                : surface === 'web'
                  ? 'elicit:web'
                  : 'elicit:unknown',
          reason: `Approved via ${surface} prompt for ${toolName}`,
        });
      } catch (err) {
        // Persistence is best-effort. We still honor the in-session grant —
        // the user already approved. Log to stderr; the dispatcher has no
        // structured logger here.
        // eslint-disable-next-line no-console
        console.error(
          `path-approval: failed to persist grant for ${resolvedPath}:`,
          errorMessage(err),
        );
      }
      return {};

    case 'deny':
    default:
      // eslint-disable-next-line no-console
      console.error(
        `[path-approval] surface=${surface} tool=${toolName} path=${resolvedPath} outcome=deny`,
      );
      return {
        decision: 'block',
        reason: `User denied access to ${resolvedPath}`,
      };
  }
}
