/** Positive requirements shared by slash-command surfaces. No browser/TTY probing here. */
import type { SlashCommand } from './types.js';

export type SurfaceCapability =
  | 'tty'
  | 'choose'
  | 'progress'
  | 'sessionControl'
  | 'permissionMode'
  | 'conversationRetry'
  | 'hostCredentials'
  | 'shellJobs'
  | 'consoleOutput';

/**
 * Migration metadata for commands whose definitions still use REPL integrations.
 * Keep this beside the contract, not in a surface-specific deny-list. Explicit
 * definition metadata takes precedence (including [] for a migrated command).
 */
const LEGACY_REQUIREMENTS: Readonly<Record<string, readonly SurfaceCapability[]>> = {
  '/clear': ['sessionControl'],
  '/compact': ['sessionControl'],
  '/rewind': ['sessionControl', 'choose'],
  '/model': ['sessionControl'],
  '/name': ['sessionControl'],
  '/thinking': ['sessionControl'],
  '/fast': ['sessionControl'],
  '/plan': ['permissionMode'],
  '/afk': ['permissionMode'],
  '/retry': ['conversationRetry'],
  '/init': ['consoleOutput'],
  '/sh': ['shellJobs'],
  '/editor': ['tty'],
  '/copy': ['tty'],
  '/font-size': ['tty'],
  '/theme': ['tty'],
  '/ghost': ['tty'],
  '/suggestions': ['tty'],
  '/keys': ['tty'],
  '/tasks:view': ['tty'],
};

/** Portable commands need no declaration. Unknown commands are not inferred unsafe. */
export function commandRequirements(
  command: Pick<SlashCommand, 'name' | 'requires'>,
): readonly SurfaceCapability[] {
  return command.requires ?? LEGACY_REQUIREMENTS[command.name] ?? [];
}

/** Attach migration metadata once at registration, without changing portable objects. */
export function withCommandRequirements(command: SlashCommand): SlashCommand {
  if (command.requires !== undefined) return command;
  const requires = LEGACY_REQUIREMENTS[command.name];
  return requires ? { ...command, requires } : command;
}

export function missingCapabilities(
  command: Pick<SlashCommand, 'name' | 'requires'>,
  provided: ReadonlySet<SurfaceCapability>,
): SurfaceCapability[] {
  return commandRequirements(command).filter((capability) => !provided.has(capability));
}

/** Fresh set per context: callers cannot mutate another session's declaration. */
export function webCapabilities(): ReadonlySet<SurfaceCapability> {
  return new Set<SurfaceCapability>(['sessionControl', 'choose', 'progress']);
}

export function capabilityReason(capability: SurfaceCapability): string {
  switch (capability) {
    case 'choose': return 'requires choice interaction support';
    case 'progress': return 'requires progress reporting support';
    case 'tty': return 'requires terminal interaction; use the REPL or browser-native controls';
    case 'sessionControl': return 'requires session-control support';
    case 'permissionMode': return 'requires permission-mode integration; use the REPL for now';
    case 'conversationRetry': return 'requires conversation-retry support; resend your last message instead';
    case 'hostCredentials': return 'requires host credential management; re-authenticate from the REPL';
    case 'shellJobs': return 'requires the owning shell-job registry; use the REPL for now';
    case 'consoleOutput': return 'requires direct console output; use the REPL until output is portable';
  }
}

/**
 * Telegram chats drive a live per-chat session (reset, compact, model, name,
 * preferences) but have no terminal, readline, shell-job registry or console.
 * Fresh set per context, like webCapabilities().
 */
export function telegramCapabilities(): ReadonlySet<SurfaceCapability> {
  return new Set<SurfaceCapability>(['sessionControl']);
}
