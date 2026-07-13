/**
 * Inlined type definitions previously imported from `@anthropic-ai/claude-agent-sdk`.
 *
 * These are local copies so agent-afk has zero runtime or type-only dependency
 * on the Agent SDK package. Shapes are sourced from sdk.d.ts v0.2.114.
 *
 * @module agent/types/sdk-types
 */

// ---------------------------------------------------------------------------
// Simple unions / scalars
// ---------------------------------------------------------------------------

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto'
  // AFK mode: the operator is away-from-keyboard. The agent reports terminal
  // state to Telegram and works autonomously on reversible operations, while a
  // mechanical gate (`agent/afk-mode-gate.ts`) refuses high-risk/irreversible
  // ops. agent-afk-local addition (not from the upstream SDK union).
  | 'autonomous';

export type SettingSource = 'user' | 'project' | 'local';

export type ApiKeySource = 'user' | 'project' | 'org' | 'temporary' | 'oauth';

export type SDKStatus = 'compacting' | 'requesting' | null;

// ---------------------------------------------------------------------------
// Thinking
// ---------------------------------------------------------------------------

export type ThinkingAdaptive = {
  type: 'adaptive';
  display?: 'summarized' | 'omitted';
};

export type ThinkingEnabled = {
  type: 'enabled';
  budgetTokens?: number;
  display?: 'summarized' | 'omitted';
};

export type ThinkingDisabled = {
  type: 'disabled';
};

export type ThinkingConfig = ThinkingAdaptive | ThinkingEnabled | ThinkingDisabled;

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export type PermissionBehavior = 'allow' | 'deny' | 'ask';
export type PermissionDecisionClassification =
  | 'user_temporary'
  | 'user_permanent'
  | 'user_reject';
export type PermissionUpdateDestination =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'session'
  | 'cliArg';

export type PermissionRuleValue = {
  toolName: string;
  ruleContent?: string;
};

export type PermissionUpdate =
  | {
      type: 'addRules';
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
      destination: PermissionUpdateDestination;
    }
  | {
      type: 'replaceRules';
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
      destination: PermissionUpdateDestination;
    }
  | {
      type: 'removeRules';
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
      destination: PermissionUpdateDestination;
    }
  | {
      type: 'setMode';
      mode: PermissionMode;
      destination: PermissionUpdateDestination;
    }
  | {
      type: 'addDirectories';
      directories: string[];
      destination: PermissionUpdateDestination;
    }
  | {
      type: 'removeDirectories';
      directories: string[];
      destination: PermissionUpdateDestination;
    };

export type PermissionResult =
  | {
      behavior: 'allow';
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: PermissionUpdate[];
      toolUseID?: string;
      decisionClassification?: PermissionDecisionClassification;
    }
  | {
      behavior: 'deny';
      message: string;
      interrupt?: boolean;
      toolUseID?: string;
      decisionClassification?: PermissionDecisionClassification;
    };

export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    suggestions?: PermissionUpdate[];
    blockedPath?: string;
    decisionReason?: string;
    title?: string;
    displayName?: string;
    description?: string;
    toolUseID: string;
    agentID?: string;
  },
) => Promise<PermissionResult>;

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'Notification'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'StopFailure'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PostCompact'
  | 'PermissionRequest'
  | 'PermissionDenied'
  | 'Setup'
  | 'TeammateIdle'
  | 'TaskCreated'
  | 'TaskCompleted'
  | 'Elicitation'
  | 'ElicitationResult'
  | 'ConfigChange'
  | 'WorktreeCreate'
  | 'WorktreeRemove'
  | 'InstructionsLoaded'
  | 'CwdChanged'
  | 'FileChanged';

export type HookJSONOutput =
  | { async: true; asyncTimeout?: number }
  | { decision?: 'allow' | 'deny' | 'block'; reason?: string };

