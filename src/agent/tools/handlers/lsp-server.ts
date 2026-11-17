/** Shared registry resolution for symbols, refactors and post-edit diagnostics. */
import path from 'node:path';
import { resolveServer } from '../../lsp/registry.js';
import { ensureServerInstalled } from '../../lsp/install.js';
import type { InstallContext, ResolveResult, ServerSpec } from '../../lsp/server-spec.js';

export interface LspServerOptions {
  sessionRoot?: string;
  /** Explicit command override for fake servers; never a production default. */
  serverCmd?: readonly string[];
  /** Omit for read-only resolution (diagnostics must never install or prompt). */
  installContext?: InstallContext;
}

export type LspServerResult =
  | { kind: 'resolved'; spec: ServerSpec; root: string }
  | { kind: 'unavailable'; error: string };

/** Keep external read-root files local rather than assigning an unrelated cwd. */
function boundedRoot(filePath: string, sessionRoot?: string): string {
  const dir = path.dirname(path.resolve(filePath));
  if (!sessionRoot) return dir;
  const root = path.resolve(sessionRoot);
  const relative = path.relative(root, dir);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
    ? root : dir;
}

function missingMessage(result: Extract<ResolveResult, { kind: 'missing' }>): string {
  return `${result.definition.binName} is not installed. ` +
    (result.definition.install
      ? 'Run code_symbols from an interactive session to approve installation.'
      : 'Install this language server on PATH manually.');
}

/** Registry roots/specs are shared by every query, including command overrides. */
export async function resolveLspServer(filePath: string, options: LspServerOptions = {}): Promise<LspServerResult> {
  if (options.installContext?.signal?.aborted) return { kind: 'unavailable', error: 'Aborted' };
  const root = boundedRoot(filePath, options.sessionRoot);
  const result = await resolveServer(filePath, root);
  if (result.kind === 'unsupported') {
    return { kind: 'unavailable', error: `Unsupported file type: ${path.extname(filePath)}` };
  }
  const definition = result.kind === 'resolved' ? result.spec.definition : result.definition;
  if (options.serverCmd !== undefined) {
    const [command, ...args] = options.serverCmd;
    if (!command) return { kind: 'unavailable', error: 'Empty LSP server command' };
    return { kind: 'resolved', root: result.root, spec: { definition, command, args, source: 'override' } };
  }
  if (result.kind === 'resolved') return result;
  if (!options.installContext) return { kind: 'unavailable', error: missingMessage(result) };
  const installed = await ensureServerInstalled(definition, options.installContext);
  if (options.installContext.signal?.aborted) return { kind: 'unavailable', error: 'Aborted' };
  switch (installed.kind) {
    case 'installed': {
      // Installation success is not resolution: rediscover the binary and root
      // through the registry, retaining the original filesystem boundary.
      const resolved = await resolveServer(filePath, root);
      if (options.installContext.signal?.aborted) return { kind: 'unavailable', error: 'Aborted' };
      if (resolved.kind === 'resolved') return resolved;
      return { kind: 'unavailable', error: resolved.kind === 'missing'
        ? `Language server installation completed, but ${resolved.definition.binName} is still missing.`
        : `Language server installation completed, but file type is unsupported: ${path.extname(filePath)}` };
    }
    case 'declined': return { kind: 'unavailable', error: 'Language server installation declined' };
    case 'refused-unattended': return { kind: 'unavailable', error: `Language server installation requires human consent. ${missingMessage(result)}` };
    case 'no-recipe': return { kind: 'unavailable', error: missingMessage(result) };
    case 'failed': return { kind: 'unavailable', error: `Language server installation failed: ${installed.reason}` };
  }
}
