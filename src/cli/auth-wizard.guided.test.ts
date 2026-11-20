import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { runAuthWizard } from './auth-wizard.js';
import { promptSecret } from '../utils/prompt-secret.js';
import { upsertEnvVar } from '../utils/envFile.js';
import { checkCredential } from './auth-wizard.check.js';
import { isDaemonRunning } from './auth-wizard.daemon.js';
import { registerLoginCommand } from './commands/login-command.js';

vi.mock('../utils/prompt-secret.js', () => ({ promptSecret: vi.fn() }));
vi.mock('../utils/envFile.js', () => ({ upsertEnvVar: vi.fn() }));
vi.mock('../paths.js', () => ({ getEnvConfigPath: () => 'fake-config/afk.env' }));
vi.mock('./auth-wizard.check.js', () => ({ checkCredential: vi.fn() }));
vi.mock('./auth-wizard.daemon.js', () => ({ isDaemonRunning: vi.fn() }));
vi.mock('./config.js', () => ({ loadConfig: () => ({}) }));
vi.mock('./shared-helpers.js', () => ({ getModel: () => 'sonnet' }));
vi.mock('../agent/providers/index.js', () => ({ providerForModel: () => 'anthropic-direct' }));
vi.mock('../agent/auth/credential-resolver.js', () => ({
  preloadClaudeKeychainOAuth: vi.fn(), resolveAnthropicCredential: () => undefined,
}));

const stdinTTY = process.stdin.isTTY;
const stdoutTTY = process.stdout.isTTY;
const fakeKey = 'sk-ant-api03-obviously-fake-test';
let log: ReturnType<typeof vi.spyOn>;
function output(): string { return log.mock.calls.flat().join('\n'); }
function tty(input: boolean, outputTTY: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: input, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: outputTTY, configurable: true });
}
beforeEach(() => {
  vi.resetAllMocks();
  tty(true, true);
  vi.stubEnv('AFK_DAEMON_TASK', undefined);
  vi.mocked(promptSecret).mockResolvedValue(fakeKey);
  vi.mocked(checkCredential).mockResolvedValue({ kind: 'accepted' });
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
});
afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: stdinTTY, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: stdoutTTY, configurable: true });
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

