/**
 * Barrel import — triggers self-registration side-effects for every skill.
 *
 * Each skill module calls `registerSkill()` at the top level on import.
 * Importing this file ensures all skills are populated in the global
 * registry before any consumer calls `listSkills()` / `getSkill()`.
 */

import './audit-fit/index.js';
// diagnose is a bundled-plugin SKILL.md (awa-bundled/skills/diagnose), not a
// vendored TS registry skill — resolved by the plugin scanner, not registerSkill().
import './get-started/index.js';
import './mint/index.js';
import './service-setup/index.js';
import './telegram-setup/index.js';

// User/project-space skills are scanned lazily by registerBuiltinSkillCommands()
// to avoid blocking module load with filesystem I/O.
export { scanAndRegisterUserSkills, scanSkillsFromDir } from './user-skills.js';
