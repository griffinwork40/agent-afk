import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { createRequire, isBuiltin } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { boundaries } from './surface-census-boundaries.js';

export interface Observation { name: string; args: unknown[] }
type Bag = Record<string, any>; // Test sandbox: production exports have heterogeneous signatures.
export const token = Object.freeze({ census: 'present' });
const realRequire = createRequire(import.meta.url);

// Contract: only Node built-ins that cannot touch the machine are handed to
// sandboxed builders for real. Every other built-in (fs, child_process, net,
// http, ...) is a stub whose members throw when CALLED, so a builder may import
// one but the census fails if its chain ever uses it. This is what makes "no
// disk, no processes, no network" a check instead of a convention.
//
// node:os is intentionally NOT passed through whole: it includes setPriority,
// which changes the real process's scheduling priority. Only the read-only
// members are exposed; any builder that calls a mutating member fails closed.
const pureBuiltins = new Set(['node:crypto', 'node:path', 'node:url', 'node:util']);
const osReadOnlyMembers = new Set([
  'arch', 'availableParallelism', 'cpus', 'endianness', 'freemem', 'homedir',
  'hostname', 'loadavg', 'machine', 'networkInterfaces', 'platform', 'release',
  'tmpdir', 'totalmem', 'type', 'uptime', 'userInfo', 'version', 'constants',
  'EOL', 'devNull',
]);
function nodeBuiltin(id: string, importer: string): unknown {
  // Normalise bare specifier (e.g. 'fs') to its node: form for the lookup.
  const canonical = id.startsWith('node:') ? id : `node:${id}`;
  if (pureBuiltins.has(canonical)) return realRequire(canonical);
  if (canonical === 'node:os') {
    const realOs = realRequire('node:os') as Record<string, unknown>;
    return new Proxy(realOs, {
      get(target, member: string | symbol) {
        if (member === '__esModule') return true;
        if (typeof member === 'string' && !osReadOnlyMembers.has(member)) {
          // Mutating or unknown member: fail closed on call.
          return () => { throw new Error(`Census sandbox: ${importer} called node:os.${member}; not in the read-only allowlist.`); };
        }
        return target[member as string];
      },
    });
  }
  return new Proxy({} as Record<string, unknown>, {
    get: (_target, member: string | symbol) => member === '__esModule' ? true : () => {
      throw new Error(`Census sandbox: ${importer} called ${canonical}.${String(member)}; real ${canonical} access is not allowed.`);
    },
  });
}

// Contract: execute real surface builders, not a facsimile of their option lists.
// Only infrastructure boundaries are faked. Helpers/spreads in the allowed module
// graph execute normally; an import moved outside that graph fails closed and
// requires review. No SDK, disk database, hooks, network, bot or trace is opened.
export class SurfaceRuntime {
  readonly observations: Observation[] = [];
  readonly sessions: Bag[] = [];
  readonly cache = new Map<string, Bag>();
  readonly calls = (name: string): Observation[] => this.observations.filter((o) => o.name === name);
  readonly record = (name: string, args: unknown[]): void => { this.observations.push({ name, args }); };
  readonly session = (config: Bag, owner?: unknown): Bag => {
    this.sessions.push(config);
    this.record('session', [config, owner]);
    return {
      sessionId: 'census-session', close: async () => {}, wireStopHook: () => {},
      recordSubagentCompletion: () => {}, getSessionMetadata: () => config,
      waitForInitialization: async () => ({ sessionId: 'census-session' }),
      queueFrameworkContext: () => {},
    };
  };

  constructor(readonly src: string, readonly modules: readonly string[]) {}

