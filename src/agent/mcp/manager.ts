/**
 * `McpManager` — lifecycle coordinator for MCP clients in an agent-afk
 * session.
 *
 * One instance per surface (REPL, daemon, telegram bot). Subagents share
 * the parent manager by reference, matching the `hookRegistry` pattern.
 *
 * Responsibilities:
 *
 *   1. Construct from a `Record<string, McpServerConfig>` (loaded by
 *      `config-loader.ts`). Skip `disabled: true` entries.
 *   2. Connect every enabled server in parallel; respect `alwaysLoad: true`
 *      by re-throwing on connect failure; otherwise mark the server `error`
 *      and continue.
 *   3. Build the wire-name registry, surface any conflicts as a hard error.
 *   4. Expose the bridged tools via:
 *        - `getMcpTools(): AnthropicToolDef[]`     for the provider's `schemas`
 *        - `getMcpHandlers(): Map<string, ToolHandler>` for the dispatcher's `handlers`
 *        - `getServerStates(): McpClientState[]`   for `/mcp` and provider session.init
 *   5. `disconnectAll()` for clean teardown.
 *
 * @module agent/mcp/manager
 */

import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';

import type { AnthropicToolDef, ToolHandler } from '../tools/types.js';
import { McpClient, UnauthorizedError } from './client.js';
import { buildMcpNameRegistry, sanitizeNameSegment } from './naming.js';
import type { McpClientState, McpServerConfig } from './types.js';
import { emitSessionPhase } from '../trace/emit.js';
import type { TraceWriter } from '../trace/index.js';

/**
 * Per-server runtime record. Holds the live client, the list of tools the
 * server published, and the mutable `McpClientState` snapshot we surface
 * to consumers.
 */
interface ServerRecord {
  client: McpClient | undefined;
  tools: McpTool[];
  state: McpClientState;
}

export interface McpManagerInitOptions {
  /**
   * Validation warnings produced by the config loader. The manager echoes
   * these to the console at init time so users see "your mcp.json had X"
   * even if the manager itself never had to fail.
   */
  warnings?: string[];
  /**
   * Optional witness-layer trace writer. When present, `fromConfig` emits a
   * `mcp_server_start`/`mcp_server_done` session_phase pair per server so a
   * latency waterfall can attribute connect cost to individual servers.
   * Purely observational — emission is fire-and-forget and never affects
   * connect behavior or timing.
   */
  traceWriter?: TraceWriter;
}

/**
 * Top-level coordinator. Construct via the static factory
 * `McpManager.fromConfig()` — the constructor itself is private to enforce
 * the async connect step.
 */
export class McpManager {
  private readonly records: Map<string, ServerRecord>;
  /** Reverse map: wireName → { serverName, originalToolName } for handler dispatch. */
  private readonly nameRegistry: Map<string, { serverName: string; originalToolName: string }>;

  /**
   * Optional callback invoked after `refreshServer()` updates the wire-name
   * registry. The provider can subscribe here to signal that its next query
   * will see fresh schemas (Option A: schemas are read fresh per-query via
   * `getMcpTools()`, so this callback is purely informational / for logging
   * or future per-query cache invalidation).
   */
  onToolsRefreshed?: (serverName: string) => void;

  private constructor(records: Map<string, ServerRecord>) {
    this.records = records;
    const regSource: Array<{ serverName: string; toolNames: string[] }> = [];
    for (const [serverName, rec] of records) {
      if (rec.state.status === 'connected') {
        regSource.push({ serverName, toolNames: rec.tools.map((t) => t.name) });
      }
    }
    const registry = buildMcpNameRegistry(regSource);
    if (registry.conflicts.length > 0) {
      const lines = registry.conflicts.map((c) => {
        const pairs = c.pairs.map((p) => `${p.serverName}.${p.originalToolName}`).join(', ');
        return `  ${c.wireName} ← ${pairs}`;
      });
      throw new Error(
        `MCP tool name conflicts (rename one of the servers in mcp.json):\n${lines.join('\n')}`,
      );
    }
    this.nameRegistry = registry.tools;
  }

