/**
 * Backwards-compatibility barrel.
 *
 * Re-exports everything from skill-registry.ts so existing import paths
 * (`from '../../skills/index.js'` or `from '../../skills/'`) continue to
 * resolve without modification.
 *
 * New code should import directly from skill-registry.ts or skill-types.ts.
 */

export type { SkillExecutionContext, SkillMetadata, SkillCategory } from './skill-registry.js';
export {
  SKILL_CATEGORIES,
  UNCATEGORIZED_LABEL,
  isSkillVisible,
  registerSkill,
  getSkill,
  listSkills,
  listVisibleSkills,
  evictSkillsByOrigin,
  _resetRegistry,
} from './skill-registry.js';
