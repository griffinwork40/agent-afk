#!/usr/bin/env bash
# DEPRECATED: this script has been replaced by `afk telegram {start|stop|status|restart|logs|setup}`.
#
# The TypeScript implementation lives at:
#   - src/cli/commands/telegram.ts  (CLI surface)
#   - src/telegram/manager.ts       (process lifecycle)
#   - src/telegram/setup-wizard.ts  (interactive config)
#
# Why the rewrite:
#   - State (PID, logs) now lives under ~/.afk/state/telegram/ and ~/.afk/logs/
#     instead of polluting the project tree.
#   - Config (TELEGRAM_BOT_TOKEN, AFK_TELEGRAM_ALLOWED_CHAT_IDS) lives in
#     ~/.afk/config/afk.env, alongside Anthropic credentials.
#   - First-time setup is now an interactive wizard that validates the bot
#     token via getMe and auto-discovers your chat ID via getUpdates.
#   - One CLI surface (afk) instead of a separate shell harness.
#
# This shim remains so existing muscle memory (npm run telegram:*) keeps
# working — those scripts now route through `afk telegram` under the hood.
# Direct invocations of this script print a redirect and exit non-zero.

set -e

CMD="${1:-start}"
echo "⚠️  scripts/telegram-manager.sh is deprecated."
echo ""
echo "Use the integrated CLI instead:"
echo "  afk telegram setup       # first-time setup (bot token, chat ID)"
echo "  afk telegram start       # launch as a background daemon"
echo "  afk telegram stop"
echo "  afk telegram status"
echo "  afk telegram restart"
echo "  afk telegram logs -f     # follow logs"
echo ""
echo "Forwarding '$CMD' to 'afk telegram $CMD'..."
echo ""

# If afk is installed globally, use it; otherwise fall back to the local build.
if command -v afk >/dev/null 2>&1; then
    exec afk telegram "$CMD"
fi

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$PROJECT_DIR/dist/cli/index.js" ]; then
    exec node "$PROJECT_DIR/dist/cli/index.js" telegram "$CMD"
fi

echo "❌ Neither 'afk' nor dist/cli/index.js is available."
echo "   Run 'pnpm install && pnpm build' first."
exit 1
