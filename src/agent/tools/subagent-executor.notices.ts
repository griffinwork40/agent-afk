import type { ToolResult } from '../providers/anthropic-direct/types.js';
import type { TraceSink } from '../trace/index.js';
import { supportsVision } from '../model-capabilities.js';
import { catalogUpgradeNotice } from '../providers/openai-compatible/catalog-awareness.js';
import { collectPostRunWarnings } from './subagent-executor.write-intent.js';
import { prependUsageNotice } from './usage-notice.js';

/** Append catalog metadata to a tool result, without changing model selection. */
export async function withCatalogNotice(result: Promise<ToolResult>, model: string, trace: TraceSink | undefined): Promise<ToolResult> {
  const notice = catalogUpgradeNotice(model, trace);
  const resolved = await result;
  if (notice) resolved.content += `\n${notice}`;
  return resolved;
}
/** Existing tool-result notices, plus catalog metadata. Not a prompt overlay. */
export function addForegroundNotices(result: ToolResult, model: string, attachments: boolean, name: string | undefined, prompt: string, writable: boolean, usage: string | undefined, trace: TraceSink | undefined): void {
  const warning = collectPostRunWarnings(model, attachments, name, prompt, writable, supportsVision);
  if (warning && !result.isError) result.content = warning + result.content;
  result.content = prependUsageNotice(usage, result.content);
  const upgrade = catalogUpgradeNotice(model, trace);
  if (upgrade) result.content += `\n${upgrade}`;
}
