/** Adapt trusted per-call eligibility to the existing human elicitation surface. */
import { randomUUID } from 'node:crypto';
import { elicitationRouter } from '../../elicitation-router.js';
import type { InstallContext } from '../../lsp/server-spec.js';
import type { ToolHandlerContext } from '../types.js';

export function lspInstallContext(context?: ToolHandlerContext, signal?: AbortSignal): InstallContext {
  // An explicit dispatcher grant is required: the global router may belong to
  // a parent REPL or another session, so handler presence alone is insufficient.
  // A non-matching key also prevents hasHandler() from counting other sessions.
  // Invariant: a missing sessionId must never collide with another session's
  // key. An empty string would match a ''-keyed handler from a concurrent
  // session that also lacks a sessionId, so use a per-call unique sentinel.
  const sessionKey = context?.sessionId ?? `__no-session-${randomUUID()}`;
  const interactive = context?.lspInstallAllowed === true && elicitationRouter.hasHandler(sessionKey);
  return {
    interactive,
    ...(signal ? { signal } : {}),
    ...(interactive ? { askConsent: async (prompt: string): Promise<boolean> => {
      const result = await elicitationRouter.route({
        serverName: 'agent', origin: 'agent', type: 'confirm',
        title: 'Install language server', message: prompt, questionDefault: false,
      }, {
        signal: signal ?? new AbortController().signal,
        sessionKey,
        ...(context?.sessionId ? { sessionId: context.sessionId } : {}),
      });
      return result.action === 'accept' && result.content?.['value'] === true && !signal?.aborted;
    } } : {}),
  };
}
