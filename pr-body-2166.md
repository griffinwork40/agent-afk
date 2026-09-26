Closes #2166

## Summary

Expose a scoped `registerHook` capability in `PluginApi`. Plugin entrypoints declare in process hook handlers once at boot; every subsequently created default session hook registry receives those handlers. The REPL also installs them on its already constructed registry after plugin activation. Plugins receive registration only, not dispatch or inspection authority.

## Verification

* `pnpm test src/agent/plugins/load-entrypoints.test.ts`: 11 passed, including cross session installation and unsubscribe coverage.
* `pnpm test src/agent/hooks.test.ts src/agent/hook-registry.test.ts src/telegram/bot.test.ts`: 69 passed.
* `pnpm lint`: passed.
* `pnpm audit:module-state:check`: passed.
* `git diff --check`: passed.

## Existing environment and baseline limitations

* `pnpm build` cannot complete in this isolated worktree because `dashboard/node_modules` is missing; the build reports to run `pnpm install` in `dashboard/`.
* `pnpm audit:filesize:check` reports preexisting growth in unrelated `src/cli/commands/interactive/tool-lane.ts` and `src/config/env.ts`, neither touched here.
