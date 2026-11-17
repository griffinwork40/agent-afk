/** Sanitize LSP symbol results: never expose server-provided locations outside read policy. */
import { fileURLToPath } from 'node:url';
import type { ToolHandlerContext } from '../types.js';
import { resolveAndContain } from './_cwd-utils.js';

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function symbolRows(raw: unknown, uri: string | undefined, context?: ToolHandlerContext, cwd?: string) {
  const rows: Array<{ name: string; kind: number; file_path: string; line: number; col: number; depth: number }> = [];
  function visit(items: unknown, depth: number): void {
    if (!Array.isArray(items) || depth > 32 || rows.length >= 1000) return;
    for (const item of items) {
      if (rows.length >= 1000) break;
      const sym = record(item);
      if (!sym || typeof sym['name'] !== 'string' || typeof sym['kind'] !== 'number') continue;
      const location = record(sym['location']);
      const targetUri = location?.['uri'] ?? uri;
      const range = record(location?.['range'] ?? sym['selectionRange'] ?? sym['range']);
      const start = record(range?.['start']);
      if (typeof targetUri !== 'string' || !start ||
          !Number.isInteger(start['line']) || !Number.isInteger(start['character']) ||
          (start['line'] as number) < 0 || (start['character'] as number) < 0) continue;
      try {
        const file_path = resolveAndContain(fileURLToPath(targetUri), context, 'read', cwd);
        rows.push({ name: sym['name'], kind: sym['kind'], file_path,
          line: (start['line'] as number) + 1, col: (start['character'] as number) + 1, depth });
        visit(sym['children'], depth + 1);
      } catch { /* Out-of-policy and malformed URIs never surface. */ }
    }
  }
  visit(raw, 0);
  return rows;
}
