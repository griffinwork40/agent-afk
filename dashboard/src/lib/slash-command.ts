/** Return a slash-command name without its optional leading slash. */
export function bareSlashCommandName(name: string): string {
  return name.startsWith('/') ? name.slice(1) : name;
}

/** Return a slash-command name with exactly one leading slash. */
export function formatSlashCommandName(name: string): string {
  return `/${bareSlashCommandName(name)}`;
}

/** Match the bare query extracted from the composer against a command name. */
export function slashCommandMatchesQuery(name: string, query: string): boolean {
  return bareSlashCommandName(name).startsWith(query);
}
