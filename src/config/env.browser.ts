/**
 * Browser-control tool env vars — the `browser` category of `ENV_REGISTRY`.
 *
 * Extracted from `env.ts` to keep that file within the 350-code-line ceiling
 * (issue #2206). `env.ts` spreads this tuple into `ENV_REGISTRY` at the same
 * position the entries used to occupy, so registry order, the derived
 * `EnvObject` / `EnvVarName` types, and the rendered `docs/env-registry.*`
 * are all unchanged.
 *
 * Contract: this file declares data only. It must never read `process.env`
 * (the single read-point stays `env.ts`, enforced by `pnpm audit:env:check`),
 * and it imports `EnvVarMeta` as a type only so there is no runtime cycle.
 *
 * @module config/env.browser
 */

import type { EnvVarMeta } from './env.js';

export const BROWSER_ENV_REGISTRY = [
  {
    name: 'AFK_BROWSER_HEADLESS',
    description:
      'Override the default headless mode for native browser-control tools. ' +
      '`1`/`true` forces headless; `0`/`false` forces headed. When unset the default is ' +
      'headless on every AFK surface — the CLI entrypoint reports surface `afk`, which is ' +
      'in the headless set — so watching the agent work in a visible window is opt-in via ' +
      '`AFK_BROWSER_HEADLESS=0`, not implied by running the REPL. Note headed and headless ' +
      'use different chromium downloads (`chromium-*` vs `chromium_headless_shell-*`).',
    type: 'boolean',
    required: false,
    example: '1',
    category: 'browser',
  },
  {
    name: 'AFK_BROWSER_ALLOWED_DOMAINS',
    description:
      'Comma-separated allowlist of URL host globs. When set, browser_open and any ' +
      'navigation that targets a host outside the list returns status: blocked_by_policy. ' +
      'Unset means no allowlist (permissive). Patterns use simple `*` glob ' +
      'matching against the URL host. Combines with AFK_BROWSER_BLOCKED_DOMAINS — block wins.',
    type: 'string',
    required: false,
    example: 'github.com,*.atlassian.net',
    category: 'browser',
  },
  {
    name: 'AFK_BROWSER_BLOCKED_DOMAINS',
    description:
      'Comma-separated blocklist of URL host globs. Browser navigation that matches any ' +
      'entry returns status: blocked_by_policy regardless of the allowlist.',
    type: 'string',
    required: false,
    example: '*.ads.example.com',
    category: 'browser',
  },
  {
    name: 'AFK_BROWSER_DOM_SNAPSHOTS',
    description:
      'Phase 2 opt-in: when set to 1, every browser_act writes a gzipped DOM snapshot ' +
      'sidecar under ~/.afk/state/witness/<sid>/browser/dom-snapshots/. Off by default ' +
      'because snapshots are large; useful for post-mortem analysis of failed actions.',
    type: 'boolean',
    required: false,
    example: '1',
    category: 'browser',
  },
  {
    name: 'AFK_BROWSER_BACKEND',
    description:
      'Browser provider backend: auto (default, prefer Agent Browser, fall back to Playwright), ' +
      'agent-browser (require Agent Browser), or playwright (headless only).',
    type: 'string',
    required: false,
    default: 'auto',
    example: 'agent-browser',
    category: 'browser',
  },
  {
    name: 'AFK_BROWSER_CONFIG',
    description:
      'Absolute path to an alternate browser config file. Overrides the default ' +
      '~/.afk/config/browser.json lookup. Useful for per-project overrides in CI.',
    type: 'string',
    required: false,
    example: '/path/to/browser.json',
    category: 'browser',
  },
  {
    name: 'AFK_BROWSER_DEFAULT_PROFILE',
    description:
      'Name of the persistent session-vault profile the agent reuses for browser ' +
      'sessions. The context restores its login from (and saves it back to) ' +
      '~/.afk/state/browser/<profile>/storageState.json, so a human runs ' +
      '`afk browser login --profile <name>` once and the agent reuses that ' +
      'authenticated session across unattended runs. Unset defaults to `default` ' +
      '(a fresh, empty profile — identical to pre-vault behavior). ' +
      'Allowed charset: [A-Za-z0-9_-], max 128 chars.',
    type: 'string',
    required: false,
    example: 'work',
    category: 'browser',
  },
] as const satisfies readonly EnvVarMeta[];
