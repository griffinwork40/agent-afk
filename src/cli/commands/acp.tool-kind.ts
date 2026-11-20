import type { ToolCallLocation, ToolKind } from './acp.wire.js';

/** Display classification only. The permission policy must also inspect the name. */
export function toolKind(_toolName: string): ToolKind {
  throw new Error('not implemented');
}

export function toolTitle(_toolName: string, _input?: unknown): string {
  throw new Error('not implemented');
}

export function toolLocations(_toolName: string, _input: unknown, _cwd: string): ToolCallLocation[] {
  throw new Error('not implemented');
}
