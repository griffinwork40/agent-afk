/**
 * Desktop computer-use tool env vars — the `desktop` category of `ENV_REGISTRY`.
 *
 * Extracted from `env.ts` following the same pattern as `env.browser.ts` to
 * keep that file within the 350-code-line ceiling.
 *
 * Contract: this file declares data only. It must never read `process.env`
 * (the single read-point stays `env.ts`, enforced by `pnpm audit:env:check`),
 * and it imports `EnvVarMeta` as a type only so there is no runtime cycle.
 *
 * NOTE ON AFK_DESKTOP_ALLOWED_APPS / AFK_DESKTOP_BLOCKED_APPS: the spec lists
 * these for Tranche 1, but no Tranche 1 code path reads them — the per-app
 * consent and block machinery ships in Tranche 2. Registering an env var that
 * nothing reads would be misleading and would trigger `scan:env:check` drift
 * warnings. They are therefore left for the tranche that actually reads them,
 * per the owner instruction "Register an env var only if code in this tranche
 * actually reads it."
 *
 * WSL2 detection vars (WSL_DISTRO_NAME, WSL_INTEROP) are registered here
 * because platform.ts reads them via the `env` object to produce the correct
 * WSL2 refusal message. They are OS-set, so `required: false` and no example.
 *
 * @module config/env.desktop
 */

import type { EnvVarMeta } from './env.js';

export const DESKTOP_ENV_REGISTRY = [
  {
    name: 'AFK_DESKTOP_ENABLED',
    description:
      'Enable the desktop computer-use tool group (`desktop_screenshot` and future ' +
      'input tools). Off by default. Set to `1` or `true` to opt in. The operator ' +
      'must separately grant macOS Screen Recording permission to the responsible ' +
      'process (typically the terminal app); no permission is automated. ' +
      'On Windows, requires a native interactive terminal session — WSL2 is not ' +
      'supported. Linux is not supported.',
    type: 'boolean',
    required: false,
    example: '1',
    category: 'misc',
  },
  {
    name: 'WSL_DISTRO_NAME',
    description:
      'Set by the WSL2 runtime to the name of the active Linux distribution ' +
      '(e.g. `Ubuntu`). Read by desktop tools to detect WSL2 and refuse with ' +
      'a clear message directing the user to a native Windows terminal. ' +
      'This var is OS-set; do not set it manually.',
    type: 'string',
    required: false,
    category: 'misc',
  },
  {
    name: 'WSL_INTEROP',
    description:
      'Set by the WSL2 runtime to the socket path used for Windows interop. ' +
      'Read by desktop tools alongside WSL_DISTRO_NAME to detect WSL2 and ' +
      'refuse with a clear message. This var is OS-set; do not set it manually.',
    type: 'string',
    required: false,
    category: 'misc',
  },
] as const satisfies readonly EnvVarMeta[];
