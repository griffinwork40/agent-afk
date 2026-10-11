/**
 * Public surface for the MCP client subsystem. Importers outside this
 * folder should reach in through this barrel for any symbol it exports.
 * Sub-modules may be imported directly only for symbols not re-exported
 * here (e.g. dynamic imports of non-public internals).
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
