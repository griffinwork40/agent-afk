/**
 * Tool-event aggregation for deriveSessionFacet.
 * Extracted from derive.ts to stay within the 350-code-line ceiling (#3182).
 *
 * Exports: AggregateToolEventsResult, aggregateToolEvents, dedupeToolEvents
 * (dedupeToolEvents is re-exported from derive.ts for external callers).
 */

import { type SubagentInvocation, type ToolEventInput } from './schema.js';
import { detectPrUrlFromEvents } from './derive.pr-detect.js';

const SUBAGENT_TOOLS = new Set(['agent', 'compose', 'skill']);
const FILE_TOOLS = new Set(['read_file', 'write_file', 'edit_file']);
export const EVIDENCE_CAP = 50;
// `(?![\w-])` rejects `git commit-tree` / `git commits` (a trailing word char or
// hyphen) while still matching `git commit`, `git commit -m …`, `git commit;`.
const COMMIT_RE = /\bgit\s+commit(?![\w-])/;
// External-effects bash commands that corroborate a Done without a local file write.
// Matches git push, gh pr create/merge, npm publish, pnpm publish at a word boundary.
const BASH_EXTERNAL_RE = /\b(?:git\s+push|gh\s+pr\s+(?:create|merge)|(?:npm|pnpm)\s+publish)(?![\w-])/;

