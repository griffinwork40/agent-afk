/**
 * CLI-facing re-export of the shared SKILL.md parser.
 *
 * The parser moved to the layer-neutral `src/utils/skill-md.ts` (#3332) so the
 * agent layer can parse plugin-skill flags during discovery without importing
 * CLI code. This path stays stable for existing CLI importers.
 */

export {
  normalizeFlag,
  extractFlagsFromBody,
  parseFlagsField,
  resolveSkillFlags,
  parseSkillMd,
  harvestFlagsFromSkillMd,
  type ParsedSkillMd,
} from '../../../utils/skill-md.js';
