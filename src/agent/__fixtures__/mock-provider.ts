import type {
  ModelProvider,
  ProviderEvent,
  ProviderQuery,
  ProviderQueryArgs,
  ProviderUserTurn,
} from '../provider.js';

export interface MockProviderOptions {
  sessionId?: string;
  model?: string;
  onTurn?: (turn: ProviderUserTurn) => void;
}

export interface MockProviderHandle extends ModelProvider {
  queries: MockQueryHandle[];
}

export interface MockQueryHandle extends ProviderQuery {
  interruptCalls: number;
  closeCalls: number;
}

export function createMockProvider(opts: MockProviderOptions = {}): MockProviderHandle {
  const sessionId = opts.sessionId ?? 'mock-session-123';
  const model = opts.model ?? 'claude-sonnet-4-6';
  const queries: MockQueryHandle[] = [];

  return {
    name: 'mock-provider',
    queries,
    query(args: ProviderQueryArgs): ProviderQuery {
      const promptIter = args.prompt[Symbol.asyncIterator]();
      let closed = false;
      let closeResolve: (() => void) | null = null;
      const closedPromise = new Promise<'__closed__'>((resolve) => {
        closeResolve = () => resolve('__closed__');
      });
      let abortController: AbortController | null = null;

      const q: MockQueryHandle = {
        interruptCalls: 0,
        closeCalls: 0,

        async *[Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
          yield {
            type: 'session.init',
            info: {
              sessionId,
              model,
              permissionMode: 'bypassPermissions',
              cwd: '/tmp/mock-cwd',
              tools: ['Bash', 'Read', 'Write'],
              slashCommands: [],
              skills: [],
              plugins: [],
              mcpServers: [],
              apiKeySource: 'api-key',
              version: 'mock-v1',
            },
          };

          while (!closed) {
            const nextOrClose = await Promise.race([
              promptIter.next(),
              closedPromise,
            ]);
            if (nextOrClose === '__closed__') break;
            const turnResult = nextOrClose as IteratorResult<ProviderUserTurn>;
            if (turnResult.done) break;
            const turn = turnResult.value;

            opts.onTurn?.(turn);

            const userContent =
              typeof turn.content === 'string'
                ? turn.content
                : '[multi-block content]';

            abortController = new AbortController();

            if (userContent.includes('slow')) {
              await new Promise((r) => setTimeout(r, 30));
            }

            if (abortController.signal.aborted) return;

            yield {
              type: 'assistant.message',
              text: `Echo: ${userContent}`,
              sessionId,
            } satisfies ProviderEvent;

            yield {
              type: 'turn.completed',
              usage: {
                resultSubtype: 'success',
                stopReason: 'end_turn',
                durationMs: 12,
                totalCostUsd: 0.001,
                inputTokens: 10,
                outputTokens: 2,
                raw: { input_tokens: 10, output_tokens: 2 },
              },
              sessionId,
            } satisfies ProviderEvent;

            abortController = null;
          }
        },

        async interrupt() {
          q.interruptCalls++;
          abortController?.abort('interrupted');
        },

        async setModel() {},
        async setPermissionMode() {},
        async supportedCommands() { return []; },
        async supportedModels() {
          return [{ value: model, displayName: 'Mock', description: 'Mock model' }];
        },
        async supportedAgents() { return []; },
        async getContextUsage() {
          return { tools: [], agents: [], isAutoCompactEnabled: false, apiUsage: null };
        },
        async mcpServerStatus() { return []; },
        async accountInfo() { return { subscriptionType: 'api-key' }; },
        async rewindFiles() { return { canRewind: false }; },
        close() {
          q.closeCalls++;
          closed = true;
          closeResolve?.();
        },
      };

      queries.push(q);
      return q;
    },
  };
}
