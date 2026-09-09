/**
 * Session-free plugin-skill registration for the web surface.
 *
 * `registerAll()` (cli/slash/index.ts) registers built-in TS skills
 * (`src/skills/`) and user/project-scope skills, but NOT plugin-discovered
 * skills (from `~/.afk/plugins/` and `src/bundled-plugins/`). Those are
 * normally registered by `registerPluginSkills(session)` after an
 * `AgentSession` initializes -- a path the web server never takes.
 *
 * This module surfaces plugin skills (`review`, `ship`, `diagnose`, etc.)
 * in the slash-command autocomplete menu AND makes them resolvable by the
 * dispatch layer (`classifySlashInput`) by scanning plugin roots via
 * `collectSkillEntries()` -- the same session-free disk walk the REPL's
 * `supportedCommands()` delegates to -- and registering a minimal slash
 * entry for each undiscovered plugin skill.
 *
 * Extracted into its own module so both `routes.ts` (menu population) and
 * `slash-dispatch.ts` (command resolution) can call it without a circular
 * dynamic-import dependency.
 *
 * Must be called AFTER `registerAll()` so built-in skills hold their
 * bare-name slots. Best-effort: a failure leaves the menu with only
 * built-in skills.
 */

export async function registerPluginSkillsForWeb(): Promise<void> {
  try {
    const [{ collectSkillEntries }, { extractHintFromDescription }, { has: registryHas, registerOrReplace }] =
      await Promise.all([
        import('../agent/tools/skill-bridge.js'),
        import('../cli/slash/plugin-skills/flags.js'),
        import('../cli/slash/registry.js'),
      ]);
    const entries = collectSkillEntries();
    for (const entry of entries) {
      const slashName = `/${entry.name}`;
      if (registryHas(slashName)) continue;
      // Register a menu-only entry -- acceptsAttachments marks it as a skill
      // command so classifySlashInput builds the invocation payload.
      const hint = extractHintFromDescription(entry.description);
      registerOrReplace({
        name: slashName,
        summary: entry.description,
        acceptsAttachments: true,
        ...(entry.argumentHint ? { usage: `${slashName} ${entry.argumentHint}` } : {}),
        ...(hint ? { hint } : {}),
        async handler() {
          return 'continue';
        },
      });
    }
  } catch {
    // Plugin discovery is best-effort -- the menu stays usable without it.
  }
}