  load(relative: string): Bag {
    const cached = this.cache.get(relative);
    if (cached) return cached;
    if (!this.modules.includes(relative)) throw new Error(`Unreviewed real census module: ${relative}`);
    const exports: Bag = {};
    this.cache.set(relative, exports);
    const filename = path.join(this.src, relative);
    const output = ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      fileName: filename,
    }).outputText;
    const require = (id: string): unknown => {
      // Route both node:-prefixed and bare built-in specifiers (e.g. 'fs') through
      // the same stub so `require('fs')` is not mistaken for a relative import.
      if (id.startsWith('node:') || isBuiltin(id)) return nodeBuiltin(id, relative);
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(relative), id)).replace(/\.js$/, '.ts');
      return this.modules.includes(target) ? this.load(target) : this.boundary(target);
    };
    runInNewContext(output, { exports, require, console: { log() {}, warn() {}, error() {} },
      process: { cwd: () => 'host-cwd' }, AbortController, setTimeout, clearTimeout,
    }, { filename });
    return exports;
  }

  private boundary(file: string): Bag {
    const self = this;
    if (!boundaries.has(file)) throw new Error(`Unreviewed census import ${file}: execute the helper or explicitly review its boundary.`);
    this.record('boundary', [file]);
    const fn = (name: string, result: (...args: unknown[]) => unknown) => (...args: unknown[]) => {
      self.record(name, args);
      return result(...args);
    };
    const manager = { abortAllAndDrain: async () => {}, getPendingChildTerminalWrites: () => [],
      getPendingChildBillingStreams: () => [], setOnSubagentSucceeded: () => {} };
    const registry = { register() {} };
    const values: Bag = {
      env: {}, palette: { warning: (s: string) => s, dim: (s: string) => s },
      AgentSession: function(config: Bag, owner?: unknown) { return self.session(config, owner); },
      wireExecutors: fn('wireExecutors', () => ({ rootManager: manager, subagentExecutor: token,
        skillExecutor: token, composeExecutor: manager, continuationRegistry: { dispose() {} } })),
      makeDeferredParentProxy: () => ({ proxy: {}, bind() {} }),
      createStubParentSession: () => ({}),
      managerShutdownConfig: () => ({}), withContinuationDispose: (c: unknown) => c,
      pendingChildBillingStreams: () => [],
      createDefaultTraceWriter: fn('createDefaultTraceWriter', () => ({ writer: token, sessionLabel: 'census', tracePath: 'trace' })),
      createDefaultHookRegistry: fn('createDefaultHookRegistry', () => ({ registry, addPreviewDiffRef: {} })),
      loadHooksConfig: fn('loadHooksConfig', () => token),
      loadMcpConfig: fn('loadMcpConfig', () => ({ mcpServers: { census: {} }, warnings: [], sources: ['census'] })),
      connectMcpTraced: fn('connectMcpTraced', async () => self.mcp()),
      McpManager: { fromConfig: fn('McpManager.fromConfig', async () => self.mcp()) },
      takeWebMcpManager: (_cwd: unknown, _sink: unknown, load: () => unknown) => load(),
      resolveImportedRoots: () => ({ mcpConfigs: [] }), loadImportFromConfig: () => ({}),
      getApiKeyForModel: () => 'key', getDefaultSubagentModel: () => 'sonnet', getModel: () => 'sonnet',
      resolveModelId: (m: unknown) => m, explicitProviderHints: () => undefined,
      resolveUnattendedLimits: () => ({}), tryCredentialSourceForModel: () => undefined,
      loadConfig: () => ({}), resolveBaseSystemPrompt: fn('resolveBaseSystemPrompt', () => ({ prompt: 'base+overlay', overlay: 'overlay' })),
      composeSystemPrompt: (...s: string[]) => s.join('\n'), assembleSystemPrompt: (s: unknown) => s,
      topLevelSurfaceAllowedTools: () => [], getStateDatabasePath: () => 'unused-db',
      getMaxOutputTokens: () => 100, isOpenAiRoutedProvider: (s: string) => s === 'openai-compatible',
      isXaiRoutedProvider: (s: string) => s === 'xai',
      providerForModel: fn('providerForModel', (s: string) => s.startsWith('gpt') ? 'openai-compatible' : 'anthropic-direct'),
      cliProviderFamily: (_p: unknown, o: Bag) => o['model'].startsWith('gpt') ? 'openai-compatible' : 'anthropic-direct',
      parseProvider: fn('parseProvider', (_p: unknown, o: Bag) => self.provider(o['model'].startsWith('gpt') ? 'openai-compatible' : 'anthropic-direct', o)),
      injectedProviderWiring: (o: Bag) => ({ provider: o['build'](o['model']), providerFactory: o['build'] }),
      createMemoizedProviderFactory: (build: unknown) => build,
      registerSurfaceSession: () => ({ dispose() {} }),
      replCanAutoWake: () => true, isAutoDeliverEnabled: () => true,
    };
    for (const name of ['AnthropicDirectProvider', 'OpenAICompatibleProvider', 'XaiProvider']) {
      values[name] = function(options: Bag) { return self.provider(name, options); };
    }
    for (const name of ['MemoryStore', 'StateStore', 'WorkspaceStore', 'BackgroundAgentRegistry',
      'DetachableToolRegistry', 'ProcessJobRegistry', 'FastModeController']) {
      values[name] = function() { return { close() {}, cancelAll: async () => {} }; };
    }
    for (const name of ['TelegramBgResultNotifier', 'WebSessionControl']) {
      values[name] = function() { return { dispose() {}, autosaver: () => ({}) }; };
    }
    for (const name of ['injectHotMemory', 'injectEpisodeRecall', 'injectCompanionPrimer', 'injectGoalPrompt']) {
      values[name] = (config: unknown) => config;
    }
    for (const name of ['ensurePluginEntrypointsLoaded', 'emitSessionPhase', 'setBgsubRegistry',
      'setBgsubSummarizer', 'setTasksRegistry', 'seedPersistedGrants', 'initSessionStats']) values[name] = () => {};
    values['getStats'] = () => ({});
    values['createTerminalStateGate'] = () => ({});
    values['buildDaemonGetModel'] = () => () => 'sonnet';
    values['daemonDefaultCwd'] = () => 'daemon-cwd';
    return new Proxy(values, { get(target, key: string | symbol) {
      if (key === '__esModule') return true;
      if (typeof key === 'symbol' || !(key in target)) throw new Error(`Unreviewed census boundary ${file} export ${String(key)}`);
      return target[key];
    } });
  }

  private readonly mcpManager = { getMcpToolWireNames: () => [], getServerStates: () => [], disconnectAll: async () => {} };
  mcp(): Bag { return this.mcpManager; }
  private provider(name: string, options: unknown): Bag {
    this.record('provider', [name, options]);
    return { name, query() {}, getGrantManager: () => undefined, addReadRoot() {}, addWriteRoot() {} };
  }
}
