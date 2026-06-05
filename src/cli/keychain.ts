/**
 * Backward-compat re-export shim.
 *
 * The canonical home for Claude Code OAuth keychain access is now
 * `src/agent/auth/keychain.ts`. The logic moved out of the CLI layer so
 * the provider layer (`src/agent/providers/anthropic-direct/`) and any
 * future non-CLI consumer can read keychain credentials without an upward
 * import into `src/cli/`. Existing callers continue to work unchanged via
 * this re-export.
 *
 * @module cli/keychain
 * @deprecated Import from `../agent/auth/keychain.js` directly.
 */
export {
  loadClaudeCodeOauthToken,
  refreshClaudeCodeOauthToken,
  parseAccountIdentifier,
} from '../agent/auth/keychain.js';
