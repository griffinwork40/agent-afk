/**
 * Bidirectional JSON-RPC peer: the agent-to-client half of the ACP transport.
 * Outbound ids are `acp:N`; correlation is direction-specific (profile §1).
 *
 * @module cli/commands/acp.rpc-peer
 */
import type { AcpRpcPeer, AcpRpcPeerOptions, RpcFrame, RpcResponse } from './acp.wire.js';

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
  cleanup(): void;
}

/** Rejection for any outbound request or write on a closed peer (EOF, write failure, shutdown). */
export class AcpPeerClosedError extends Error {
  override name = 'AcpPeerClosedError';
  constructor(readonly reason: string) {
    super(`ACP peer closed: ${reason}`);
  }
}

/** Bidirectional correlation peer. A1 owns implementation and transport writes. */
export function createAcpRpcPeer(opts: AcpRpcPeerOptions): AcpRpcPeer {
  const pending = new Map<string, Pending>();
  let nextId = 1;
  let closedReason: string | undefined;
  let chain: Promise<void> = Promise.resolve();

  const closedError = (): Error => new AcpPeerClosedError(closedReason ?? 'closed');

  function close(reason?: string): void {
    if (closedReason !== undefined) return;
    closedReason = reason ?? 'closed';
    const all = [...pending.values()];
    pending.clear();
    for (const p of all) { p.cleanup(); p.reject(closedError()); }
  }

  // Invariant: writes are serialized so concurrent frames never interleave; a
  // failed write closes the peer, rejecting every outstanding outbound request.
  function write(frame: RpcFrame): Promise<void> {
    if (closedReason !== undefined) return Promise.reject(closedError());
    const next = chain.then(async () => {
      if (closedReason !== undefined) throw closedError();
      try {
        await opts.write(frame);
      } catch (err) {
        close('write failed');
        throw err instanceof Error ? err : new Error('write failed');
      }
    });
    chain = next.catch(() => undefined);
    return next;
  }

  function request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (closedReason !== undefined) return Promise.reject(closedError());
    if (signal?.aborted) return Promise.reject(new Error('ACP request aborted'));
    const id = `acp:${nextId++}`;
    return new Promise<unknown>((resolve, reject) => {
      const onAbort = (): void => {
        if (!pending.delete(id)) return;
        reject(new Error('ACP request aborted'));
      };
      const cleanup = (): void => signal?.removeEventListener('abort', onAbort);
      pending.set(id, {
        resolve: (v) => { cleanup(); resolve(v); },
        reject: (e) => { cleanup(); reject(e); },
        cleanup,
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      write({ jsonrpc: '2.0', id, method, params }).catch((err: unknown) => {
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        p.reject(err instanceof Error ? err : new Error('write failed'));
      });
    });
  }

  function handleResponse(frame: RpcResponse): boolean {
    if (typeof frame.id !== 'string') return false;
    const p = pending.get(frame.id);
    if (!p) return false;
    pending.delete(frame.id);
    if ('error' in frame && frame.error !== undefined) {
      p.reject(new Error(`ACP client error ${String(frame.error.code)}`));
    } else {
      p.resolve(frame.result);
    }
    return true;
  }

  return {
    request,
    notify: (method, params) => write({ jsonrpc: '2.0', method, params }),
    handleResponse,
    close,
  };
}
