import { describe, it, expect } from 'vitest';
import { escapeForSecurityInteractive, unlockSetupCommand, UNLOCK_SERVICE } from './keychain-unlock.js';
import { buildLaunchScript } from './remote-script.js';
import { runRemoteAgent } from './remote-run.js';
import { EXIT_KEYCHAIN_UNLOCK, PID_MARKER, EXIT_MARKER } from './remote-script.js';
import type { SshRunner } from './ssh-runner.js';

describe('escapeForSecurityInteractive', () => {
  it('escapes backslashes and double quotes for a security -i quoted argument', () => {
    expect(escapeForSecurityInteractive('a"b\\c $d `e`')).toBe('a\\"b\\\\c $d `e`');
  });
  it('rejects passwords that cannot ride on one stdin line', () => {
    expect(() => escapeForSecurityInteractive('a\nb')).toThrow('newline');
  });
});

describe('unlockSetupCommand', () => {
  it('stores under the afk-remote-unlock service with the host name as account', () => {
    expect(unlockSetupCommand('cm')).toBe(`security add-generic-password -U -s ${UNLOCK_SERVICE} -a cm -w`);
  });
});

describe('launch script keychain unlock', () => {
  const base = { runId: 'r1', sessionId: 's1', prompt: 'hello' };

  it('embeds the password as a heredoc before the prompt heredoc, pipes it into security -i', () => {
    const s = buildLaunchScript({ ...base, keychainPassword: 'p\\"w' });
    // Password heredoc must appear before prompt heredoc
    const keychainAt = s.indexOf('p\\"w');
    expect(keychainAt).toBeGreaterThan(-1);
    expect(s).toContain('| security -i');
    expect(s).toContain('kcpw=');
    expect(s).toContain(`exit ${EXIT_KEYCHAIN_UNLOCK}`);
    expect(s).not.toMatch(/security unlock-keychain/);
    // Must use IFS= read -r heredoc (not the old $( ) command-substitution pattern)
    expect(s).toContain('IFS= read -r kcpw');
    expect(s).not.toContain('kcpw=$(cat');
    // No cat > "$d/prompt" (old stdin pattern)
    expect(s).not.toMatch(/\bcat\b.*>\s*["']?\$d\/prompt/);
  });

  it('omits the unlock entirely when no keychainPassword is provided', () => {
    expect(buildLaunchScript(base)).not.toContain('kcpw');
  });
});

function runner(launchCode: number, captured: { script?: string }, errTail = ''): SshRunner {
  return {
    async exec(_t, script, _o = {}) {
      if (script.includes(PID_MARKER)) {
        captured.script = script;
        return launchCode === 0
          ? { code: 0, stdout: `${PID_MARKER} 9\n`, stderr: '' }
          : { code: launchCode, stdout: '', stderr: 'could not unlock' };
      }
      return { code: 0, stdout: errTail, stderr: '' };
    },
    async stream(_t, _s, o) { o.onLine(EXIT_MARKER); return { code: 0, stdout: '', stderr: '' }; },
  };
}
const REQ = { target: 'me@cm', hostName: 'cm', prompt: 'line1\nline2', runId: 'r', sessionId: 's' };

describe('runRemoteAgent with keychainPassword', () => {
  it('embeds the escaped password in the script, not on stdin', async () => {
    const cap: { script?: string } = {};
    await runRemoteAgent({ ...REQ, keychainPassword: 'p"w' }, new AbortController().signal, { runner: runner(0, cap) });
    // The escaped password must appear inside the generated script
    expect(cap.script).toContain('p\\"w');
    // The prompt must also appear in the script
    expect(cap.script).toContain('line1');
  });

  it('maps a failed unlock to a re-store instruction without leaking the password', async () => {
    const out = await runRemoteAgent({ ...REQ, keychainPassword: 'sekret' }, new AbortController().signal, { runner: runner(EXIT_KEYCHAIN_UNLOCK, {}) });
    expect(out.kind === 'error' && out.reason).toContain('could not unlock the login keychain on me@cm');
    expect(out.kind === 'error' && out.reason).toContain('-a cm -w');
    expect(JSON.stringify(out)).not.toContain('sekret');
  });

  it('skips the keychain hint when the run was already unlocked', async () => {
    const out = await runRemoteAgent({ ...REQ, keychainPassword: 'x' }, new AbortController().signal,
      { runner: runner(0, {}, 'No Anthropic credential found. Run `afk login`') });
    expect(out.kind === 'error' && out.reason).not.toContain('Hint:');
  });

  it('without unlock, the hint is platform-neutral and names the unlockKeychain setup for the host', async () => {
    const out = await runRemoteAgent(REQ, new AbortController().signal,
      { runner: runner(0, {}, 'No Anthropic credential found. Run `afk login`') });
    expect(out.kind === 'error' && out.reason).toContain('"unlockKeychain": true for "cm"');
    expect(out.kind === 'error' && out.reason).toContain('If cm is a macOS host');
    expect(out.kind === 'error' && out.reason).not.toContain("cm's macOS login keychain is locked");
  });
});
