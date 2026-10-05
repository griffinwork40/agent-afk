/**
 * Response rendering helpers for `afk chat`.
 *
 * Extracted from chat.ts to stay under the 350-code-line ceiling (#832).
 * Exports: `renderTextResponse`, `runStreamJsonPath`.
 *
 * Contains the stream-json event loop and the text/json terminal rendering
 * that were previously inlined in registerChatCommand's action handler.
 */

import { palette } from '../palette.js';
import { formatDuration } from '../format-utils.js';
import { costTokenParts } from '../render/session-summary.js';
import { renderMarkdownToTerminal } from '../formatter.js';
import { buildOneShotJsonOutput } from './chat.json-output.js';
import { recordTurn } from '../slash/session-stats.js';
import { jsonDateReplacer } from '../json-date-replacer.js';
import { writeAndDrain } from './chat.stdin-stream.js';
import type { AgentSession } from '../../agent/session.js';
import type { SessionStats } from '../slash/types.js';
import type { AgentModelInput } from '../../agent/types.js';
import type { Ora } from 'ora';

// ---------------------------------------------------------------------------
// Stream-JSON path
// ---------------------------------------------------------------------------

export interface StreamJsonPathParams {
  session: AgentSession;
  message: string;
  stats: SessionStats;
  maybePublish: (reviewText: string, errored: boolean) => Promise<void>;
}

/**
 * Run the stream-json output path: emit raw OutputEvent NDJSON on stdout.
 * Mutates `stats` in place (recordTurn + sessionId capture).
 */
export async function runStreamJsonPath(params: StreamJsonPathParams): Promise<void> {
  const { session, message, stats, maybePublish } = params;
  let streamAssistantText = '';
  let streamErrored = false;
  const stream = session.sendMessageStream(message);
  for await (const event of stream) {
    await writeAndDrain(process.stdout, JSON.stringify(event, jsonDateReplacer) + '\n');
    if (event.type === 'chunk' && event.chunk.type === 'content') {
      streamAssistantText += (event.chunk as { type: 'content'; content: string }).content;
    }
    if (event.type === 'done') {
      recordTurn(stats, message, streamAssistantText, event.metadata);
      if (event.metadata?.sessionId && !stats.sessionId) {
        stats.sessionId = String(event.metadata.sessionId);
      }
    }
    if (event.type === 'error') {
      process.exitCode = 1;
      streamErrored = true;
      break;
    }
  }
  await maybePublish(streamAssistantText, streamErrored);
}

// ---------------------------------------------------------------------------
// Text / JSON path
// ---------------------------------------------------------------------------

export interface TextResponseParams {
  session: AgentSession;
  message: string;
  stats: SessionStats;
  sessionModel: AgentModelInput;
  format: string;
  streamFlag: boolean;
  receiptSessionLabel: string | undefined;
  receiptTracePath: string | undefined;
  maybePublish: (reviewText: string, errored: boolean) => Promise<void>;
  spinner: Ora;
}

/**
 * Run the text or JSON output path: send a single message and render the
 * result. Mutates `stats` in place.
 */
export async function renderTextResponse(params: TextResponseParams): Promise<void> {
  const {
    session,
    message,
    stats,
    sessionModel,
    format,
    streamFlag,
    receiptSessionLabel,
    receiptTracePath,
    maybePublish,
    spinner,
  } = params;

  const response = await session.sendMessage(message, { stream: streamFlag });
  spinner.succeed('Response received');

  const responseMeta = session.getLastResponseMetadata();
  recordTurn(stats, message, response.content, responseMeta ?? undefined);
  if (responseMeta?.sessionId && !stats.sessionId) {
    stats.sessionId = String(responseMeta.sessionId);
  }

  if (format === 'json') {
    console.log(JSON.stringify(buildOneShotJsonOutput({
      sessionModel,
      responseContent: response.content,
      responseTimestamp: response.timestamp,
      responseMeta,
      sessionId: stats.sessionId,
      witnessLabel: receiptSessionLabel,
      tracePath: receiptTracePath,
    }), null, 2));
  } else {
    console.log(palette.heading('\n🤖 Claude:'));
    console.log(renderMarkdownToTerminal(response.content));
    if (responseMeta) {
      const chatParts: string[] = [];
      if (responseMeta.durationMs) chatParts.push(formatDuration(responseMeta.durationMs));
      const chatInputTokens = Number(responseMeta.usage?.['input_tokens'] ?? 0);
      const chatOutputTokens = Number(responseMeta.usage?.['output_tokens'] ?? 0);
      chatParts.push(...costTokenParts({
        costUsd: responseMeta.totalCostUsd,
        tokens: chatInputTokens + chatOutputTokens,
        includeZeroCost: responseMeta.totalCostUsd !== undefined,
      }));
      if (chatParts.length > 0) {
        console.log(palette.dim('  · ' + chatParts.join(' · ')));
      }
    }
    console.log('');
  }

  await maybePublish(response.content, false);
}
