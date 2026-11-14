/**
 * Canonical, surface-agnostic session controls. Callers own busy admission,
 * turn reservation, terminal/HTTP effects and rendering. No spinner, console
 * writer, or surface detection belongs in this layer. Existing SessionStats
 * and resetStats remain the single source of accounting semantics.
 */
export { clearConversation } from './clear.js';
export { compactConversation, type CompactConversationResult, type CompactProgress } from './compact.js';
export { setSessionModel, type SetSessionModelResult } from './model.js';
export {
  setSessionName, sessionDisplayName, type SetSessionNameResult, type SessionNameOptions,
  THINKING_MODES, getSessionThinking, setSessionThinking,
  readSessionFast, setSessionFast,
  getUsageAwareness, setUsageAwarenessPreference,
} from './preferences.js';
export {
  readContextUsage, readLocalTokenUsage, readTokenUsage,
  readMcpStatus, readMcpOauthPending,
  type ContextUsage, type LocalTokenUsage, type TokenUsage,
} from './reads.js';
