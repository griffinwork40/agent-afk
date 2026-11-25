/**
 * Skill-manifest inclusion gate for the OpenAI-compatible provider.
 *
 * Extracted from `index.ts` (350-code-line ceiling). Mirrors
 * `resolveIncludeSkillManifest` in `anthropic-direct/provider-query-setup.ts`.
 *
 * @module agent/providers/openai-compatible/index.skill-manifest
 */

import { skillManifestGranted } from '../shared/tool-grant.js';
import { isSkillManifestAlways } from '../../../config/env.js';

/**
 * Compute the includeSkillManifest flag for buildSystemPromptWiring.
 *
 * Unnamed workers (`isUnnamedWorker=true`) must NOT receive the skill manifest:
 * they cannot invoke skills directly (bare `agent` tool dispatches with no skill
 * executor of their own), and the manifest is the largest single fragment
 * (~78 k chars). The existing `skillManifestGranted` gate does not exclude them
 * because their `grantsTool('skill')` check is true (inherit-all). The
 * `isUnnamedWorker` short-circuit closes that gap (#5311).
 */
export function resolveIncludeSkillManifest(
  hasSkillExecutor: boolean,
  grantsTool: (toolName: string) => boolean,
  isUnnamedWorker: boolean | undefined,
): boolean {
  if (isUnnamedWorker) return false;
  return skillManifestGranted(
    hasSkillExecutor,
    grantsTool,
    isSkillManifestAlways(),
  );
}
