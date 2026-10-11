/**
 * Tool definitions (JSON Schema) for the built-in tools.
 *
 * Each entry is an `AnthropicToolDef` sent as the `tools` parameter to
 * `messages.create`. The `description` field is the model's primary guidance
 * on when and how to use the tool — keep it thorough.
 *
 * This file is intentionally a thin barrel: each tool family lives in its own
 * sibling file (schemas.<concern>.ts) to respect the 350-code-line ceiling.
 *
 * @module agent/tools/schemas
 */

import type { AnthropicToolDef } from './types.js';

// ── File-system tools ──────────────────────────────────────────────────────
import {
  readFileTool,
  viewImageTool,
  extractDocumentTool,
  writeFileTool,
  editFileTool,
  globTool,
  grepTool,
  listDirectoryTool,
} from './schemas.file-tools.js';

// ── Shell tool ─────────────────────────────────────────────────────────────
import { bashTool } from './schemas.bash.js';

// ── Web / network tools ────────────────────────────────────────────────────
import {
  sendTelegramTool,
  webScrapeTool,
  webRequestTool,
  imageGenerateTool,
  imageEditTool,
} from './schemas.web-tools.js';

// ── Schedule tools ─────────────────────────────────────────────────────────
import {
  createScheduleTool,
  updateScheduleTool,
  listSchedulesTool,
  getScheduleHistoryTool,
  cancelScheduleTool,
} from './schemas.schedule.js';

// ── Subagent orchestration tools ───────────────────────────────────────────
import { agentTool, skillTool, composeTool } from './schemas.agent-tools.js';
export { agentTool, skillTool, composeTool } from './schemas.agent-tools.js';

// ── Worktree + config tools ────────────────────────────────────────────────
import {
  worktreeTool,
  terminalFontSizeTool,
  configGetTool,
  configSetTool,
} from './schemas.worktree-tools.js';

// ── User interaction + clipboard tools ────────────────────────────────────
import {
  askQuestionTool,
  clipboardWriteTool,
  clipboardReadTool,
} from './schemas.interaction-tools.js';
export { clipboardWriteTool, clipboardReadTool } from './schemas.interaction-tools.js';

// ── Browser-control tools ──────────────────────────────────────────────────
// Invariant: these schemas are wire-projected by `toWireToolDef` in
// `providers/anthropic-direct/types.ts` so the `category: 'browser'` field
// never crosses the API boundary.
//
// History: the underlying provider (PlaywrightProvider) is lazy-loaded by
// `src/browser/registry.ts` on first call to a browser tool. Users who
// never invoke a browser tool never pay the 300MB Playwright + browser
// disk cost.
import {
  browserOpenTool,
  browserObserveTool,
  browserActTool,
  browserScreenshotTool,
  browserCloseTool,
} from './schemas.browser-tools.js';

// ── Orchestration (background jobs, patch-apply, witness) ─────────────────
import { cancelBackgroundJobTool, patchApplyTool, sendMessageToAgentTool, getBackgroundJobHealthTool } from './schemas.orchestration.js';
import { readWitnessTool, searchWitnessTool } from './schemas.witness.js';
import { listSessionsTool, sendToSessionTool } from './schemas.peer.js';
import { waitForTool } from './schemas.wait-for.js';
import { testRunTool } from './schemas.test-run.js';
import { getFacetTool } from './schemas.facet.js';
import { jsonQueryTool } from './schemas.json-query.js';
import { modelCompleteTool } from './schemas.model-complete.js';

/**
 * The always-on built-in tool definitions,
 * ready to pass as `tools` to `messages.create`.
 *
 * Does NOT include `agentTool`, `skillTool`, or `composeTool` — those are
 * gated on session opts (subagentExecutor / skillExecutor / composeExecutor)
 * and are added at provider-construction time. Use `ALL_TOOL_SCHEMAS` for
 * closed-world enumeration (classification tests, schema audits).
 *
 * Browser tools (browser_open, _observe, _act, _screenshot, _close) are
 * registered unconditionally — the underlying provider lazy-loads Playwright
 * only when a tool is actually invoked, so users who never call them pay
 * zero runtime cost beyond the schema bytes.
 */
export const builtinToolSchemas: readonly AnthropicToolDef[] = [
  bashTool,
  readFileTool,
  viewImageTool,
  extractDocumentTool,
  writeFileTool,
  editFileTool,
  globTool,
  grepTool,
  listDirectoryTool,
  sendTelegramTool,
  webScrapeTool,
  webRequestTool,
  imageGenerateTool,
  imageEditTool,
  createScheduleTool,
  updateScheduleTool,
  listSchedulesTool,
  getScheduleHistoryTool,
  cancelScheduleTool, cancelBackgroundJobTool, sendMessageToAgentTool, getBackgroundJobHealthTool,
  readWitnessTool, searchWitnessTool,
  worktreeTool, terminalFontSizeTool,
  configGetTool, configSetTool,
  askQuestionTool, waitForTool,
  browserOpenTool,
  browserObserveTool,
  browserActTool,
  browserScreenshotTool,
  browserCloseTool, patchApplyTool,
  testRunTool,
  getFacetTool,
  jsonQueryTool,
  modelCompleteTool,
  clipboardWriteTool,
  clipboardReadTool,
  listSessionsTool,
  sendToSessionTool,
];

/** Tool names in the always-on built-in set. */
export const BUILTIN_TOOL_NAMES = builtinToolSchemas.map((t) => t.name);

/**
 * Canonical closed-world set: every tool schema the provider layer can
 * register, including the opt-in orchestration tools (`agentTool`,
 * `skillTool`, `composeTool`).
 *
 * Memory tools (`memory_search`, `memory_update`, `procedure_write`) live in
 * `../memory/memory-tools.ts` and are NOT included here — they are loaded as
 * a separate registry. Consumers that need the full universe must concat
 * `memoryToolSchemas` themselves (see `schema-classification.test.ts`).
 */
export const ALL_TOOL_SCHEMAS: readonly AnthropicToolDef[] = [
  ...builtinToolSchemas,
  agentTool,
  skillTool,
  composeTool,
];
