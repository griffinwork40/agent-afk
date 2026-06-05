/**
 * /reauth — Force the running session's SDK client to re-read credentials and
 * display the active Claude account.
 *
 * Useful when:
 *   - A 429 usage-limit pause is active with no auto-reset time
 *     (oauth-limit-no-ts): log in with a different account in another
 *     terminal and run `/reauth` to swap the running session onto it
 *     without waiting for the 30-second poll cycle.
 *   - The current token is near expiry and you want to refresh proactively.
 *   - You want to verify which Claude account afk is currently authenticated
 *     as.
 *
 * Critical implementation note: the Anthropic SDK reads `authToken` once at
 * client construction and caches it forever (`Authorization: Bearer ${this.authToken}`
 * per request, with no re-read hook). Updating the keychain alone is NOT
 * enough — we must rebuild the SDK client. That's what `session.reauth()`
 * does under the hood, delegating to `RetryLayer.forceClientRefresh()`.
 *
 * Usage:
 *   /reauth          — rebuild the running session's client and show the active account
 *   /reauth --check  — show the current account without touching the client
 */

import { loadClaudeCodeOauthToken, parseAccountIdentifier } from '../../../agent/auth/keychain.js';
import type { SlashCommand } from '../types.js';

export const reauthCmd: SlashCommand = {
  name: '/reauth',
  summary: 'Re-read keychain credentials and swap the running session\'s client',
  usage: '/reauth [--check]',
  hint: 'Force the running session to pick up a new keychain token (e.g. after `claude /login` in another terminal)',

  async handler(ctx, args) {
    const checkOnly = args.trim() === '--check';

    if (checkOnly) {
      const token = loadClaudeCodeOauthToken();
      if (!token) {
        ctx.out.warn('No OAuth token found. Run `claude login` in a terminal to authenticate.');
        return 'continue';
      }
      const accountId = parseAccountIdentifier(token);
      ctx.out.success(`Active keychain account: ${accountId}`);
      ctx.out.info('Note: --check only inspects the keychain. The running SDK client may still hold an older token — run `/reauth` (no args) to actually swap.');
      return 'continue';
    }

    // Show current account before refresh.
    const currentToken = loadClaudeCodeOauthToken();
    if (currentToken) {
      const currentAccount = parseAccountIdentifier(currentToken);
      ctx.out.info(`Current keychain account: ${currentAccount}`);
    }

    ctx.out.info('Rebuilding session client from keychain credentials…');

    let result: { accountId: string; swapped: boolean } | null;
    try {
      result = await ctx.session.current.reauth();
    } catch (err) {
      ctx.out.error(`Client refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      ctx.out.warn('Run `claude login` in a terminal to re-authenticate.');
      return 'continue';
    }

    if (!result) {
      // Two cases collapse here:
      //   - api-key mode (no `tokenRefresher` wired) — nothing to refresh.
      //   - oauth refresh path failed (network error, expired refresh token,
      //     no credentials in keychain).
      // Disambiguate via keychain probe.
      const token = loadClaudeCodeOauthToken();
      if (!token) {
        ctx.out.warn('No OAuth credentials found in the keychain. Run `claude login` in a terminal to authenticate.');
      } else {
        ctx.out.warn('This session is not using OAuth (probably api-key mode) — nothing to refresh. The active credential is whatever ANTHROPIC_API_KEY held at session start.');
      }
      return 'continue';
    }

    if (result.swapped) {
      ctx.out.success(`✓ Client swapped. Session now authenticated as: ${result.accountId}`);
      ctx.out.info('Next turn will use the new credential. If a usage-limit pause is active, it will resume automatically within ~30s (or send a message to retry immediately).');
    } else {
      ctx.out.success(`✓ Client refreshed. Authenticated as: ${result.accountId} (token unchanged)`);
    }

    return 'continue';
  },
};
