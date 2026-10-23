import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { DEFAULT_SLOT_BINDINGS, setSlotBindings } from '../agent/session/model-slots.js';
import { installCredentialGate } from './first-run.js';
import { applySharedChatOptions } from './commands/shared-command-options.js';
import { loadConfig, loadCredential } from './config.js';
import { preloadClaudeKeychainOAuth } from '../agent/auth/credential-resolver.js';
import { runAuthWizard } from './auth-wizard.js';
import { resolveResumeTarget } from './resume-session.js';

vi.mock('./config.js', () => ({ loadConfig: vi.fn(), loadCredential: vi.fn() }));
vi.mock('../agent/auth/credential-resolver.js', async (original) => ({
  ...await original<typeof import('../agent/auth/credential-resolver.js')>(),
  preloadClaudeKeychainOAuth: vi.fn(),
}));
vi.mock('./auth-wizard.js', () => ({ runAuthWizard: vi.fn() }));
vi.mock('./resume-session.js', () => ({ resolveResumeTarget: vi.fn() }));
vi.mock('dotenv', () => ({ config: vi.fn() }));

function cli() {
  const program = new Command('afk').version('test').option('--no-update-check');
  program.exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  const action = vi.fn();
  applySharedChatOptions(program.command('chat').alias('c').argument('[message]')).action(action);
  applySharedChatOptions(program.command('interactive', { isDefault: true }).alias('i').argument('[input...]')).action(action);
  program.command('farm').option('-m, --model <model>', 'model', 'medium').action(action);
  program.command('daemon').action(action);
  for (const utility of ['login', 'doctor', 'config']) program.command(utility).action(action);
  installCredentialGate(program);
  return { program, action };
}

const originalIsTTY = process.stdin.isTTY;
beforeEach(() => {
  vi.resetAllMocks();
  for (const key of ['AFK_MODEL', 'CLAUDE_MODEL', 'AFK_PROVIDER', 'AFK_OPENAI_BASE_URL', 'AFK_MODEL_MEDIUM', 'AFK_MODEL_LOCAL']) {
    vi.stubEnv(key, undefined);
  }
  vi.mocked(loadConfig).mockImplementation(() => {
    // Simulate the actual config installation: local has an opaque model id,
    // so it cannot pass accidentally via gpt-/org-model prefix heuristics.
    setSlotBindings({ ...DEFAULT_SLOT_BINDINGS, local: { id: 'opaque', name: 'fast', provider: 'openai' } });
    return { updatePolicy: 'off', model: 'medium' } as ReturnType<typeof loadConfig>;
  });
});

afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setSlotBindings(undefined);
});

async function parse(args: string[]) {
  const instance = cli();
  await instance.program.parseAsync(args, { from: 'user' });
  return instance;
}

// The gate must stop the action, not merely set an exit code and continue.
function noCredential() {
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  return vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('credential-gate-exit'); });
}

