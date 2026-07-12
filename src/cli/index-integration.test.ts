import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerChatCommand } from './commands/chat.js';
import { registerInteractiveCommand } from './commands/interactive.js';
import { registerStatusCommand } from './commands/status.js';
import { registerConfigCommand } from './commands/config-command.js';
import { registerDaemonCommand } from './commands/daemon.js';
import { registerLoginCommand } from './commands/login-command.js';
import { registerPluginCommand } from './commands/plugin.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerCompletionCommand } from './commands/completion.js';

describe('CLI integration', () => {
  it('registers all commands', () => {
    const program = new Command();
    registerChatCommand(program);
    registerConfigCommand(program);
    registerDaemonCommand(program);
    registerInteractiveCommand(program);
    registerLoginCommand(program);
    registerPluginCommand(program);
    registerStatusCommand(program);
    registerDoctorCommand(program);
    registerCompletionCommand(program);

    const commandNames = program.commands.map((c) => c.name());
    expect(commandNames).toContain('chat');
    expect(commandNames).toContain('interactive');
    expect(commandNames).toContain('status');
    expect(commandNames).toContain('config');
    expect(commandNames).toContain('daemon');
    expect(commandNames).toContain('login');
    expect(commandNames).toContain('plugin');
    expect(commandNames).toContain('doctor');
    expect(commandNames).toContain('completion');
  });

  it('sets up aliases correctly', () => {
    const program = new Command();
    registerChatCommand(program);
    registerInteractiveCommand(program);
    registerStatusCommand(program);

    program.commands.find((c) => c.name() === 'chat')?.alias('c');
    program.commands.find((c) => c.name() === 'interactive')?.alias('i');
    program.commands.find((c) => c.name() === 'status')?.alias('s');

    expect(program.commands.find((c) => c.name() === 'chat')?.aliases()).toContain('c');
    expect(program.commands.find((c) => c.name() === 'interactive')?.aliases()).toContain('i');
    expect(program.commands.find((c) => c.name() === 'status')?.aliases()).toContain('s');
  });

  it('interactive declares a variadic [input...] arg so `afk "prompt"` / `afk /cmd` seed the REPL', () => {
    // The default command must carry an optional variadic positional. Without
    // it, commander v12 silently DROPS a launch argument (`afk "hi"` starts the
    // REPL but loses "hi"); with it, the arg is captured and seeded as the
    // opening turn. This guards the commander-level half of that feature.
    const program = new Command();
    registerInteractiveCommand(program);
    const interactive = program.commands.find((c) => c.name() === 'interactive');
    expect(interactive).toBeDefined();
    const args = interactive!.registeredArguments;
    expect(args).toHaveLength(1);
    expect(args[0]?.name()).toBe('input');
    expect(args[0]?.variadic).toBe(true);
    expect(args[0]?.required).toBe(false);
  });

  it('supports help text configuration and commands are visible in help', () => {
    const program = new Command();
    registerChatCommand(program);
    registerInteractiveCommand(program);
    registerStatusCommand(program);
    registerDoctorCommand(program);
    registerCompletionCommand(program);

    // Apply the same decoration as index.ts
    program.commands.find((c) => c.name() === 'chat')?.alias('c');
    program.commands.find((c) => c.name() === 'interactive')?.alias('i');
    program.commands.find((c) => c.name() === 'status')?.alias('s');

    // addHelpText should not throw
    program.addHelpText(
      'after',
      `
Examples:
  $ afk chat "What is 2+2?"
  $ afk interactive --model haiku
  $ afk status --format json`,
    );

    const help = program.helpInformation();
    expect(help).toContain('chat');
    expect(help).toContain('interactive');
    expect(help).toContain('status');
    expect(help).toContain('doctor');
    expect(help).toContain('completion');
  });

  it('doctor command is registered', () => {
    const program = new Command();
    registerDoctorCommand(program);

    const doctorCommand = program.commands.find((c) => c.name() === 'doctor');
    expect(doctorCommand).toBeDefined();
    expect(doctorCommand?.description()).toContain('Check system health');
  });

  it('completion command is registered', () => {
    const program = new Command();
    registerCompletionCommand(program);

    const completionCommand = program.commands.find((c) => c.name() === 'completion');
    expect(completionCommand).toBeDefined();
    expect(completionCommand?.description()).toContain('Emit shell completion');
  });
});
