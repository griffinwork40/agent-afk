import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { loadHooksConfig, type LoadHooksConfigOptions } from '../hooks/config-loader.js';
import type { HarnessHookEvent } from '../hooks.js';

export interface RuntimeConfiguredHook {
  event: HarnessHookEvent;
  matcher?: string;
  source: 'user-global' | 'project-local' | 'plugin' | 'unknown';
  pluginName?: string;
  type: 'command';
  timeoutMs: number;
  commandFingerprint: string;
  executableBasename?: string;
}

export interface RuntimeHooks {
  /** Resolved disk configuration, not a claim that these hooks are registered. */
  configured: RuntimeConfiguredHook[];
  userGlobalEnabled: boolean;
  allowProjectHooks: boolean;
  pluginHooksEnabled: boolean;
  /** Warning text is deliberately omitted: parser errors can contain secrets. */
  warningCount: number;
  builtinListing: 'unavailable';
}

// Invariant: this is not a shell parser. Only an unquoted literal first token
// is eligible; never return arguments, assignments, expansions or shell syntax.
const SHELL_WORDS = new Set([
  'export', 'declare', 'typeset', 'local', 'readonly', 'set', 'unset',
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done',
  'case', 'esac', 'function', 'in', 'select', 'time', 'coproc',
]);

export function commandExecutableBasename(command: string): string | undefined {
  const token = command.trimStart().split(/\s/, 1)[0];
  if (!token || !/^[A-Za-z0-9_./-]+$/.test(token) || token.startsWith('-') || SHELL_WORDS.has(token)) {
    return undefined;
  }
  const name = posix.basename(token);
  return name && name !== '.' && name !== '..' ? name : undefined;
}

/** Reuse the session loader and project its output through an explicit allowlist. */
export function gatherHooks(opts: LoadHooksConfigOptions): RuntimeHooks {
  let loaded;
  try {
    loaded = loadHooksConfig(opts);
  } catch {
    // Never propagate an exception containing config bytes or raw command text.
    throw new Error('Unable to load hook configuration for the hooks view.');
  }
  const configured: RuntimeConfiguredHook[] = [];
  for (const [event, groups] of Object.entries(loaded.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        const executableBasename = commandExecutableBasename(hook.command);
        configured.push({
          event: event as HarnessHookEvent,
          ...(group.matcher !== undefined ? { matcher: group.matcher } : {}),
          source: group.tier ?? 'unknown',
          ...(hook.pluginName !== undefined ? { pluginName: hook.pluginName } : {}),
          type: hook.type,
          timeoutMs: hook.timeoutMs,
          commandFingerprint: createHash('sha256').update(hook.command).digest('hex').slice(0, 12),
          ...(executableBasename !== undefined ? { executableBasename } : {}),
        });
      }
    }
  }
  return {
    configured,
    userGlobalEnabled: loaded.userGlobalEnabled,
    allowProjectHooks: loaded.allowProjectHooks,
    pluginHooksEnabled: loaded.pluginHooksEnabled,
    warningCount: loaded.warnings.length,
    // The live registry exposes neither names nor provenance; do not invent it.
    builtinListing: 'unavailable',
  };
}
