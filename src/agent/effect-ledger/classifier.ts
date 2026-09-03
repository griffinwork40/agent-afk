/**
 * Effect classifier: determines whether a tool call constitutes an external
 * side effect that must be tracked in the ledger.
 *
 * # V1 approach
 *
 * A static allowlist of tool names and (for bash) a command-content scanner.
 * The allowlist is the single source of truth for "what counts as an external
 * effect". Future work can replace `classifyToolCall` with a plugin-based
 * classifier that consults dynamic rules or MCP server metadata.
 *
 * # Extensibility path
 *
 * The public interface is `classifyToolCall(toolName, input) → Classification`.
 * Replace the function body to add dynamic classification; the hook layer
 * consumes only this interface.
 *
 * @module agent/effect-ledger/classifier
 */

// ---------------------------------------------------------------------------
// Static allowlists
// ---------------------------------------------------------------------------

/**
 * Tool names that are ALWAYS external effects regardless of their arguments.
 */
const ALWAYS_EXTERNAL_TOOLS = new Set<string>([
  // Outbound Telegram message
  'send_telegram',
  // MCP write tools match the `mcp__*` prefix pattern — see classifyToolCall.
]);

/**
 * Browser actions that submit data externally (form submit, API call, etc.).
 * `browser_act` is external only when the action is a click or fill on a
 * submit-flavoured target — we approximate with the action type.
 */
const EXTERNAL_BROWSER_ACTIONS = new Set<string>([
  'click',
  'fill',
  'press',
]);

/**
 * Command fragments that indicate a bash invocation produces an external effect.
 * Matched as case-insensitive substrings of the full command string.
 */
const EXTERNAL_BASH_PATTERNS: readonly RegExp[] = [
  // GitHub CLI operations that create/mutate remote state
  /\bgh\s+(pr|issue|release|repo)\s+(create|edit|merge|close|delete|push|comment)/i,
  // git push (including --force variants)
  /\bgit\s+push\b/i,
  // curl / wget POSTing to external APIs
  /\bcurl\b.*(?:\s-X\s*POST|-XPOST|--request\s+POST|-d\s|--data\b|--data-raw\b|-F\s)/i,
  /\bwget\b.*\s(?:--post-data\b|--post-file\b)/i,
  // npm publish / pnpm publish / yarn publish
  /\b(?:npm|pnpm|yarn)\s+publish\b/i,
  // docker push
  /\bdocker\s+push\b/i,
];

// ---------------------------------------------------------------------------
// Classification result
// ---------------------------------------------------------------------------

/** Result returned by the classifier for each tool call. */
export interface Classification {
  /** True when this call is an external side effect that must be ledgered. */
  isExternal: boolean;
  /**
   * Human-readable operation type string (used as the `operationType` field
   * in the effect record). Only meaningful when `isExternal` is true.
   */
  operationType: string;
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Classify a tool call as an external effect or not.
 *
 * @param toolName  The name of the tool being called.
 * @param input     The raw (un-redacted) tool input.
 * @returns         `{ isExternal, operationType }`.
 */
export function classifyToolCall(toolName: string, input: unknown): Classification {
  // MCP write tools: any tool name prefixed with `mcp__` is considered an
  // external mutation regardless of the specific server. Read-only MCP tools
  // cannot be distinguished from their name alone; v1 treats ALL MCP calls as
  // external (conservative). A future classifier can inspect the MCP server
  // schema to exclude read-only operations.
  if (toolName.startsWith('mcp__') || toolName.startsWith('MCP__')) {
    return { isExternal: true, operationType: `mcp_write:${toolName}` };
  }

  // Always-external tool names.
  if (ALWAYS_EXTERNAL_TOOLS.has(toolName)) {
    return { isExternal: true, operationType: toolName };
  }

  // bash: scan command content for external-effect patterns.
  if (toolName === 'bash') {
    const command = extractBashCommand(input);
    if (command !== null) {
      for (const pattern of EXTERNAL_BASH_PATTERNS) {
        if (pattern.test(command)) {
          return { isExternal: true, operationType: 'bash_external' };
        }
      }
    }
    return { isExternal: false, operationType: 'bash' };
  }

  // browser_act: external when it performs a state-changing action.
  if (toolName === 'browser_act') {
    const action = extractBrowserAction(input);
    if (action !== null && EXTERNAL_BROWSER_ACTIONS.has(action)) {
      return { isExternal: true, operationType: 'browser_act_external' };
    }
    return { isExternal: false, operationType: 'browser_act' };
  }

  return { isExternal: false, operationType: toolName };
}

// ---------------------------------------------------------------------------
// Input extractors
// ---------------------------------------------------------------------------

function extractBashCommand(input: unknown): string | null {
  if (input === null || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  const cmd = obj['command'];
  return typeof cmd === 'string' ? cmd : null;
}

function extractBrowserAction(input: unknown): string | null {
  if (input === null || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  const action = obj['action'];
  return typeof action === 'string' ? action : null;
}