/** Parse a stringified tool input to an object, swallowing malformed JSON. */
export function parseInput(input: string | undefined): Record<string, unknown> | undefined {
  if (!input) return undefined;
  try {
    const parsed: unknown = JSON.parse(input);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * Invariant: the recorder persists TWO ToolEvent entries per tool call under one
 * toolUseId — an early placeholder emitted at content_block_start (translate.ts:
 * input ' …', no inputRaw, no result) and the real entry emitted post-stream
 * (loop.ts: summarized input + result). Both are pushed to the turn's toolEvents
 * array (turn-handler.ts / background.ts), so counting raw events double-counts
 * every tool. The real entry is always emitted AFTER its placeholder, so a
 * last-write-wins Map keyed by toolUseId keeps the real one; Map iteration order
 * preserves each id's first-seen position (call order). Events without a
 * toolUseId cannot be paired and are kept individually.
 */
export function dedupeToolEvents(events: ToolEventInput[]): ToolEventInput[] {
  const byId = new Map<string, ToolEventInput>();
  const noId: ToolEventInput[] = [];
  for (const ev of events) {
    if (ev.toolUseId === undefined) noId.push(ev);
    else byId.set(ev.toolUseId, ev); // last write wins → real entry supersedes placeholder
  }
  return [...byId.values(), ...noId];
}

export interface AggregateToolEventsResult {
  toolCounts: Record<string, number>;
  toolErrorCategories: Record<string, number>;
  subagents: SubagentInvocation[];
  skills: string[];
  evidencePaths: string[];
  toolErrors: number;
  filesWritten: number;
  filesEdited: number;
  bashCommands: number;
  commits: number;
  /** Bash calls matching BASH_EXTERNAL_RE (git push, gh pr create/merge, npm/pnpm publish) (#3182). */
  bashExternalEffects: number;
  /** GitHub PR URL from a gh pr create result, if found. */
  detectedPrUrl: string | null;
  /** Compose calls with >=1 node that wound down partial (#2970). */
  composePartialNodes: number;
  /** Partial compose nodes summed across calls (#2978). */
  composePartialNodeCount: number;
}

export function aggregateToolEvents(allEvents: ToolEventInput[]): AggregateToolEventsResult {
  const toolCounts: Record<string, number> = {};
  const toolErrorCategories: Record<string, number> = {};
  const subagents: SubagentInvocation[] = [];
  const skills: string[] = [];
  const evidencePaths: string[] = [];
  let toolErrors = 0;
  let filesWritten = 0;
  let filesEdited = 0;
  let bashCommands = 0;
  let commits = 0;
  let bashExternalEffects = 0;
  let composePartialNodes = 0;
  let composePartialNodeCount = 0;
  for (const ev of allEvents) {
    const name = ev.toolName;
    toolCounts[name] = (toolCounts[name] ?? 0) + 1;

    if (ev.isError === true) {
      toolErrors += 1;
      toolErrorCategories[name] = (toolErrorCategories[name] ?? 0) + 1;
    }

    // Prefer inputRaw (full JSON, populated for sessions recorded after this fix) over
    // input (summarized string). For older sidecars without inputRaw, parseInput falls
    // back to input — which will still return undefined for summarized strings, preserving
    // the pre-fix behaviour rather than crashing.
    const parsed = parseInput(ev.inputRaw ?? ev.input);

    if (name === 'write_file') filesWritten += 1;
    if (name === 'edit_file') filesEdited += 1;
    // patch_apply writes files just like write_file/edit_file — count as a file write
    // so sessions using only patch_apply are not wrongly downgraded (#3182).
    if (name === 'patch_apply') filesWritten += 1;
    if (name === 'bash') {
      bashCommands += 1;
      // Commit detection reads the parsed `command` when present (older sidecars
      // written before the secret-at-rest fix) and otherwise falls back to the
      // summarized `input` (a flattened, ≤160-char one-line summary — newlines
      // collapsed to spaces; see summarizeToolInput). The raw `command` is no
      // longer persisted to inputRaw — it can carry inline secrets verbatim — so
      // for current sidecars detection runs against that summary, which catches a
      // `git commit` anywhere in the flattened command (not just line 1). See
      // raw-input.ts.
      const cmd = asString(parsed?.['command']) ?? ev.input;
      if (cmd && COMMIT_RE.test(cmd)) commits += 1;
      // External-effects bash corroborates Done even without a local file write (#3182).
      if (cmd && BASH_EXTERNAL_RE.test(cmd)) bashExternalEffects += 1;
    }

    if (FILE_TOOLS.has(name)) {
      const fp = asString(parsed?.['file_path']);
      if (fp && !evidencePaths.includes(fp) && evidencePaths.length < EVIDENCE_CAP) {
        evidencePaths.push(fp);
      }
    }
    // patch_apply: collect evidence paths from the changes array (each entry has a `path` field).
    if (name === 'patch_apply') {
      const changes = parsed?.['changes'];
      if (Array.isArray(changes)) {
        for (const ch of changes) {
          const fp = asString((ch as Record<string, unknown>)?.['path']);
          if (fp && !evidencePaths.includes(fp) && evidencePaths.length < EVIDENCE_CAP) {
            evidencePaths.push(fp);
          }
        }
      }
    }

    if (SUBAGENT_TOOLS.has(name)) {
      let label: string | undefined;
      if (name === 'skill') {
        label = asString(parsed?.['name']);
        if (label && !skills.includes(label)) skills.push(label);
      } else if (name === 'agent') {
        label = asString(parsed?.['id_prefix']);
      } else {
        label = 'compose';
      }
      subagents.push(label ? { tool: name, label } : { tool: name });
    }

    // Count compose calls that had at least one partial node (#2970).
    // ev.incomplete is set by the compose executor when result.partial.length > 0.
    if (name === 'compose' && ev.incomplete === true) {
      composePartialNodes += 1;
      // #2978: per-node count. A call without a recorded count (pre-#2978)
      // had at least one partial node, so it contributes 1.
      const n = ev.partialNodeCount;
      composePartialNodeCount += typeof n === 'number' && n > 0 ? n : 1;
    }
  }

  // PR detection (#2777, #2795): delegate to the shared helper so subagent
  // journals can reuse identical logic via journal-adapter.ts.
  const detectedPrUrl = detectPrUrlFromEvents(allEvents);

  return {
    toolCounts, toolErrorCategories, subagents, skills, evidencePaths,
    toolErrors, filesWritten, filesEdited, bashCommands, commits,
    bashExternalEffects, detectedPrUrl, composePartialNodes, composePartialNodeCount,
  };
}
