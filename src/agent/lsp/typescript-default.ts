/**
 * Local TypeScript `ServerDefinition` + spec builders used by the two
 * existing LSP handlers until the registry lane (#4272 wave 2) replaces this
 * constant with a registry lookup. Keep everything TS-specific in this file.
 *
 * @module agent/lsp/typescript-default
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ServerDefinition, ServerSpec } from './server-spec.js';

/** Default LSP server command (binary + stdio flag). */
export const DEFAULT_LSP_CMD: readonly string[] = ['typescript-language-server', '--stdio'];

/** TS/JS server definition. The registry lane replaces this in wave 2. */
export const TYPESCRIPT_SERVER_DEFINITION: ServerDefinition = {
  language: 'typescript',
  languageIds: {
    '.ts': 'typescript',
    '.tsx': 'typescriptreact',
    '.js': 'javascript',
    '.jsx': 'javascriptreact',
  },
  rootMarkers: ['tsconfig.json', 'jsconfig.json', 'package.json'],
  binName: 'typescript-language-server',
  args: ['--stdio'],
};

/**
 * Build a `ServerSpec` from a command array. The default command resolves to
 * `source: 'path'`; anything else injected (tests, env) is `'override'`.
 */
export function typescriptSpecFromCommand(cmd: readonly string[]): ServerSpec {
  const [command = DEFAULT_LSP_CMD[0]!, ...args] = cmd;
  const isDefault = cmd === DEFAULT_LSP_CMD;
  return {
    definition: TYPESCRIPT_SERVER_DEFINITION,
    command,
    args,
    source: isDefault ? 'path' : 'override',
  };
}

/**
 * Nearest ancestor of `filePath` containing a TS root marker, else the file's
 * directory. Interim stand-in for the registry lane's resolver.
 */
export function typescriptRootFor(filePath: string): string {
  const start = path.dirname(filePath);
  let dir = start;
  for (;;) {
    for (const marker of TYPESCRIPT_SERVER_DEFINITION.rootMarkers) {
      if (existsSync(path.join(dir, marker))) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}
