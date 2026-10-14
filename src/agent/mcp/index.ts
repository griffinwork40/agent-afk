/**
 * Public surface for the MCP client subsystem. Importers outside this
 * folder should reach in through this barrel for any symbol it exports.
 * Sub-modules may be imported directly only for symbols not re-exported here.
 *
 * @example
 * ```ts
 * import { McpManager, loadMcpConfig } from './agent/mcp/index.js';
 * const { servers } = await loadMcpConfig();
 * const manager = new McpManager(servers);
 * await manager.connectAll();
 * ```
 *
 * @module agent/mcp
 */

export type {
  McpServerConfig,
  McpClientState,
  McpClientStatus,
  McpTransportType,
} from './types.js';

export { McpManager, type McpManagerInitOptions } from './manager.js';
export {
  loadMcpConfig,
  getMcpConfigPath,
  type LoadedMcpConfig,
  type LoadMcpConfigOptions,
  type McpConfigFile,
} from './config-loader.js';
