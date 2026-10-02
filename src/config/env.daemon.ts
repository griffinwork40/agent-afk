/**
 * Daemon-specific env-registry entries extracted from env.ts to respect the
 * 350-code-line ceiling. Re-exported via the `...DAEMON_ENV_REGISTRY` spread
 * in the main ENV_REGISTRY array.
 *
 * @module config/env.daemon
 */

// ---------------------------------------------------------------------------
// Daemon builtin kill-switches
// ---------------------------------------------------------------------------

export const DAEMON_ENV_REGISTRY = [
  {
    name: 'AFK_TOOL_HEALTH_DISABLE',
    description:
      'Disable the tool-health daemon builtin entirely. Set to "1" to skip registration.',
    type: 'boolean',
    required: false,
    category: 'daemon',
  },
] as const;
