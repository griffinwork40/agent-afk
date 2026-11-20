import type { AcpClientPeer, LoadSessionRequest } from './acp.wire.js';
import type { AcpSessionHandle, AcpSessionOptions } from './acp.session.js';

/** Restore only. A1 calls replayHistory before replying to load, never for resume. */
export function loadAcpSession(
  _params: LoadSessionRequest, _opts: AcpSessionOptions,
): Promise<AcpSessionHandle> {
  throw new Error('not implemented');
}

/** Resolve the opaque ACP id to its journal, emit display history in order. */
export function replayHistory(_sessionId: string, _peer: AcpClientPeer): Promise<void> {
  throw new Error('not implemented');
}
