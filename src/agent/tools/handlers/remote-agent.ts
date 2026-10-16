/**
 * Handler for the `remote_agent` tool.
 *
 * Contract:
 *   - Refuses when `AFK_REMOTE_DEPTH` is set (non-empty, not "0"): this process
 *     is itself a remote run, and remote runs may not fan out to more hosts.
 *   - `host` resolves through `src/remote/hosts.ts` (registry, else literal
 *     validated ssh target). The per-call `cwd` beats the host's default.
 *   - Every failure is an `isError` result naming the host; a lost connection
 *     also names the remote run id and session id, since the run continues.
 *
 * @module agent/tools/handlers/remote-agent
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { ToolHandler, ToolResult } from '../types.js';
import { env } from '../../../config/env.js';
import { errorMessage } from '../../../utils/errors.js';
import { loadHosts, resolveHost, type RemoteHost } from '../../../remote/hosts.js';
import { runRemoteAgent, type RemoteRunOutcome } from '../../../remote/remote-run.js';
import { defaultSshRunner, type SshRunner } from '../../../remote/ssh-runner.js';
import { readUnlockPassword, type ReadUnlockPassword } from '../../../remote/keychain-unlock.js';

/** Reply characters returned before truncation. */
export const MAX_REPLY_CHARS = 100_000;
const ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

export interface RemoteAgentDeps {
  runner: SshRunner;
  loadHosts: () => Promise<Record<string, RemoteHost>>;
  /** Reads a host's stored login password from the local keychain (hosts with unlockKeychain). */
  readUnlockPassword?: ReadUnlockPassword;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

interface RemoteAgentInput {
  host: string;
  prompt: string;
  cwd?: string;
  model?: string;
  resume?: string;
}

function fail(message: string): ToolResult {
  return { content: `remote_agent: ${message}`, isError: true };
}

function optString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/** Validate raw tool input. Returns parsed input or an error result. */
export function parseRemoteAgentInput(raw: unknown): RemoteAgentInput | ToolResult {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const host = optString(obj, 'host');
  if (host === undefined) return fail('`host` must be a non-empty string.');
  const prompt = typeof obj['prompt'] === 'string' ? obj['prompt'] : '';
  if (prompt.trim() === '') return fail('`prompt` must be a non-empty string.');
  const input: RemoteAgentInput = { host, prompt };
  const cwd = optString(obj, 'cwd');
  if (cwd !== undefined) input.cwd = cwd;
  const model = optString(obj, 'model');
  if (model !== undefined) {
    if (model.startsWith('-')) return fail('`model` may not start with "-".');
    input.model = model;
  }
  const resume = optString(obj, 'resume');
  if (resume !== undefined) {
    if (!ID_PATTERN.test(resume) || resume.startsWith('-')) return fail('`resume` must be a session id.');
    input.resume = resume;
  }
  return input;
}

/** True when this process was itself launched by remote_agent. */
export function isRemoteRun(): boolean {
  const depth = (env.AFK_REMOTE_DEPTH ?? '').trim();
  return depth !== '' && depth !== '0';
}

function formatOutcome(outcome: RemoteRunOutcome, host: RemoteHost, runId: string, sessionId: string): ToolResult {
  const where = `host=${host.name} session=${sessionId} run=${runId}`;
  if (outcome.kind === 'aborted') return fail(`aborted; the remote run was stopped (${where}).`);
  if (outcome.kind === 'error' || outcome.kind === 'lost') {
    const partial = outcome.partial ? `\n\nPartial output:\n${outcome.partial.slice(0, 4000)}` : '';
    const lostNote = outcome.kind === 'lost'
      ? ` The run continues on the remote: ~/.afk/state/remote-runs/${runId}/out.ndjson.`
      : '';
    const reason = outcome.reason.replace(/\.+$/, '');
    return fail(`${reason}.${lostNote} (${where})${partial}`);
  }
  const footer = `\n\n[remote_agent: ${where}; pass resume="${sessionId}" to continue there]`;
  const reply = outcome.message.trim() === '' ? '(remote agent finished with an empty reply)' : outcome.message;
  if (reply.length > MAX_REPLY_CHARS) {
    return { content: `${reply.slice(0, MAX_REPLY_CHARS)}\n… [truncated at ${MAX_REPLY_CHARS} chars]${footer}`, truncated: true };
  }
  return { content: `${reply}${footer}` };
}

export function createRemoteAgentHandler(deps: RemoteAgentDeps): ToolHandler {
  return async (raw, signal) => {
    if (isRemoteRun()) {
      return fail('refused: this session is itself a remote run (AFK_REMOTE_DEPTH is set); remote agents cannot dispatch further remote agents.');
    }
    const input = parseRemoteAgentInput(raw);
    if ('content' in input) return input;
    let host: RemoteHost;
    try {
      host = resolveHost(input.host, await deps.loadHosts());
    } catch (err) {
      return fail(errorMessage(err));
    }
    let keychainPassword: string | undefined;
    if (host.unlockKeychain === true) {
      try {
        keychainPassword = await (deps.readUnlockPassword ?? readUnlockPassword)(host.name);
      } catch (err) {
        return fail(errorMessage(err));
      }
    }
    const runId = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
    const sessionId = input.resume ?? randomUUID();
    const cwd = input.cwd ?? host.cwd;
    const permissionMode = host.permissionMode;
    const outcome = await runRemoteAgent(
      {
        target: host.ssh,
        hostName: host.name,
        prompt: input.prompt,
        ...(keychainPassword !== undefined ? { keychainPassword } : {}),
        runId,
        sessionId,
        ...(cwd !== undefined ? { cwd } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.resume !== undefined ? { resume: input.resume } : {}),
        ...(host.afkPath !== undefined ? { afkPath: host.afkPath } : {}),
        ...(permissionMode !== undefined ? { permissionMode } : {}),
      },
      signal,
      { runner: deps.runner, ...(deps.sleep ? { sleep: deps.sleep } : {}) },
    );
    return formatOutcome(outcome, host, runId, sessionId);
  };
}

export const remoteAgentHandler: ToolHandler = createRemoteAgentHandler({
  runner: defaultSshRunner,
  loadHosts: () => loadHosts(),
});
