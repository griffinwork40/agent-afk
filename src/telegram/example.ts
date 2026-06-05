/**
 * Example usage of the Telegram bot
 * 
 * To run this example:
 * 1. Set environment variables:
 *    - TELEGRAM_BOT_TOKEN=your_bot_token
 *    - ANTHROPIC_API_KEY=your_api_key
 * 2. Run: npm run build && node dist/telegram/example.js
 */

import { TelegramBot } from './bot.js';
import type { AgentConfig } from '../agent/types.js';
import { env } from '../config/env.js';

// Mock agent session for demonstration
// In production, replace this with actual AgentSession implementation
class MockAgentSession {
  state = 'idle' as const;
  
  async sendMessage(content: string) {
    return {
      role: 'assistant' as const,
      content: `Mock response to: ${content}`,
      timestamp: new Date(),
    };
  }

  async *getOutputStream() {
    const response = `This is a mock streaming response. In production, this would be replaced with actual Claude API responses.`;
    
    // Simulate streaming by yielding chunks
    const chunks = response.match(/.{1,20}/g) || [response];
    for (const chunk of chunks) {
      yield {
        type: 'chunk' as const,
        chunk: {
          type: 'content' as const,
          content: chunk,
        },
      };
      
      // Small delay to simulate streaming
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    yield { type: 'done' as const };
  }

  async close() {
    // Cleanup
  }
}

async function main() {
  // Check required environment variables
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const apiKey = env.ANTHROPIC_API_KEY || 'mock-key';

  if (!botToken) {
    console.error('Error: TELEGRAM_BOT_TOKEN environment variable is required');
    console.error('Get your bot token from @BotFather on Telegram');
    process.exit(1);
  }

  console.log('Starting Telegram bot...');
  console.log('Using mock agent session (replace with real implementation in production)');

  // Create bot instance
  const bot = new TelegramBot({
    botToken,
    apiKey,
    dataDir: './data/telegram-sessions',
    defaultModel: 'sonnet',
    verbose: true,
    // Example only — real deployments source this from AFK_TELEGRAM_ALLOWED_CHAT_IDS.
    allowedChatIds: new Set<number>(),
    createSession: async (config: AgentConfig) => {
      console.log(`Creating session with model: ${config.model}`);
      // In production, create actual AgentSession here
      return new MockAgentSession() as any;
    },
  });

  // Start the bot
  try {
    await bot.start();
    console.log('✓ Bot started successfully!');
    console.log('\nSlash commands (Agent SDK):');
    console.log('  /start   - Welcome and command list');
    console.log('  /help    - Show command list');
    console.log('  /clear   - Clear conversation history');
    console.log('  /compact - Compact history (summarize older messages)');
    console.log('  /model   - Switch model (opus/sonnet/haiku)');
    console.log('\nSend any message to get a response from Claude.');
    console.log('\nPress Ctrl+C to stop the bot.');

    // Log stats periodically
    setInterval(() => {
      const stats = bot.getStats();
      console.log(`\n📊 Stats: ${stats.activeSessions} active sessions, ${stats.totalChats} total chats`);
    }, 60000); // Every minute

  } catch (error) {
    console.error('Failed to start bot:', error);
    process.exit(1);
  }
}

// Run the example
main().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