export type HookCallback = (
  input: Record<string, unknown>,
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<HookJSONOutput>;

export interface HookCallbackMatcher {
  matcher?: string;
  hooks: HookCallback[];
  timeout?: number;
}

// ---------------------------------------------------------------------------
// Elicitation
// ---------------------------------------------------------------------------

export type ElicitationRequest = {
  serverName: string;
  message: string;
  mode?: 'form' | 'url';
  url?: string;
  elicitationId?: string;
  requestedSchema?: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
  // Agent-originated ask_question fields
  origin?: 'agent';
  type?: 'text' | 'confirm' | 'choice' | 'multi_choice' | 'number';
  choices?: string[];
  questionDefault?: string | boolean | number;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  allowSkip?: boolean;
  allowCustom?: boolean;   // opt-in free-form entry for choice/multi_choice; see ask_question tool
  context?: string;
};

export type ElicitationResult = {
  action: 'accept' | 'decline' | 'cancel' | 'skip';
  content?: Record<string, unknown>;
};

export type OnElicitation = (
  request: ElicitationRequest,
  options: { signal: AbortSignal },
) => Promise<ElicitationResult>;

// ---------------------------------------------------------------------------
// Agent definitions
// ---------------------------------------------------------------------------

export type AgentDefinition = {
  description: string;
  tools?: string[];
  disallowedTools?: string[];
  prompt: string;
  model?: string;
  mcpServers?: (string | Record<string, unknown>)[];
  criticalSystemReminder_EXPERIMENTAL?: string;
  skills?: string[];
  initialPrompt?: string;
  maxTurns?: number;
  /**
   * Optional per-agent cap on tool-use rounds within the child's single turn
   * (anti-hang ceiling). Omitted / ≤0 means unlimited. Frontmatter key
   * `maxToolUseIterations` (alias `max-tool-use-iterations`). Honored on the
   * `agent`-tool dispatch path (see child-config.ts) and enforced uniformly by
   * both providers via shared/tool-loop-cap.ts.
   */
  maxToolUseIterations?: number;
  background?: boolean;
  memory?: 'user' | 'project' | 'local';
  effort?: EffortLevel | number;
  permissionMode?: PermissionMode;
};

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

export type SdkPluginConfig = {
  type: 'local';
  path: string;
  /**
   * Optional path (relative to {@link path}, or absolute) of a JS module to
   * dynamically import at session boot, taken from the plugin manifest's `main`
   * field. Importing the module runs its top-level side-effects — e.g.
   * `registerSkill()` calls — so a plugin can contribute code-backed skills or
   * agents without editing core. Resolved and imported by
   * {@link loadPluginEntrypoints}; a failing import is non-fatal. Absent when
   * the manifest declares no `main`.
   */
  main?: string;
};

// ---------------------------------------------------------------------------
// Session info types
// ---------------------------------------------------------------------------

export type AccountInfo = {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  tokenSource?: string;
  apiKeySource?: string;
  apiProvider?:
    | 'firstParty'
    | 'bedrock'
    | 'vertex'
    | 'foundry'
    | 'anthropicAws'
    | 'mantle';
};

export type AgentInfo = {
  name: string;
  description: string;
  model?: string;
};

export type ModelInfo = {
  value: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: EffortLevel[];
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
};

export type McpServerStatus = {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  serverInfo?: { name: string; version: string };
  error?: string;
  config?: Record<string, unknown>;
  scope?: string;
  tools?: {
    name: string;
    description?: string;
    annotations?: {
      readOnly?: boolean;
      destructive?: boolean;
      openWorld?: boolean;
    };
  }[];
};

export type SlashCommand = {
  name: string;
  description: string;
  argumentHint: string;
};

export type SDKControlGetContextUsageResponse = {
  categories: {
    name: string;
    tokens: number;
    color: string;
    isDeferred?: boolean;
  }[];
  totalTokens: number;
  maxTokens: number;
  rawMaxTokens: number;
  percentage: number;
  gridRows: {
    color: string;
    isFilled: boolean;
    categoryName: string;
    tokens: number;
    percentage: number;
    squareFullness: number;
  }[][];
  model: string;
  memoryFiles: {
    path: string;
    type: string;
    tokens: number;
  }[];
  mcpTools: {
    name: string;
    serverName: string;
    tokens: number;
    isLoaded?: boolean;
  }[];
  deferredBuiltinTools?: {
    name: string;
    tokens: number;
    isLoaded: boolean;
  }[];
  systemTools?: {
    name: string;
    tokens: number;
  }[];
  systemPromptSections?: {
    name: string;
    tokens: number;
  }[];
  agents: {
    agentType: string;
    source: string;
    tokens: number;
  }[];
  slashCommands?: {
    totalCommands: number;
    includedCommands: number;
    tokens: number;
  };
  skills?: {
    totalSkills: number;
    includedSkills: number;
    tokens: number;
    skillFrontmatter: {
      name: string;
      source: string;
      tokens: number;
    }[];
  };
  autoCompactThreshold?: number;
  isAutoCompactEnabled: boolean;
  messageBreakdown?: {
    toolCallTokens: number;
    toolResultTokens: number;
    attachmentTokens: number;
    assistantMessageTokens: number;
    userMessageTokens: number;
    redirectedContextTokens: number;
    unattributedTokens: number;
    toolCallsByType: {
      name: string;
      callTokens: number;
      resultTokens: number;
    }[];
    attachmentsByType: {
      name: string;
      tokens: number;
    }[];
  };
  apiUsage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  } | null;
};
