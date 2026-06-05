/**
 * /allow-dir — manage session-level directory grant list.
 *
 * Usage:
 *   /allow-dir                   List current grants (resolveBase, readRoots, writeRoots)
 *   /allow-dir <path>            Add <path> to readRoots (read-only grant)
 *   /allow-dir --rw <path>       Add <path> to readRoots AND writeRoots
 *   /allow-dir --revoke <path>   Remove <path> from both lists
 *
 * Path is resolved to absolute via path.resolve(process.cwd(), <path>).
 * The initial resolveBase is non-revocable.
 *
 * @module cli/slash/commands/allow-dir
 */

import path from 'path';
import { statSync } from 'fs';
import type { SlashCommand } from '../types.js';

/**
 * Minimal interface the /allow-dir command needs from the provider/dispatcher.
 * Using a structural interface keeps this module from importing the concrete
 * provider class (which would create a circular dep concern) and makes testing
 * easy with a plain mock object.
 */
export interface GrantManager {
  addReadRoot(absPath: string, source: 'slash' | 'tool', sessionId?: string): void;
  addWriteRoot(absPath: string, source: 'slash' | 'tool', sessionId?: string): void;
  revokeRoot(absPath: string, source: 'slash' | 'tool', sessionId?: string): void;
  getGrants(): { resolveBase: string | undefined; readRoots: string[]; writeRoots: string[] };
}

let grantManagerRef: GrantManager | undefined;

/** Called at REPL session boot to wire the live grant manager into this command. */
export function setAllowDirDispatcher(manager: GrantManager): void {
  grantManagerRef = manager;
}

export const allowDirCmd: SlashCommand = {
  name: '/allow-dir',
  summary: 'Manage per-session directory access grants for tool handlers',
  usage: '/allow-dir [--rw | --revoke] [<path>]',
  flags: ['--rw', '--revoke'] as const,

  async handler(ctx, args) {
    if (!grantManagerRef) {
      ctx.out.error('Directory grants not available in this session.');
      return 'continue';
    }

    const trimmed = args.trim();

    // Bare invocation — list current grants.
    if (!trimmed) {
      const grants = grantManagerRef.getGrants();
      ctx.out.line('  Session directory grants:');
      ctx.out.line(`    resolveBase : ${grants.resolveBase ?? '(none)'}`);
      ctx.out.line(`    readRoots   : ${grants.readRoots.length > 0 ? grants.readRoots.join(', ') : '(none)'}`);
      ctx.out.line(`    writeRoots  : ${grants.writeRoots.length > 0 ? grants.writeRoots.join(', ') : '(none)'}`);
      return 'continue';
    }

    // Parse flags.
    let mode: 'read' | 'write' | 'revoke' = 'read';
    let rest = trimmed;

    if (rest.startsWith('--rw ') || rest === '--rw') {
      mode = 'write';
      rest = rest.slice(5).trim();
    } else if (rest.startsWith('--revoke ') || rest === '--revoke') {
      mode = 'revoke';
      rest = rest.slice(9).trim();
    }

    if (!rest) {
      ctx.out.error('Usage: /allow-dir [--rw | --revoke] <path>');
      return 'continue';
    }

    // Resolve path.
    const absPath = path.resolve(process.cwd(), rest);

    // Verify path exists on disk (for grant operations — not for revoke).
    if (mode !== 'revoke') {
      try {
        statSync(absPath);
      } catch {
        ctx.out.error(`Path does not exist: ${absPath}`);
        return 'continue';
      }
    }

    // Capture the active sessionId (may be undefined if no query has run yet)
    // so the audit log can attribute the grant to a session.
    const sessionId = ctx.stats.sessionId;

    // Apply grant / revoke. Revoking the initial resolveBase is silently
    // refused at the provider level (see ensureSharedRoots / revokeRoot guard);
    // emit a clear UI message instead of the generic "revoked" confirmation.
    if (mode === 'revoke') {
      const beforeGrants = grantManagerRef.getGrants();
      grantManagerRef.revokeRoot(absPath, 'slash', sessionId);
      if (beforeGrants.resolveBase && absPath === beforeGrants.resolveBase) {
        ctx.out.warn(`Cannot revoke the session's initial resolveBase: ${absPath}`);
      } else {
        ctx.out.line(`✓ Revoked: ${absPath}`);
      }
    } else if (mode === 'write') {
      grantManagerRef.addWriteRoot(absPath, 'slash', sessionId);
      ctx.out.line(`✓ Read+write grant: ${absPath}`);
    } else {
      grantManagerRef.addReadRoot(absPath, 'slash', sessionId);
      ctx.out.line(`✓ Read-only grant: ${absPath}`);
    }

    return 'continue';
  },
};
