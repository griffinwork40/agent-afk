import type { AgentConfig } from '../../types/config-types.js';
import type { ToolDispatcher } from '../anthropic-direct/tool-dispatcher.js';
import type { AnthropicToolDef } from '../anthropic-direct/types.js';
import { wrapDispatcherWithRuntimeState, type RuntimeStateSource } from '../../awareness/index.js';
import { operatorDispatcherToolDefs, withSlotDeniedDispatcher } from '../../tools/operator-denied-dispatcher.js';
import { selectBaseSchemas } from './base-schemas.js';
import { interactivityOpts, sessionRegistryOpts, type BuildDispatcherOpts } from './index.dispatcher-opts.js';

/** Build the query's dispatcher and catalog together, including live slot changes. */
export function buildQueryDispatcher(args: {
  config: AgentConfig;
  permissionMode: string;
  externalTools: ToolDispatcher | undefined;
  customNames: readonly string[];
  schemas: AnthropicToolDef[];
  runtimeStateSource: RuntimeStateSource;
  readRoots: string[] | undefined;
  writeRoots: string[] | undefined;
  sessionId: string | undefined;
  buildDispatcher: (mode: string, opts: BuildDispatcherOpts) => ToolDispatcher;
}): ToolDispatcher {
  const { config, runtimeStateSource } = args;
  const slotModel = typeof config.model === 'string' ? config.model : undefined;
  const externalTools = withSlotDeniedDispatcher(args.externalTools, slotModel, args.customNames);
  if (externalTools) return Object.assign(wrapDispatcherWithRuntimeState(externalTools, runtimeStateSource), {
    toolDefs: operatorDispatcherToolDefs(externalTools, selectBaseSchemas(args.schemas, config)),
  });
  return args.buildDispatcher(args.permissionMode, {
    ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    ...(slotModel !== undefined ? { slotModel } : {}),
    ...(args.readRoots !== undefined ? { readRoots: args.readRoots } : {}),
    ...(args.writeRoots !== undefined ? { writeRoots: args.writeRoots } : {}),
    ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
    ...(config.parentSessionId !== undefined ? { parentSessionId: config.parentSessionId } : {}),
    ...(config.rootSessionId !== undefined ? { rootSessionId: config.rootSessionId } : {}),
    ...(config.subagentId !== undefined ? { subagentId: config.subagentId } : {}),
    ...(config.env !== undefined ? { env: config.env } : {}),
    ...(config.subagentToolOutputCapBytes !== undefined ? { subagentToolOutputCapBytes: config.subagentToolOutputCapBytes } : {}),
    ...(config.traceWriter !== undefined ? { traceWriter: config.traceWriter } : {}),
    ...(config.bashOutputTailReporter !== undefined ? { bashOutputTailReporter: config.bashOutputTailReporter } : {}),
    ...sessionRegistryOpts(config),
    runtimeStateSource,
    ...(config.isSkillDispatch ? { isSkillDispatch: true } : {}),
    ...interactivityOpts(config),
    // lspInstallAllowed forwarded via interactivityOpts (it reads config.lspInstallAllowed).
    ...(config.hookRegistry !== undefined ? { hookRegistry: config.hookRegistry } : {}),
    ...(config.planExitControls !== undefined ? { planExitControls: config.planExitControls } : {}),
  });
}
