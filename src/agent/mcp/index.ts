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

export { McpClient, type McpClientConnectResult } from './client.js';
export { McpManager, type McpManagerInitOptions } from './manager.js';
export {
  loadMcpConfig,
  loadMcpConfigFile,
  getMcpConfigPath,
  getProjectMcpConfigPath,
  discoverPluginMcpConfigs,
  type LoadedMcpConfig,
  type LoadMcpConfigOptions,
  type McpConfigFile,
} from './config-loader.js';
export {
  buildMcpToolName,
  isMcpToolName,
  buildMcpNameRegistry,
  sanitizeNameSegment,
  type McpNameRegistry,
} from './naming.js';
export { expandEnvString, expandEnvRecord, type EnvExpansionResult } from './env.js';
export {
  createTransport,
  createTransportWithFallbackHint,
  expandHeaders,
  type CreateTransportResult,
} from './transport.js';
export {
  KeychainOAuthProvider,
  readOauthPending,
  clearOauthPending,
  type KeychainBackend,
  type OauthPendingEntry,
} from './oauth.js';
