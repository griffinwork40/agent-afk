import { SurfaceRuntime, token } from './surface-census-runtime.js';

const cli = 'cli/commands/';
const repl = `${cli}interactive/`;
export const surfaces = ['REPL', 'chat', 'daemon', 'Telegram', 'web', 'ACP'] as const;
export type Surface = typeof surfaces[number];

const modules: Record<Surface, string[]> = {
  REPL: ['bootstrap-infra', 'bootstrap-session-builder', 'bootstrap-hooks', 'bootstrap-mcp', 'bootstrap-providers']
    .map((s) => `${repl}${s}.ts`),
  chat: [`${cli}chat.session-setup.ts`, `${cli}chat.mcp-setup.ts`],
  daemon: [`${cli}daemon-session-factory.ts`, 'agent/daemon/session-spawn.ts'],
  Telegram: ['create-session', 'session-anthropic', 'session-openai', 'session-xai', 'session-builder',
    'session-provider', 'session-lifecycle', 'construct-session', 'wire-telegram-executors', 'mcp-session', 'afk-hook-bundle']
    .map((s) => `telegram/${s}.ts`),
  web: ['session-owner', 'session-owner.wiring', 'session-owner.provider'].map((s) => `web-server/${s}.ts`),
  ACP: [`${cli}acp.session.ts`],
};

// Each probe supplies non-empty optional capabilities and a distinct session cwd.
// This is a builder census, not an end-to-end CLI/bot/daemon startup simulation.
// REPL/chat outer orchestration is explicitly not machine-checked in the table.
export async function probe(src: string, surface: Surface, model = 'sonnet'): Promise<SurfaceRuntime> {
  const rt = new SurfaceRuntime(src, modules[surface]);
  switch (surface) {
    case 'ACP':
      await rt.load(`${cli}acp.session.ts`)['buildAcpSession']({ model, maxTurns: 10, cwd: 'session-cwd' });
      break;
    case 'chat': {
      const mcpManager = await rt.load(`${cli}chat.mcp-setup.ts`)['connectMcpForChat']({
        worktreeCwd: 'session-cwd', traceWriter: token,
      });
      await rt.load(`${cli}chat.session-setup.ts`)['buildChatSession']({
        model, sessionModel: model, maxTurns: 10, apiKey: 'key', worktreeCwd: 'session-cwd',
        traceWriter: token, basePrompt: 'base', operatorOverlay: 'overlay', systemPrompt: 'base+overlay',
        resumeConfig: {}, mcpManager,
      });
      break;
    }
    case 'daemon': {
      const factory = rt.load(`${cli}daemon-session-factory.ts`)['buildDaemonSessionFactory']({ model });
      await rt.load('agent/daemon/session-spawn.ts')['spawnDaemonSession']('census-task', {
        taskCwd: 'session-cwd', sessionConfig: { model }, sessionFactory: factory,
      });
      break;
    }
    case 'Telegram': {
      const factory = rt.load('telegram/create-session.ts')['createTelegramSessionFactory']({
        config: {}, frameworkBase: 'base', telegramCwd: 'session-cwd', memoryStore: {},
        log() {},
      });
      await factory({ model, cwd: 'session-cwd', systemPrompt: 'overlay' });
      break;
    }
    case 'web': {
      const Owner = rt.load('web-server/session-owner.ts')['SessionOwner'];
      await new Owner({ model, cwd: 'session-cwd' }).create();
      break;
    }
    case 'REPL': await runRepl(rt, model); break;
  }
  return rt;
}

async function runRepl(rt: SurfaceRuntime, model: string): Promise<void> {
  const infra = rt.load(`${repl}bootstrap-infra.ts`)['createBootstrapInfra']({
    sessionRef: { current: {} }, options: {}, cliConfig: {}, sessionModel: model,
    basePrompt: 'base', operatorOverlay: 'overlay', effectiveCwd: 'session-cwd', bootWarnings: [],
  });
  const traceWriter = infra.trace.writer;
  const mcp = rt.load(`${repl}bootstrap-mcp.ts`)['connectReplMcp'];
  const mcpManager = await mcp({ effectiveCwd: 'session-cwd', traceWriter, bootWarnings: [] });
  const providers = rt.load(`${repl}bootstrap-providers.ts`)['createReplProviders']({
    options: {}, cliConfig: {}, sessionModel: model, ...infra, mcpManager,
  });
  const hooks = rt.load(`${repl}bootstrap-hooks.ts`)['createReplHookRegistry']({
    memoryStore: {}, completionWriter: {}, stats: { model }, effectiveCwd: 'session-cwd', traceWriter,
  });
  rt.load(`${repl}bootstrap-session-builder.ts`)['buildAgentSession']({
    model, ...providers, ...hooks, cwd: 'session-cwd', traceWriter, systemPrompt: 'base+overlay', resumeConfig: {},
  });
}
