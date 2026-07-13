/**
 * Slash registry wiring — single entry point.
 *
 * Imports all command modules and registers them with the registry. The
 * interactive REPL calls `registerAll()` once at startup; tests may call
 * `resetRegistry()` + `registerAll()` per case.
 */

import { register, registerIfAbsent, resetRegistry } from './registry.js';
import { coreCommands } from './commands/core.js';
import { infoCommands } from './commands/info.js';
import { planCmd } from './commands/plan.js';
import { afkCmd } from './commands/afk.js';
import { todoCmd } from './commands/todo.js';
import { nameCmd } from './commands/name.js';
import { resumeCmd } from './commands/resume.js';
import { forkCmd } from './commands/fork.js';
import { changelogCmd } from './commands/changelog.js';
import { bgsubCommands } from './commands/bgsub.js';
import { shCmd } from './commands/sh.js';
import { initCmd } from './commands/init.js';
import { statsCmd } from './commands/stats.js';
import { fontSizeCmd } from './commands/font-size.js';
import { thinkingCmd } from './commands/thinking.js';
import { allowDirCmd } from './commands/allow-dir.js';
import { keysCmd } from './commands/keys.js';
import { worktreeCmd } from './commands/worktree.js';
import { reauthCmd } from './commands/reauth.js';
import { transcriptCmd } from './commands/transcript.js';
import { configDoctorCommands } from './commands/config-doctor.js';
import { registerStaticPluginSkillCommands } from './plugin-skills.js';
import { registerStaticPluginAgentCommands } from './plugin-agents.js';
import { registerBuiltinSkillCommands } from './builtin-skills.js';
import { registerMarketplaceCommands } from './marketplace-browse.js';
import '../trusted-skills-registered.js';

export function registerAll(): void {
  resetRegistry();
  for (const cmd of coreCommands) register(cmd);
  for (const cmd of infoCommands) register(cmd);
  register(planCmd);
  register(afkCmd);
  register(todoCmd);
  register(nameCmd);
  register(resumeCmd);
  register(forkCmd);
  register(changelogCmd);
  for (const cmd of bgsubCommands) register(cmd);
  register(shCmd);
  register(initCmd);
  register(statsCmd);
  register(fontSizeCmd);
  register(thinkingCmd);
  register(allowDirCmd);
  register(worktreeCmd);
  register(reauthCmd);
  register(transcriptCmd);
  for (const cmd of configDoctorCommands) register(cmd);
  // Placeholders for plugin-backed commands. The real lists get registered
  // after `session.waitForInitialization()` resolves, via
  // `registerPluginSkills(session)` / `registerPluginAgents(session)` in
  // the interactive command.
  registerBuiltinSkillCommands();
  // keysCmd is registered AFTER builtin/plugin skills so that a user skill
  // named `keys` wins on collision instead of crashing REPL startup (COMPAT-2).
  registerIfAbsent(keysCmd);
  registerStaticPluginSkillCommands();
  registerStaticPluginAgentCommands();
  registerMarketplaceCommands();
}

