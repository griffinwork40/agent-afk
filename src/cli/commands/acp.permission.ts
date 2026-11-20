import type { AcpClientPeer, AcpPermissionGate, AcpPermissionOptions } from './acp.wire.js';

export function createAcpPermissionGate(
  _peer: AcpClientPeer, _sessionId: string, _opts: AcpPermissionOptions,
): AcpPermissionGate {
  throw new Error('not implemented');
}