describe('credential gate after real Commander parsing', () => {
  it.each([
    ['chat', 'hi', '--model', 'local'], ['chat', 'hi', '--model=local'],
    ['c', 'hi', '-mlocal'], ['interactive', '-m', 'local'], ['i', '-m', 'fast'],
    ['--model', 'local'], ['--model=fast'], ['farm', '-m', 'local'],
    ['chat', 'hi', '--provider', 'openai-compatible'], ['--provider=openai-compatible'],
    ['chat', 'hi', '--provider', 'openai'],
  ])('no credential passes non-Anthropic flags: %j', async (...args) => {
    const exit = noCredential();
    const { action } = await parse(args);
    expect(action).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
    expect(preloadClaudeKeychainOAuth).not.toHaveBeenCalled();
    expect(loadCredential).not.toHaveBeenCalled();
    expect(runAuthWizard).not.toHaveBeenCalled();
  });

  it.each([[], ['chat', 'hi'], ['daemon'], ['farm'], ['chat', 'hi', '--model', 'auto']])(
    'no credential gates Anthropic defaults: %j', async (...args) => {
      const exit = noCredential();
      const { program, action } = cli();
      await expect(program.parseAsync(args, { from: 'user' })).rejects.toThrow('credential-gate-exit');
      expect(exit).toHaveBeenCalledWith(1);
      expect(action).not.toHaveBeenCalled();
      expect(preloadClaudeKeychainOAuth).toHaveBeenCalledWith('anthropic-direct');
    },
  );

  it.each(['--help', '-h', '--version', '-V'])('never gates %s', async (flag) => {
    const exit = noCredential();
    await expect(parse([flag])).rejects.toMatchObject({ exitCode: 0 });
    expect(exit).not.toHaveBeenCalled();
    expect(loadCredential).not.toHaveBeenCalled();
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it.each([['login'], ['doctor'], ['--no-update-check', 'login'], ['chat', '--help']])(
    'never gates utilities/help: %j', async (...args) => {
      const exit = noCredential();
      try { await parse(args); } catch (error) {
        expect(error).toMatchObject({ code: 'commander.helpDisplayed', exitCode: 0 });
      }
      expect(exit).not.toHaveBeenCalled();
      expect(loadCredential).not.toHaveBeenCalled();
    },
  );

  it('honors AFK_PROVIDER', async () => {
    noCredential();
    vi.stubEnv('AFK_PROVIDER', 'openai-compatible');
    expect((await parse(['chat', 'hi'])).action).toHaveBeenCalledOnce();
    expect(loadCredential).not.toHaveBeenCalled();
  });

  it('honors AFK_MODEL and the legacy CLAUDE_MODEL fallback', async () => {
    noCredential();
    vi.stubEnv('CLAUDE_MODEL', 'local');
    expect((await parse(['daemon'])).action).toHaveBeenCalledOnce();
    vi.stubEnv('AFK_MODEL', 'fast');
    expect((await parse(['chat', 'hi'])).action).toHaveBeenCalledOnce();
    expect(loadCredential).not.toHaveBeenCalled();
  });

  it('uses the stored REPL model for resume', async () => {
    noCredential();
    vi.mocked(resolveResumeTarget).mockReturnValue({ stored: { model: 'local' } } as ReturnType<typeof resolveResumeTarget>);
    expect((await parse(['interactive', '--resume', 'saved'])).action).toHaveBeenCalledOnce();
    expect(loadCredential).not.toHaveBeenCalled();
  });

  it('does not offer an Anthropic wizard on TTY for a local slot', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    expect((await parse(['chat', 'hi', '-m', 'local'])).action).toHaveBeenCalledOnce();
    expect(runAuthWizard).not.toHaveBeenCalled();
    expect(preloadClaudeKeychainOAuth).not.toHaveBeenCalled();
  });

  it('honors rebound medium/small/large slots without model-name heuristics', async () => {
    noCredential();
    vi.mocked(loadConfig).mockImplementation(() => {
      setSlotBindings({
        local: { id: 'opaque', provider: 'openai' },
        small: { id: 'opaque-small', provider: 'openai' },
        medium: { id: 'opaque-medium', provider: 'openai' },
        large: { id: 'opaque-large', provider: 'chatgpt-oauth' },
        subagent: { id: '' },
      });
      return { model: 'medium', updatePolicy: 'off' } as ReturnType<typeof loadConfig>;
    });
    for (const args of [['chat', 'hi'], ['chat', 'hi', '-m', 'small'], ['chat', 'hi', '-m', 'large']]) {
      expect((await parse(args)).action).toHaveBeenCalledOnce();
    }
    expect(loadCredential).not.toHaveBeenCalled();
  });

  it('uses explicit provider before slots and AFK_PROVIDER', async () => {
    noCredential();
    vi.stubEnv('AFK_PROVIDER', 'anthropic-direct');
    expect((await parse(['chat', 'hi', '-m', 'local', '--provider', 'openai-compatible'])).action).toHaveBeenCalledOnce();
    await expect(parse(['chat', 'hi', '-m', 'local', '--provider', 'anthropic'])).rejects.toThrow('credential-gate-exit');
  });

  it('leaves auto routing sentinel Anthropic unless provider is forced', async () => {
    noCredential();
    expect((await parse(['chat', 'hi', '-m', 'auto', '--provider', 'openai-compatible'])).action).toHaveBeenCalledOnce();
    expect(loadCredential).not.toHaveBeenCalled();
  });

  it('respects -- terminator instead of mistaking prompt text for flags', async () => {
    noCredential();
    await expect(parse(['chat', '--', '--provider=openai-compatible'])).rejects.toThrow('credential-gate-exit');
  });

  it.each([
    { args: ['interactive', '--resume', 'saved', '--continue'], error: 'Use either --resume <id> or --continue, not both.' },
    { args: ['interactive', '--continue'], error: 'No saved sessions found for --continue.' },
    { args: ['interactive', '--continue'], error: 'Corrupt latest session.' },
  ])('leaves resume validation to the action: $error', async ({ args, error }) => {
    vi.mocked(resolveResumeTarget).mockImplementation(() => { throw new Error(error); });
    vi.mocked(loadCredential).mockReturnValue('test-credential');
    const { action } = await parse(args);
    expect(action).toHaveBeenCalledOnce();
    expect(preloadClaudeKeychainOAuth).toHaveBeenCalledWith('anthropic-direct');
    expect(loadCredential).toHaveBeenCalledOnce();
  });

  it('resolveResumeTarget throws do not escape preAction — passes through for non-Anthropic route', async () => {
    vi.mocked(resolveResumeTarget).mockImplementation(() => {
      throw new Error('No saved sessions found for --continue.');
    });
    noCredential();
    // With a non-Anthropic model the gate exits early; action fires normally.
    const { action } = await parse(['interactive', '-m', 'local', '--continue']);
    expect(action).toHaveBeenCalledOnce();
  });

  it('uses normalized config endpoint hints for opaque model ids', async () => {
    noCredential();
    vi.mocked(loadConfig).mockReturnValue({ model: 'medium', updatePolicy: 'off', openaiBaseUrl: 'http://localhost:1234/v1' } as ReturnType<typeof loadConfig>);
    expect((await parse(['chat', 'hi', '-m', 'other-opaque'])).action).toHaveBeenCalledOnce();
    expect(loadCredential).not.toHaveBeenCalled();
  });

  it('rejects invalid flags before auth', async () => {
    noCredential();
    await expect(parse(['daemon', '--model', 'local'])).rejects.toMatchObject({ code: 'commander.unknownOption' });
    await expect(parse(['chat', '--model'])).rejects.toMatchObject({ code: 'commander.optionMissingArgument' });
    await expect(parse(['chat', 'hi', '--provider', 'bogus'])).rejects.toThrow('Invalid --provider');
    expect(preloadClaudeKeychainOAuth).not.toHaveBeenCalled();
  });
});
