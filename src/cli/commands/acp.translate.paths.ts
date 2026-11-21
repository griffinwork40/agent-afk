import path from 'node:path';

export function inputRecord(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown> : {};
}

export function validPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\u0000');
}

/** Lexical display paths only: no filesystem access, containment or permission decision. */
export function resolveDisplayPath(value: unknown, cwd: string): string | undefined {
  if (!validPath(value)) return undefined;
  if (path.isAbsolute(value)) return path.normalize(value);
  if (!validPath(cwd) || !path.isAbsolute(cwd)) return undefined;
  return path.resolve(cwd, value);
}