  /**
   * Load + connect every server. Returns the populated manager even when
   * some servers fail — failures are recorded in per-server `state`.
   * Throws when:
   *   - any `alwaysLoad: true` server fails to connect, or
   *   - the resulting tool set has wire-name conflicts.
   *
   * Side effects: spawns child processes for `stdio` servers; opens
   * sockets for `http` / `sse` servers (PR 2+).
   */
  static async fromConfig(
    servers: Record<string, McpServerConfig>,
    opts: McpManagerInitOptions = {},
  ): Promise<McpManager> {
    if (opts.warnings && opts.warnings.length > 0) {
      for (const w of opts.warnings) console.warn(`[mcp] ${w}`);
    }

    const records = new Map<string, ServerRecord>();
    const connectTasks: Array<Promise<void>> = [];
    // Deferred self-reference box. Filled after `new McpManager(records)`
    // so that `onToolListChanged` closures can call `refreshServer()` even
    // though the manager instance doesn't exist yet when the clients are
    // being wired up. Notifications can only arrive after connect(), which
    // completes before `fromConfig` resolves, so the box is always live by
    // the time any notification fires.
    const managerBox: { manager: McpManager | undefined } = { manager: undefined };

    for (const [serverName, config] of Object.entries(servers)) {
      // Sanity-check the server name itself — we sanitize for wire-encoding
      // but a user typo like "github!" would silently rename to "github_".
      // Surface the rename once at startup so it's not surprising.
      const sanitized = sanitizeNameSegment(serverName);
      if (sanitized !== serverName) {
        console.warn(
          `[mcp] server name "${serverName}" sanitized to "${sanitized}" for wire encoding`,
        );
      }

      if (config.disabled) {
        records.set(serverName, {
          client: undefined,
          tools: [],
          state: {
            serverName,
            config,
            status: 'disabled',
            toolCount: 0,
          },
        });
        continue;
      }

      const state: McpClientState = {
        serverName,
        config,
        status: 'connecting',
        toolCount: 0,
      };
      const record: ServerRecord = { client: undefined, tools: [], state };
      records.set(serverName, record);

      const client = new McpClient(serverName, config);
      record.client = client;

      // Capture stderr-style transport errors so a server that dies mid-
      // session downgrades to `error` rather than crashing the process.
      client.onTransportError = (err) => {
        record.state.status = 'error';
        record.state.error = truncate(err.message, 200);
        console.warn(`[mcp:${serverName}] transport error: ${err.message}`);
      };
      // Wire notifications/tools/list_changed → refreshServer() so the
      // next tool_use round sees the updated tool set without session restart.
      // Constraint (externally-governed — SDK notification path is synchronous):
      // the async refresh must be fire-and-forget. Errors are logged but never
      // thrown — a failed refresh degrades gracefully (stale tools).
      // The manager ref is filled in the box after `new McpManager(records)`
      // returns, so by the time a notification arrives the ref is live.
      client.onToolListChanged = () => {
        void managerBox.manager?.refreshServer(serverName).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[mcp:${serverName}] refreshServer failed: ${msg}`);
        });
      };

      const task = (async () => {
        // Witness layer: bracket this server's connect with a
        // mcp_server_start/done pair. `connectStatus` is updated on each exit
        // path and read by the `finally` so the `done` event fires exactly
        // once regardless of success, oauth-pending, soft error, or the
        // alwaysLoad re-throw. Fire-and-forget — never affects connect timing.
        const serverStartedAt = Date.now();
        void emitSessionPhase(opts.traceWriter, {
          phase: 'mcp_server_start',
          metadata: { server: serverName },
        });
        let connectStatus = 'error';
        let connectedToolCount = 0;
        try {
          const { tools, serverInfo } = await client.connect();
          record.tools = tools;
          record.state.status = 'connected';
          record.state.toolCount = tools.length;
          record.state.lastListedAt = Date.now();
          connectStatus = 'connected';
          connectedToolCount = tools.length;
          const info = serverInfo ? `${serverInfo.name}@${serverInfo.version}` : 'unknown';
          console.log(
            `[mcp:${serverName}] connected (${info}) — ${tools.length} tool(s)`,
          );
        } catch (err) {
          // OAuth pending is NOT an error — the server is waiting for the
          // user to complete the authorization flow. We set a distinct status
          // so `/mcp` can surface the auth URL without showing a scary "error"
          // label. `alwaysLoad` does NOT hard-fail on oauth_pending (the
          // server will become available once the user authorizes).
          if (err instanceof UnauthorizedError) {
            record.state.status = 'oauth_pending';
            connectStatus = 'oauth_pending';
            console.log(
              `[mcp:${serverName}] OAuth authorization required — check Telegram or stderr for the auth URL`,
            );
            return;
          }
          const msg = err instanceof Error ? err.message : String(err);
          record.state.status = 'error';
          record.state.error = truncate(msg, 200);
          if (config.alwaysLoad === true) {
            throw new Error(
              `MCP server "${serverName}" is marked alwaysLoad but failed to connect: ${msg}`,
            );
          }
          console.warn(`[mcp:${serverName}] connect failed: ${msg}`);
        } finally {
          void emitSessionPhase(opts.traceWriter, {
            phase: 'mcp_server_done',
            durationMs: Date.now() - serverStartedAt,
            metadata: {
              server: serverName,
              status: connectStatus,
              toolCount: connectedToolCount,
            },
          });
        }
      })();
      connectTasks.push(task);
    }

    // settle all — but propagate the first `alwaysLoad` failure as a real
    // error so bootstrap aborts. Tear down any clients that DID connect so
    // we don't leave orphan child processes.
    const results = await Promise.allSettled(connectTasks);
    const fatal = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (fatal) {
      for (const rec of records.values()) {
        if (rec.client) {
          await rec.client.disconnect().catch(() => undefined);
        }
      }
      throw fatal.reason;
    }

    const manager = new McpManager(records);
    // Fill the deferred box so onToolListChanged closures can call refreshServer().
    managerBox.manager = manager;
    return manager;
  }

  /**
   * Build the list of Anthropic tool definitions to merge into the
   * provider's `schemas[]`. Only `connected` servers contribute.
   *
   * Result is a fresh array each call so callers can safely mutate (e.g.
   * filter further by permission).
   */
  getMcpTools(): AnthropicToolDef[] {
    const out: AnthropicToolDef[] = [];
    for (const [wireName, { serverName, originalToolName }] of this.nameRegistry) {
      const rec = this.records.get(serverName);
      if (!rec || rec.state.status !== 'connected') continue;
      const tool = rec.tools.find((t) => t.name === originalToolName);
      if (!tool) continue;
      out.push(mcpToolToAnthropic(wireName, tool));
    }
    return out;
  }

  /**
   * Build the wire-name → `ToolHandler` map the dispatcher merges into
   * `handlers`. The handler proxies the call to the appropriate
   * `McpClient.callTool()`.
   */
  getMcpHandlers(): Map<string, ToolHandler> {
    const handlers = new Map<string, ToolHandler>();
    for (const [wireName, { serverName, originalToolName }] of this.nameRegistry) {
      const rec = this.records.get(serverName);
      if (!rec || rec.state.status !== 'connected') continue;
      handlers.set(wireName, async (input, signal) => {
        if (!rec.client) {
          return { content: `MCP server "${serverName}" is not connected`, isError: true };
        }
        return rec.client.callTool(originalToolName, input, signal);
      });
    }
    return handlers;
  }

  /**
   * Re-fetch the tool list for `serverName` and update the wire-name
   * registry in place so the next tool_use round picks up new tools without
   * restarting the session.
   *
   * Called by the `onToolListChanged` closure wired in `fromConfig()` when
   * the server sends `notifications/tools/list_changed`.
   *
   * Registry update strategy:
   *   1. Remove all existing entries that belong to `serverName`.
   *   2. Call `client.refreshTools()` to get the latest tool list.
   *   3. Re-run `buildMcpNameRegistry` for `serverName` alone and merge
   *      the new entries into `this.nameRegistry`.
   *   4. Fire `onToolsRefreshed` so callers can log or react (provider
   *      reads fresh via `getMcpTools()` per-query — no extra step needed).
   *
   * Throws if the server is not currently connected (no client to refresh).
   * The `onToolListChanged` wrapper logs but does not propagate the error.
   */
  async refreshServer(serverName: string): Promise<void> {
    const rec = this.records.get(serverName);
    if (!rec || !rec.client || rec.state.status !== 'connected') {
      throw new Error(
        `McpManager.refreshServer("${serverName}"): server is not connected`,
      );
    }

    const freshTools = await rec.client.refreshTools();

    // Remove stale registry entries for this server.
    for (const [wireName, entry] of this.nameRegistry) {
      if (entry.serverName === serverName) {
        this.nameRegistry.delete(wireName);
      }
    }

    // Rebuild the registry for this server and merge in.
    const partial = buildMcpNameRegistry([
      { serverName, toolNames: freshTools.map((t) => t.name) },
    ]);

    // Conflicts within the refreshed server's own tools are extremely unlikely
    // (a server would have to publish two tools that hash to the same wire
    // name). Log and skip rather than crashing the session.
    if (partial.conflicts.length > 0) {
      for (const c of partial.conflicts) {
        const pairs = c.pairs.map((p) => `${p.serverName}.${p.originalToolName}`).join(', ');
        console.warn(
          `[mcp:${serverName}] wire-name conflict after refresh — skipping: ${c.wireName} ← ${pairs}`,
        );
      }
    }

    for (const [wireName, entry] of partial.tools) {
      this.nameRegistry.set(wireName, entry);
    }

    // Update the stored tool list and metadata.
    rec.tools = freshTools;
    rec.state.toolCount = freshTools.length;
    rec.state.lastListedAt = Date.now();

    console.log(
      `[mcp:${serverName}] tool list refreshed — ${freshTools.length} tool(s)`,
    );
    this.onToolsRefreshed?.(serverName);
  }

  /**
   * Live state snapshot for `/mcp` and the provider's `session.init` event.
   * Returned by value; callers must not retain references across teardown.
   */
  getServerStates(): McpClientState[] {
    return [...this.records.values()].map((rec) => ({ ...rec.state }));
  }

  /** Returns the wire names of all currently-bridged tools. Used by permission allow-lists. */
  getMcpToolWireNames(): string[] {
    return [...this.nameRegistry.keys()];
  }

  /**
   * Complete the OAuth flow for a server in `oauth_pending` state.
   *
   * Delivers `authorizationCode` to the retained transport so it can exchange
   * the code for tokens, then tears down the stale client record and
   * re-connects the server as if it had just been configured.
   *
   * Flow:
   *   1. Validate the server exists and is in `oauth_pending`.
   *   2. Call `client.finishAuth(authorizationCode)` — exchanges code for
   *      tokens via the transport's OAuth token endpoint.
   *   3. Disconnect the stale client (which was never fully connected).
   *   4. Construct a fresh `McpClient` for the same config and call `connect()`.
   *   5. On success: update the server record, rebuild the name registry, fire
   *      `onToolsRefreshed` so callers see the new tools.
   *   6. On failure: leave the server in `error` state (not `oauth_pending`).
   *
   * Throws when the server is not found, not in `oauth_pending`, or when
   * `finishAuth` / reconnect fails.
   */
  async completeAuth(serverName: string, authorizationCode: string): Promise<void> {
    const rec = this.records.get(serverName);
    if (!rec) {
      throw new Error(`McpManager.completeAuth("${serverName}"): server not found`);
    }
    if (rec.state.status !== 'oauth_pending') {
      throw new Error(
        `McpManager.completeAuth("${serverName}"): server is not in oauth_pending state ` +
        `(current status: ${rec.state.status})`,
      );
    }
    if (!rec.client) {
      throw new Error(
        `McpManager.completeAuth("${serverName}"): no client record — server was never connected`,
      );
    }

    // Step 2: exchange code for tokens via the retained transport.
    await rec.client.finishAuth(authorizationCode);

    // Step 3: disconnect the stale client (it never reached `connected` state
    // so this is a best-effort cleanup of the pending transport).
    await rec.client.disconnect().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[mcp:${serverName}] completeAuth disconnect warning: ${msg}`);
    });

