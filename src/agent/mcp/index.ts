/**
 * Public surface for the MCP client subsystem. Importers outside this
 * folder should only reach in through this barrel.
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
