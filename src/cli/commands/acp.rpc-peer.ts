import type { AcpRpcPeer, AcpRpcPeerOptions } from './acp.wire.js';

/** Bidirectional correlation peer. A1 owns implementation and transport writes. */
export function createAcpRpcPeer(_opts: AcpRpcPeerOptions): AcpRpcPeer {
  throw new Error('not implemented');
}