    // Step 4: fresh client + connect.
    const freshClient = new McpClient(serverName, rec.state.config);
    freshClient.onTransportError = (err) => {
      rec.state.status = 'error';
      rec.state.error = truncate(err.message, 200);
      console.warn(`[mcp:${serverName}] transport error: ${err.message}`);
    };
    freshClient.onToolListChanged = () => {
      void this.refreshServer(serverName).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[mcp:${serverName}] refreshServer failed: ${msg}`);
      });
    };

    rec.state.status = 'connecting';
    rec.state.error = undefined;
    rec.client = freshClient;

    try {
      const { tools, serverInfo } = await freshClient.connect();
      rec.tools = tools;
      rec.state.status = 'connected';
      rec.state.toolCount = tools.length;
      rec.state.lastListedAt = Date.now();
      const info = serverInfo ? `${serverInfo.name}@${serverInfo.version}` : 'unknown';
      console.log(
        `[mcp:${serverName}] OAuth complete — connected (${info}) — ${tools.length} tool(s)`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      rec.state.status = 'error';
      rec.state.error = truncate(msg, 200);
      throw new Error(`McpManager.completeAuth("${serverName}"): reconnect failed: ${msg}`);
    }

    // Step 5: rebuild name-registry entries for this server.
    for (const [wireName, entry] of this.nameRegistry) {
      if (entry.serverName === serverName) this.nameRegistry.delete(wireName);
    }
    const partial = buildMcpNameRegistry([
      { serverName, toolNames: rec.tools.map((t) => t.name) },
    ]);
    for (const [wireName, entry] of partial.tools) {
      this.nameRegistry.set(wireName, entry);
    }

    this.onToolsRefreshed?.(serverName);
  }

  /**
   * Has at least one server connected? Cheap "is there anything to do"
   * check used to short-circuit empty-config paths.
   */
  hasAnyConnected(): boolean {
    for (const rec of this.records.values()) {
      if (rec.state.status === 'connected') return true;
    }
    return false;
  }

  /** Number of configured (not necessarily connected) servers. */
  size(): number {
    return this.records.size;
  }

  /**
   * Best-effort tear-down of every connected client. Idempotent. Errors
   * are swallowed (logged at debug only) because teardown failures are
   * rarely actionable.
   */
  async disconnectAll(): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const [serverName, rec] of this.records) {
      if (!rec.client) continue;
      tasks.push(
        rec.client.disconnect().catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[mcp:${serverName}] disconnect error: ${msg}`);
        }),
      );
    }
    await Promise.all(tasks);
  }
}

/**
 * Rename an MCP `Tool` to its wire form and translate `inputSchema` →
 * `input_schema` (the only structural difference between the MCP and
 * Anthropic Messages API shapes).
 */
function mcpToolToAnthropic(wireName: string, tool: McpTool): AnthropicToolDef {
  // The MCP `Tool.inputSchema` is structurally identical to the Anthropic
  // shape — a JSON Schema `object` with optional `properties` / `required`.
  // We pass it through verbatim. Description includes the (server.tool)
  // qualifier so the model can disambiguate when multiple servers expose
  // similarly-named tools.
  const description = tool.description ?? `MCP tool ${tool.name}`;
  return {
    name: wireName,
    description,
    // Cast: the MCP schema type is a Zod-derived `object` shape that is
    // structurally identical to Anthropic's `input_schema` requirement.
    input_schema: tool.inputSchema as AnthropicToolDef['input_schema'],
  };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
