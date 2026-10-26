/**
 * Remote-dispatch branch for the `agent` tool.
 *
 * When the caller passes `host`, the executor routes the subagent to a remote
 * machine via `RemoteSubagentHandle` / SSH transport instead of forking a
 * local `AgentSession`. This is the wiring from #3869 that connects the
 * `host` field (added to `AgentInput` and the tool schema) to the
 * `RemoteSubagentHandle` implementation shipped in the first slice.
 *
 * Guardrails honoured here:
 *   - `AFK_REMOTE_DEPTH` refusal (mirrors `remote_agent` handler — remote
 *     runs may not fan out to further remote agents).
 *   - `isolation:"worktree"` is incompatible with remote dispatch (a worktree
 *     is a LOCAL construct). Callers that set both get a clear error.
 *   - Risk class `high`: the `remote_agent` tool already carries that
 *     classification on the hook / permission layer; dispatching via `agent`
 *     with `host` inherits the same semantics because the underlying SSH
 *     transport is identical.
 *
 * @module agent/tools/subagent-executor.execute-once.remote
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { AgentInput } from './subagent/input-parse.js';
import type { ToolResult } from './types.js';
import {
  isRemoteRun,
  neutraliseRemoteOutput,
  MAX_REPLY_CHARS,
} from './handlers/remote-agent.js';
import { loadHosts, resolveHost } from '../../remote/hosts.js';
import { readUnlockPassword } from '../../remote/keychain-unlock.js';
import { defaultSshRunner } from '../../remote/ssh-runner.js';
import { runRemoteAgent, type RemoteRunOutcome } from '../../remote/remote-run.js';
import type { RemoteHost } from '../../remote/hosts.js';
import { errorMessage } from '../../utils/errors.js';

// ---------------------------------------------------------------------------
// Internal helpers (mirrors remote-agent.ts, kept local to avoid circular dep)
// ---------------------------------------------------------------------------

function fail(message: string): ToolResult {
  return { content: `agent[host]: ${message}`, isError: true };
}

function frameRemote(text: string): string {
  return `<remote-output>\n${neutraliseRemoteOutput(text)}\n</remote-output>`;
}

/** @internal Exported for unit-testing lost/aborted outcome formatting without SSH. */
export function formatRemoteOutcome(
  outcome: RemoteRunOutcome,
  host: RemoteHost,
  runId: string,
  sessionId: string,
): ToolResult {
  const where = `host=${host.name} session=${sessionId} run=${runId}`;
  if (outcome.kind === 'aborted') {
    return fail(`aborted; the remote run was stopped (${where}).`);
  }
  if (outcome.kind === 'error' || outcome.kind === 'lost') {
    const partial = outcome.partial
      ? `\n\nPartial output:\n${frameRemote(outcome.partial.slice(0, 4000))}`
      : '';
    const lostNote =
      outcome.kind === 'lost'
        ? ` The run continues on the remote: ~/.afk/state/remote-runs/${runId}/out.ndjson.`
        : '';
    const reason = outcome.reason.replace(/\.+$/, '');
    const detail = outcome.remoteDetail
      ? `: ${frameRemote(outcome.remoteDetail)}`
      : '';
    return fail(`${reason}${detail}.${lostNote} (${where})${partial}`);
  }
  // kind === 'done'
  const footer = `\n\n[agent[host]: ${where}; pass resume="${sessionId}" to continue there]`;
  const rawReply =
    outcome.message.trim() === ''
      ? '(remote agent finished with an empty reply)'
      : outcome.message;
  const truncated = rawReply.length > MAX_REPLY_CHARS;
  const clipped = truncated
    ? `${rawReply.slice(0, MAX_REPLY_CHARS)}\n… [truncated at ${MAX_REPLY_CHARS} chars]`
    : rawReply;
  const reply = frameRemote(clipped);
  if (truncated) return { content: `${reply}${footer}`, truncated: true };
  return { content: `${reply}${footer}` };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Execute a remote subagent dispatch when `parsed.host` is set.
 *
 * Called from `executeOnce` after the depth / budget gates pass but before
 * the local `buildChildConfig` / `forkSubagent` path. The caller is
 * responsible for releasing any pre-acquired budget receipt before calling
 * this function (remote runs do not consume local delegation budget).
 *
 * Injectable deps are accepted as an optional second arg for testing with a
 * fake SSH runner (zero real SSH). Production callers omit `deps`.
 */
export interface RemoteAgentDispatchDeps {
  runner?: typeof defaultSshRunner;
  loadHostsFn?: () => Promise<Record<string, import('../../remote/hosts.js').RemoteHost>>;
  readUnlockPasswordFn?: typeof readUnlockPassword;
}

export async function executeRemoteAgentDispatch(
  parsed: Pick<AgentInput, 'host' | 'prompt' | 'model' | 'isolation' | 'cwd'>,
  signal: AbortSignal,
  deps: RemoteAgentDispatchDeps = {},
): Promise<ToolResult> {
  const hostArg = parsed.host!; // caller guards this

  // AFK_REMOTE_DEPTH refusal: mirrors remote_agent handler.
  if (isRemoteRun()) {
    return fail(
      'refused: this session is itself a remote run (AFK_REMOTE_DEPTH is set); ' +
        'remote agents cannot fan out to further remote agents.',
    );
  }

  // isolation:"worktree" is a local construct — incompatible with remote.
  if (parsed.isolation === 'worktree') {
    return fail(
      'isolation:"worktree" is incompatible with `host` — worktrees are local. ' +
        'Omit isolation when dispatching to a remote host.',
    );
  }

  // Resolve host via hosts.json (or literal ssh target).
  const hostsLoader = deps.loadHostsFn ?? (() => loadHosts());
  let host: RemoteHost;
  try {
    host = resolveHost(hostArg, await hostsLoader());
  } catch (err) {
    return fail(errorMessage(err));
  }

  // Keychain unlock (hosts with unlockKeychain: true).
  let keychainPassword: string | undefined;
  if (host.unlockKeychain === true) {
    const readPw = deps.readUnlockPasswordFn ?? readUnlockPassword;
    try {
      keychainPassword = await readPw(host.name);
    } catch (err) {
      return fail(errorMessage(err));
    }
  }

  const runId = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
  const sessionId = randomUUID();

  const outcome = await runRemoteAgent(
    {
      target: host.ssh,
      hostName: host.name,
      prompt: parsed.prompt,
      runId,
      sessionId,
      ...(keychainPassword !== undefined ? { keychainPassword } : {}),
      ...(parsed.model !== undefined ? { model: parsed.model } : {}),
      ...((parsed.cwd ?? host.cwd) !== undefined ? { cwd: parsed.cwd ?? host.cwd } : {}),
      ...(host.afkPath !== undefined ? { afkPath: host.afkPath } : {}),
      ...(host.permissionMode !== undefined ? { permissionMode: host.permissionMode } : {}),
    },
    signal,
    { runner: deps.runner ?? defaultSshRunner },
  );

  return formatRemoteOutcome(outcome, host, runId, sessionId);
}
