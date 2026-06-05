import { Command } from 'commander';

const SUBCOMMANDS = [
  'chat',
  'interactive',
  'status',
  'config',
  'daemon',
  'login',
  'plugin',
  'doctor',
  'completion',
] as const;

const PLUGIN_SUBCOMMANDS = ['install', 'update', 'list', 'remove', 'enable', 'disable'] as const;

const MODEL_VALUES = ['sonnet', 'opus', 'haiku'] as const;

const FORMAT_VALUES = ['json', 'text'] as const;

const TRIGGER_VALUES = ['cron', 'sessionstart', 'both'] as const;

/** Build a space-separated string from a constant array */
function joinValues<T extends readonly string[]>(values: T): string {
  return values.join(' ');
}

function zshScript(): string {
  const models = joinValues(MODEL_VALUES);
  const formats = joinValues(FORMAT_VALUES);
  const triggers = joinValues(TRIGGER_VALUES);

  return `#compdef afk

_afk() {
  local -a commands
  commands=(
    'chat:Send a single chat message'
    'interactive:Start an interactive REPL'
    'status:Show CLI status'
    'config:Show resolved configuration'
    'daemon:Run as background daemon'
    'login:Save Anthropic API key'
    'plugin:Manage plugins'
    'doctor:Run self-check'
    'completion:Emit shell completion script'
  )
  _describe -t commands 'afk command' commands

  # Plugin subcommands
  case "\${words[2]}" in
    plugin)
      local -a plugin_commands
      plugin_commands=(
        'install:Install a plugin'
        'update:Update one or all plugins'
        'list:List installed plugins'
        'remove:Remove a plugin'
        'enable:Re-enable a plugin'
        'disable:Disable a plugin'
      )
      _describe -t plugin_commands 'plugin subcommand' plugin_commands
      ;;
  esac

  # Flag completions
  case "\${words[CURRENT-1]}" in
    --model|-m)
      compadd -a '${models}'
      ;;
    --format|-f)
      compadd -a '${formats}'
      ;;
    --trigger)
      compadd -a '${triggers}'
      ;;
  esac
}

compdef _afk afk`;
}

function bashScript(): string {
  const subcommands = joinValues(SUBCOMMANDS);
  const pluginSubs = joinValues(PLUGIN_SUBCOMMANDS);
  const models = joinValues(MODEL_VALUES);
  const formats = joinValues(FORMAT_VALUES);
  const triggers = joinValues(TRIGGER_VALUES);

  return `_afk_complete() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  case "$prev" in
    afk)
      COMPREPLY=($(compgen -W "${subcommands}" -- "$cur"))
      ;;
    plugin)
      COMPREPLY=($(compgen -W "${pluginSubs}" -- "$cur"))
      ;;
    --model|-m)
      COMPREPLY=($(compgen -W "${models}" -- "$cur"))
      ;;
    --format|-f)
      COMPREPLY=($(compgen -W "${formats}" -- "$cur"))
      ;;
    --trigger)
      COMPREPLY=($(compgen -W "${triggers}" -- "$cur"))
      ;;
    *)
      COMPREPLY=($(compgen -W "--help --version" -- "$cur"))
      ;;
  esac
}

complete -F _afk_complete afk`;
}

function fishScript(): string {
  const models = joinValues(MODEL_VALUES);
  const formats = joinValues(FORMAT_VALUES);
  const triggers = joinValues(TRIGGER_VALUES);

  return `complete -c afk -f
# afk subcommands
complete -c afk -n '__fish_use_subcommand' -a 'chat' -d 'Send a single chat message'
complete -c afk -n '__fish_use_subcommand' -a 'interactive' -d 'Start an interactive REPL'
complete -c afk -n '__fish_use_subcommand' -a 'status' -d 'Show CLI status'
complete -c afk -n '__fish_use_subcommand' -a 'config' -d 'Show resolved configuration'
complete -c afk -n '__fish_use_subcommand' -a 'daemon' -d 'Run as background daemon'
complete -c afk -n '__fish_use_subcommand' -a 'login' -d 'Save Anthropic API key'
complete -c afk -n '__fish_use_subcommand' -a 'plugin' -d 'Manage plugins'
complete -c afk -n '__fish_use_subcommand' -a 'doctor' -d 'Run self-check'
complete -c afk -n '__fish_use_subcommand' -a 'completion' -d 'Emit shell completion script'

# plugin subcommands
complete -c afk -n '__fish_seen_subcommand_from plugin' -a 'install' -d 'Install a plugin'
complete -c afk -n '__fish_seen_subcommand_from plugin' -a 'update' -d 'Update one or all plugins'
complete -c afk -n '__fish_seen_subcommand_from plugin' -a 'list' -d 'List installed plugins'
complete -c afk -n '__fish_seen_subcommand_from plugin' -a 'remove' -d 'Remove a plugin'
complete -c afk -n '__fish_seen_subcommand_from plugin' -a 'enable' -d 'Re-enable a plugin'
complete -c afk -n '__fish_seen_subcommand_from plugin' -a 'disable' -d 'Disable a plugin'

# flags: --model, --format, --trigger
complete -c afk -l model -s m -x -a '${models}' -d 'Model to use'
complete -c afk -l format -s f -x -a '${formats}' -d 'Output format'
complete -c afk -l trigger -x -a '${triggers}' -d 'Trigger type'`;
}

export function registerCompletionCommand(program: Command): void {
  program
    .command('completion <shell>')
    .description('Emit shell completion script (zsh|bash|fish)')
    .action((shell: string) => {
      const validShells = ['zsh', 'bash', 'fish'];
      if (!validShells.includes(shell)) {
        program.error(`unknown shell: ${shell}. Choose from: ${validShells.join(', ')}`);
        return;
      }

      let script = '';
      switch (shell) {
        case 'zsh':
          script = zshScript();
          break;
        case 'bash':
          script = bashScript();
          break;
        case 'fish':
          script = fishScript();
          break;
      }

      console.log(script);
    });
}
