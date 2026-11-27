import { palette } from '../cli/palette.js';
import { writeServiceStartupSidecar } from '../service/version-skew.js';
import { UNKNOWN_VERSION } from './daemon-version.js';

/** Report startup only after polling has started and commands are registered. */
export function announceTelegramStartup(daemonVersion: string): void {
  // Use the same version as the drift watchdog so service status compares
  // against the running version. Skip unknown to avoid a false skew warning.
  if (daemonVersion !== UNKNOWN_VERSION && !writeServiceStartupSidecar('telegram', daemonVersion)) {
    console.warn('warn: failed to write service startup sidecar — `afk service status` may not show the running version'); // console-ok
  }

  console.log(palette.success('✅ Bot started successfully!'));
  console.log(palette.heading('\n📝 Slash commands (Agent SDK):'));
  console.log(palette.dim('  /start   - Welcome and command list'));
  console.log(palette.dim('  /help    - Show command list'));
  console.log(palette.dim('  /clear   - Clear conversation history'));
  console.log(palette.dim('  /compact - Compact history (summarize older messages)'));
  console.log(palette.dim('  /model   - Switch model (opus/sonnet/haiku/gpt-5.6-sol/...)'));
  console.log(palette.dim('\n💬 Send any message to chat with the agent.'));
  console.log(palette.dim('\n⏹️  Press Ctrl+C to stop the bot.'));
}
