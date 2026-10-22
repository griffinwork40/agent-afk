/** Adapt trusted per-call eligibility to the existing human elicitation surface. */
import { elicitationRouter } from '../../elicitation-router.js';
import type { InstallContext } from '../../lsp/server-spec.js';
import type { ToolHandlerContext } from '../types.js';

export function lspInstallContext(context?: ToolHandlerContext, signal?: AbortSignal): InstallContext {
  // An explicit dispatcher grant is required: the global router may belong to
  // a parent REPL or another session, so handler presence alone is insufficient.
  // A non-matching key also prevents hasHandler() from counting other sessions.
  const sessionKey = context?.sessionId ?? '';
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
