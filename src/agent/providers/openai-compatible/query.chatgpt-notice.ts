/**
 * Module-scope latch: emit the ChatGPT-subscription notice at most once per
 * accountId per process lifetime. Prevents repeating the same informational
 * line across multiple sessions in a long-running daemon.
 *
 * Extracted from query.ts to respect the 350-code-line ceiling (PR #3388).
 */

const warnedAccounts = new Set<string>();

/**
 * Emit a one-time stderr notice when ChatGPT subscription OAuth is active,
 * so operators know requests are routing to chatgpt.com. No-ops on repeat
 * calls for the same accountId within the same process.
 */
export function maybePrintChatGptOAuthNotice(accountId: string | undefined): void {
  const key = accountId ?? 'unknown';
  if (warnedAccounts.has(key)) return;
  warnedAccounts.add(key);
  process.stderr.write(
    '[AFK] Using ChatGPT subscription OAuth for OpenAI-compatible requests (chatgpt.com backend).\n',
  );
}

/** @internal Exposed for tests to reset the latch between test cases. */
export function _resetChatGptOAuthNotice(): void {
  warnedAccounts.clear();
}
