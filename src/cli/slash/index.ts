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
import { tasksCommands } from './commands/tasks.js';
import { shCmd } from './commands/sh.js';
import { initCmd } from './commands/init.js';
import { statsCmd } from './commands/stats.js';
import { fontSizeCmd } from './commands/font-size.js';
import { thinkingCmd } from './commands/thinking.js';
import { fastCmd } from './commands/fast.js';
import { themeCmd } from './commands/theme.js';
import { allowDirCmd } from './commands/allow-dir.js';
import { keysCmd } from './commands/keys.js';
import { worktreeCmd } from './commands/worktree.js';
import { reauthCmd } from './commands/reauth.js';
import { retryCmd } from './commands/retry.js';
import { transcriptCmd } from './commands/transcript.js';
import { editorCmd } from './commands/editor.js';
import { afkMdCmd } from './commands/afk-md.js';
import { searchCmd } from './commands/search.js';
import { diffCmd } from './commands/diff.js';
import { copyCmd } from './commands/copy.js';
import { configDoctorCommands } from './commands/config-doctor.js';
import { ghostCmd } from './commands/ghost.js';
import { suggestionsCmd } from './commands/suggestions.js';
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
  for (const cmd of tasksCommands) register(cmd);
  register(shCmd);
  register(initCmd);
  register(statsCmd);
  register(fontSizeCmd);
  register(thinkingCmd);
  register(fastCmd);
  register(themeCmd);
  register(allowDirCmd);
  register(worktreeCmd);
  register(reauthCmd);
  register(retryCmd);
  register(transcriptCmd);
  register(editorCmd);
  register(afkMdCmd);
  register(searchCmd);
  register(diffCmd);
  register(copyCmd);
  for (const cmd of configDoctorCommands) register(cmd);
  register(ghostCmd);
  register(suggestionsCmd);
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

