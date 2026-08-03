import { McpManager, loadMcpConfig, getMcpConfigPath } from '../../../agent/mcp/index.js';
import { loadImportFromConfig, resolveImportedRoots } from '../../../config/import-sources.js';
import type { TraceWriter } from '../../../agent/trace/index.js';
import { emitSessionPhase } from '../../../agent/trace/emit.js';
import { palette } from '../../palette.js';

/**
 * Load `~/.afk/config/mcp.json` (layered with project-local + imported
 * sources) and connect every enabled server. Must run BEFORE provider
 * construction so the provider sees the MCP-bridged tools in its initial
 * schema set — `buildProvider` and `mcpToolWireNames` in
 * `bootstrap-providers.ts` close over the returned manager.
 *
 * Failure model: `loadMcpConfig()` returns warnings, never throws. The
 * manager itself throws when an `alwaysLoad: true` server fails or when
 * there's a wire-name collision — both are user-facing config errors and
 * should abort bootstrap with the error message intact (propagated, not
 * caught here).
 *
 * Prints the `mcp: N server(s) from …` startup line directly (preserved
 * console-output ordering: `mcp:` → `trace:` → `↪ resuming in`, the latter
 * two owned by `bootstrap-surface.ts`). Pushes config-loader warnings into
 * the SAME `bootWarnings` array instance the caller owns — never a copy.
 */
export async function connectReplMcp(a: {
  effectiveCwd: string | undefined;
  mcpConfigOverride: string | undefined;
  traceWriter: TraceWriter | undefined;
  bootWarnings: string[];
}): Promise<McpManager | undefined> {
  // Use the worktree cwd for project-local `.mcp.json` resolution so each
  // worktree can carry its own MCP config (matching how the worktree
  // already isolates everything else under `worktreeCwd`).
  const projectCwd = a.effectiveCwd ?? process.cwd();
  // Imported MCP servers from trusted source binaries (`importFrom`). Only
  // JSON-format configs (Claude Code) are loadable today; they enter as the
  // lowest-priority layer so AFK's own config always wins. MCP import is
  // off by default even for a trusted binary (it auto-runs commands on
  // connect) — this only fires when the user set `mcp: true` for a binary.
  const importedMcpConfigs = resolveImportedRoots(loadImportFromConfig())
    .mcpConfigs.filter((c) => c.format === 'json')
    .map((c) => c.source);
  const loaded = loadMcpConfig({
    cwd: projectCwd,
    ...(importedMcpConfigs.length > 0 ? { importedMcpConfigs } : {}),
    ...(a.mcpConfigOverride !== undefined ? { cliOverride: a.mcpConfigOverride } : {}),
  });
  const enabledCount = Object.values(loaded.mcpServers).filter((s) => !s.disabled).length;
  // Config-loader warnings ("your mcp.json had X") reach the operator on both
  // branches — servers enabled or not — via the post-clear drain. Collected
  // once here so the two paths cannot diverge: previously the enabled path
  // printed inside McpManager.fromConfig and the disabled path printed here,
  // and the clear erased both.
  for (const w of loaded.warnings) a.bootWarnings.push(`[mcp] ${w}`);

  let mcpManager: McpManager | undefined;
  if (enabledCount > 0) {
    const sourcesLabel = loaded.sources.length === 1
      ? loaded.sources[0]
      : `${loaded.sources.length} source(s)`;
    console.log(palette.dim(`  mcp: ${enabledCount} server(s) from ${sourcesLabel ?? getMcpConfigPath()}`));
    // Witness layer: bracket the whole-fleet MCP connect. try/finally so
    // mcp_connect_done fires even when an alwaysLoad server makes fromConfig
    // throw. Per-server mcp_server_* pairs are emitted inside fromConfig via
    // the traceWriter passed below. Fire-and-forget; never gates connect.
    const mcpStartedAt = Date.now();
    void emitSessionPhase(a.traceWriter, {
      phase: 'mcp_connect_start',
      metadata: { serverCount: enabledCount },
    });
    try {
      // `warnings` is deliberately NOT forwarded: fromConfig would
      // `console.warn` them (mcp/manager.ts) mid-bootstrap, where the startup
      // clear erases them. They ride bootWarnings instead and are drained
      // after the clear. `chat` still forwards them — it never clears — so
      // this does not change any other surface, and nothing double-prints.
      mcpManager = await McpManager.fromConfig(loaded.mcpServers, {
        ...(a.traceWriter !== undefined ? { traceWriter: a.traceWriter } : {}),
      });
    } finally {
      void emitSessionPhase(a.traceWriter, {
        phase: 'mcp_connect_done',
        durationMs: Date.now() - mcpStartedAt,
        metadata: { serverCount: enabledCount },
      });
    }
  }
  // No `else` branch for warnings: the no-enabled-servers case used to
  // console.warn here, and both branches are now covered by the single
  // bootWarnings collection above.

  return mcpManager;
}
