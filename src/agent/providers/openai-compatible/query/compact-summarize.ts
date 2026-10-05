/**
 * Summarize-closure construction for `OpenAICompatibleQuery.compactHistory`.
 *
 * Extracted from `query.ts` (350-code-line ceiling, GREW after #2474) as one
 * whole concern: choosing WHICH summarizer the compaction core calls.
 *
 * Contract:
 *   - The session closure reuses the session's own `client`, so the call
 *     inherits the same endpoint, credentials, and wire as the conversation.
 *     Chat Completions sessions go through `oneShotChatCompletion`;
 *     responses-mode sessions go through the caller-supplied
 *     `summarizeViaResponses` (which owns the unsupported-shape latch).
 *   - `resolveCrossProviderSummarize` then swaps in a foreign one-shot closure
 *     when `compactModelRaw` (AFK_COMPACT_MODEL) names a foreign family, and
 *     returns the session closure unchanged on same-family or unset.
 *   - `sessionKey` is the per-session identity the cross-provider resolver keys
 *     its one-time privacy warning on — pass the query instance.
 */
import type OpenAI from 'openai';
import {
  COMPACT_SYSTEM_PROMPT,
  wrapTranscriptForSummary,
} from '../../shared/compaction.js';
import {
  resolveCrossProviderSummarize,
  type SummarizeFn,
} from '../../shared/compact-summarizer.js';
import { oneShotChatCompletion } from '../oneshot.js';
import type { WireMode } from '../responses-config.js';

export interface BuildCompactSummarizeParams {
  wireMode: WireMode;
  client: OpenAI;
  compactModel: string;
  compactModelRaw: string | undefined;
  summarizeViaResponses: (transcript: string, signal: AbortSignal, model: string) => Promise<string>;
  sessionKey: object;
}

export function buildCompactSummarize(params: BuildCompactSummarizeParams): SummarizeFn {
  const { wireMode, client, compactModel, compactModelRaw, summarizeViaResponses, sessionKey } = params;
  const sessionSummarize: SummarizeFn = (transcript, signal) =>
    wireMode === 'responses'
      ? summarizeViaResponses(transcript, signal ?? new AbortController().signal, compactModel)
      : oneShotChatCompletion({
          client,
          model: compactModel,
          system: COMPACT_SYSTEM_PROMPT,
          user: wrapTranscriptForSummary(transcript),
          maxTokens: 1024,
          signal,
        });
  return resolveCrossProviderSummarize('openai-compatible', sessionSummarize, compactModelRaw, sessionKey);
}