describe('guided sign-in', () => {
  it('keeps the daemon restart hint for someone who already runs a daemon', async () => {
    vi.mocked(isDaemonRunning).mockReturnValue(true);
    await runAuthWizard();
    expect(output()).toContain('Restart any running afk daemon to pick up the new token.');
  });
  it('accepts a short y as confirmation', async () => {
    vi.mocked(promptSecret).mockResolvedValueOnce('gateway-obviously-fake').mockResolvedValueOnce('y');
    await runAuthWizard();
    expect(upsertEnvVar).toHaveBeenCalledOnce();
  });
  it('does not mistake another kind of Anthropic key for an OpenAI key', async () => {
    vi.mocked(promptSecret).mockResolvedValue('sk-ant-admin01-obviously-fake');
    await runAuthWizard();
    expect(output()).not.toContain('OpenAI');
    expect(promptSecret).toHaveBeenCalledOnce();
  });
  it('explains keys, billing, Claude Code, other providers and invisible paste before asking', async () => {
    await runAuthWizard();
    expect(output()).toContain('afk is free');
    expect(output()).toContain('Anthropic bills');
    expect(output()).toContain('https://console.anthropic.com');
    expect(output()).toContain('Claude Code login');
    expect(output()).toContain('https://docs.agentafk.com/configuration/api-keys');
    expect(output()).toContain('Nothing will appear');
    expect(log.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(promptSecret).mock.invocationCallOrder[0]!);
    expect(checkCredential).toHaveBeenCalledWith(fakeKey);
    expect(output()).toContain('accepted');
    expect(output()).toContain('Signed in. Type afk chat "hello" to get started.');
    expect(output()).not.toContain('daemon');
  });
  it.each([
    ['sk-proj-obviously-fake', 'OpenAI'], ['sk-obviously-fake', 'OpenAI'],
    ['xai-obviously-fake', 'xAI'], ['gateway-obviously-fake', 'does not look like'],
  ])('confirms suspicious format %s without rejecting gateway keys', async (key, warning) => {
    vi.mocked(promptSecret).mockResolvedValueOnce(key).mockResolvedValueOnce('yes');
    await runAuthWizard();
    expect(output()).toContain(warning);
    expect(promptSecret).toHaveBeenCalledTimes(2);
    expect(upsertEnvVar).toHaveBeenCalledWith('fake-config/afk.env', 'ANTHROPIC_API_KEY', key, ['CLAUDE_CODE_OAUTH_TOKEN']);
  });
  it('does not send or save a suspicious key when confirmation is declined', async () => {
    vi.mocked(promptSecret).mockResolvedValueOnce('gateway-fake').mockResolvedValueOnce('no').mockResolvedValueOnce('');
    await expect(runAuthWizard()).rejects.toThrow('exit');
    expect(checkCredential).not.toHaveBeenCalled(); expect(upsertEnvVar).not.toHaveBeenCalled();
  });
  it('retries rejected credentials and saves only the accepted replacement', async () => {
    vi.mocked(checkCredential).mockResolvedValueOnce({ kind: 'rejected' }).mockResolvedValueOnce({ kind: 'accepted' });
    await runAuthWizard();
    expect(output()).toContain('rejected'); expect(checkCredential).toHaveBeenCalledTimes(2);
    expect(upsertEnvVar).toHaveBeenCalledTimes(1);
  });
  it('stops after three rejections without saving', async () => {
    vi.mocked(checkCredential).mockResolvedValue({ kind: 'rejected' });
    await expect(runAuthWizard()).rejects.toThrow('exit');
    expect(checkCredential).toHaveBeenCalledTimes(3); expect(upsertEnvVar).not.toHaveBeenCalled();
  });
  it('saves no-credit accounts with the existing billing guidance', async () => {
    vi.mocked(checkCredential).mockResolvedValue({ kind: 'credit' });
    await runAuthWizard();
    expect(upsertEnvVar).toHaveBeenCalledOnce(); expect(output()).toContain('credit');
    expect(output()).toContain('https://console.anthropic.com/settings/billing');
  });
  it.each(['yes', 'no'])('offers save anyway for an unknown result: %s', async (answer) => {
    vi.mocked(checkCredential).mockResolvedValue({ kind: 'unknown' });
    vi.mocked(promptSecret).mockResolvedValueOnce(fakeKey).mockResolvedValueOnce(answer);
    if (answer === 'no') await expect(runAuthWizard()).rejects.toThrow('exit');
    else await runAuthWizard();
    expect(promptSecret).toHaveBeenLastCalledWith(expect.stringContaining('Save anyway'));
    expect(upsertEnvVar).toHaveBeenCalledTimes(answer === 'yes' ? 1 : 0);
    expect(output()).not.toContain('Provider accepted');
  });
  it('honestly skips the OAuth live check', async () => {
    vi.mocked(promptSecret).mockResolvedValue('sk-ant-oat01-obviously-fake');
    await runAuthWizard();
    expect(checkCredential).not.toHaveBeenCalled(); expect(output()).toContain('OAuth token was not checked');
    expect(upsertEnvVar).toHaveBeenCalledWith('fake-config/afk.env', 'CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat01-obviously-fake', ['ANTHROPIC_API_KEY']);
  });
  it.each([[false, true], [true, false], [false, false]])('refuses prompts without both terminals: %s %s', async (input, out) => {
    tty(input, out);
    await expect(runAuthWizard()).rejects.toThrow('exit');
    expect(promptSecret).not.toHaveBeenCalled(); expect(checkCredential).not.toHaveBeenCalled();
    expect(output()).not.toContain('afk is free');
  });
  it('refuses a daemon task even with terminals', async () => {
    vi.stubEnv('AFK_DAEMON_TASK', 'fake-task');
    await expect(runAuthWizard()).rejects.toThrow('exit'); expect(promptSecret).not.toHaveBeenCalled();
  });
  it.each([
    [fakeKey, 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
    ['sk-ant-oat01-fake', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
    ['gateway-fake', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
  ])('explicit login token preserves file and variable with no prompt or network: %s', async (key, variable, remove) => {
    tty(false, false);
    const program = new Command(); registerLoginCommand(program);
    await program.parseAsync(['login', key], { from: 'user' });
    expect(upsertEnvVar).toHaveBeenCalledWith('fake-config/afk.env', variable, key, [remove]);
    expect(promptSecret).not.toHaveBeenCalled(); expect(checkCredential).not.toHaveBeenCalled();
    expect(output()).not.toContain('afk is free');
  });
  it('setup is an alias reaching the same guided flow', async () => {
    const program = new Command(); registerLoginCommand(program);
    await program.parseAsync(['setup'], { from: 'user' });
    expect(checkCredential).toHaveBeenCalledOnce(); expect(upsertEnvVar).toHaveBeenCalledOnce();
  });
});
