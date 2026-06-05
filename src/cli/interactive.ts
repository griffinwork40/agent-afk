import * as readline from 'readline';
import Anthropic from '@anthropic-ai/sdk';
import { CliConfig, getModelId, isValidModel } from './config.js';
import { formatter } from './formatter.js';
import { welcomeBanner, helpTable } from './render.js';

interface InteractiveSession {
  config: CliConfig;
  client: Anthropic;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
}

/**
 * Create readline interface with proper configuration
 */
function createReadlineInterface(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    historySize: 100,
    prompt: '',
  });
}

/**
 * Handle special commands (/exit, /clear, /model, /help)
 */
function handleCommand(
  command: string,
  session: InteractiveSession,
  rl: readline.Interface
): boolean {
  const parts = command.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();
  
  if (!cmd) {
    return true;
  }

  switch (cmd) {
    case '/exit':
    case '/quit':
      console.log(formatter.formatInfo('Goodbye!'));
      rl.close();
      process.exit(0);
      return true;

    case '/clear':
      session.conversationHistory = [];
      console.clear();
      console.log(formatter.formatSuccess('Conversation history cleared'));
      return true;

    case '/model':
      if (parts.length < 2 || !parts[1]) {
        console.log(formatter.formatInfo(`Current model: ${session.config.model}`));
        console.log(formatter.formatInfo('Available: opus, sonnet, haiku'));
      } else {
        const newModel = parts[1].toLowerCase();
        if (isValidModel(newModel)) {
          session.config.model = newModel;
          console.log(formatter.formatSuccess(`Switched to ${newModel}`));
        } else {
          console.log(formatter.formatError('Invalid model. Choose: opus, sonnet, haiku'));
        }
      }
      return true;

    case '/help':
      console.log(helpTable([
        {
          title: 'Commands (aligned with Agent SDK)',
          entries: [
            { cmd: '/exit, /quit',  desc: 'Exit the interactive session' },
            { cmd: '/clear',        desc: 'Clear conversation history' },
            { cmd: '/compact',     desc: 'Compact history (summarize older messages; session mode only)' },
            { cmd: '/model [name]', desc: 'Switch model (opus/sonnet/haiku)' },
            { cmd: '/help',         desc: 'Show this help message' },
          ],
        },
        {
          title: 'Usage',
          entries: [
            { cmd: 'message',   desc: 'Type a message and press Enter' },
            { cmd: 'line\\',    desc: 'Trailing backslash for multi-line input' },
            { cmd: 'Ctrl+C',    desc: 'Exit the session' },
            { cmd: 'Ctrl+D',    desc: 'Exit the session' },
          ],
        },
      ]));
      return true;

    case '/compact':
      console.log(formatter.formatInfo('Use "afk interactive" (session mode) for /compact.'));
      return true;

    case '/history':
      if (session.conversationHistory.length === 0) {
        console.log(formatter.formatInfo('No conversation history'));
      } else {
        console.log(formatter.separator('=', 60));
        session.conversationHistory.forEach((msg, idx) => {
          const role = msg.role === 'user' ? '👤 You' : '🤖 Assistant';
          console.log(`\n${formatter.formatInfo(role)}:`);
          console.log(msg.content);
          if (idx < session.conversationHistory.length - 1) {
            console.log(formatter.separator());
          }
        });
        console.log(formatter.separator('=', 60));
      }
      return true;

    default:
      console.log(formatter.formatError(`Unknown command: ${cmd}`));
      console.log(formatter.formatInfo('Type /help for available commands'));
      return true;
  }
}

/**
 * Send message to Claude API and stream response
 */
async function sendMessage(
  prompt: string,
  session: InteractiveSession
): Promise<void> {
  // Add user message to history
  session.conversationHistory.push({
    role: 'user',
    content: prompt,
  });

  try {
    const modelRaw = session.config.model as string;
    const modelId = isValidModel(modelRaw) ? getModelId(modelRaw) : modelRaw;
    
    // Build messages array from history
    const messages = session.conversationHistory.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    // Stream the response
    const stream = await session.client.messages.create({
      model: modelId,
      max_tokens: session.config.maxTokens,
      temperature: session.config.temperature,
      system: session.config.systemPrompt,
      messages,
      stream: true,
    });

    let fullResponse = '';
    process.stdout.write('\n');

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        const chunk = event.delta.text;
        fullResponse += chunk;
        process.stdout.write(chunk);
      }
    }

    process.stdout.write('\n\n');

    // Add assistant response to history
    session.conversationHistory.push({
      role: 'assistant',
      content: fullResponse,
    });

  } catch (error) {
    console.log('\n');
    if (error instanceof Error) {
      console.log(formatter.formatError('API request failed', error));
    } else {
      console.log(formatter.formatError('Unknown error occurred'));
    }
  }
}

/**
 * Handle multi-line input (lines ending with \)
 */
function collectInput(rl: readline.Interface): Promise<string> {
  return new Promise((resolve) => {
    let lines: string[] = [];
    let isMultiline = false;

    const promptUser = () => {
      const prefix = isMultiline ? '... ' : '';
      rl.setPrompt(prefix);
      rl.prompt();
    };

    const onLine = (line: string) => {
      // Check if line ends with backslash (continuation)
      if (line.endsWith('\\')) {
        lines.push(line.slice(0, -1)); // Remove trailing backslash
        isMultiline = true;
        promptUser();
      } else {
        lines.push(line);
        const fullInput = lines.join('\n');
        lines = [];
        isMultiline = false;
        rl.off('line', onLine);
        resolve(fullInput);
      }
    };

    rl.on('line', onLine);
    promptUser();
  });
}

/**
 * Start interactive REPL session
 */
export async function startInteractive(config: CliConfig): Promise<void> {
  const session: InteractiveSession = {
    config,
    client: new Anthropic({ apiKey: config.apiKey }),
    conversationHistory: [],
  };

  const rl = createReadlineInterface();

  // Handle Ctrl+C to quit
  rl.on('SIGINT', () => {
    console.log('\n' + formatter.formatInfo('Goodbye!'));
    rl.close();
    process.exit(0);
  });

  // Handle Ctrl+D (EOF)
  rl.on('close', () => {
    console.log('\n' + formatter.formatInfo('Goodbye!'));
    process.exit(0);
  });

  // Welcome message
  console.log('\n' + welcomeBanner({
    mode: 'Interactive Mode',
    metaLine: `Model: ${session.config.model}  ·  Max tokens: ${session.config.maxTokens}  ·  Temp: ${session.config.temperature}`,
    hintLine: 'Type /help for commands  ·  /exit to quit',
  }));
  console.log();

  // Main REPL loop
  while (true) {
    rl.setPrompt(formatter.formatPrompt(session.config.model));
    rl.prompt();

    const input = await collectInput(rl);
    const trimmed = input.trim();

    if (!trimmed) {
      continue;
    }

    // Handle commands
    if (trimmed.startsWith('/')) {
      handleCommand(trimmed, session, rl);
      continue;
    }

    // Send to API
    await sendMessage(trimmed, session);
  }
}
