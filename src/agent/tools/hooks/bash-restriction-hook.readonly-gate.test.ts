/**
 * Write-hole regression + SSH public-key grant for the bash-restriction hook.
 *
 * The exact-file carve-outs (`~/.ssh/config`, `~/.ssh/known_hosts`,
 * `~/.afk/config/mcp.json`, `~/.afk/config/schedules.json`) were scrubbed from
 * the scanned command REGARDLESS of what the command did with them, so writes
 * (ProxyCommand injection, known_hosts trust injection, MCP server planting)
 * returned allow on interactive surfaces. The scrub is now gated on
 * `isProvablyReadOnly`. Every command here is spelled with `~/` / `$HOME/`
 * so the suite is portable (no platform gate — POSIX guard R4).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homedir } from 'os';
import { join, resolve } from 'path';

import { createBashRestrictionHook } from './bash-restriction-hook.js';
import { isProvablyReadOnly } from './bash-restriction-hook.readonly-gate.js';
import { _resetReadDenylistCacheForTests, isReadDenied } from '../handlers/read-denylist.js';
import type { GrantManager } from '../grant-manager.js';
import type { PreToolUseContext } from '../../hooks.js';

function mockGrants(): GrantManager {
  return {
    addReadRoot: () => {},
    addWriteRoot: () => {},
    revokeRoot: () => {},
    getGrants() {
      return { resolveBase: resolve('/tmp/repo'), readRoots: [resolve('/tmp/repo')], writeRoots: [resolve('/tmp/repo')] };
    },
  };
}

function ctx(command: string): PreToolUseContext {
  return { event: 'PreToolUse', toolName: 'bash', input: { command }, grantManager: mockGrants() };
}

const hook = createBashRestrictionHook({});
const decide = (cmd: string): string | undefined => hook(ctx(cmd)).decision;

afterEach(() => {
  delete process.env['AFK_READ_DENYLIST'];
  _resetReadDenylistCacheForTests();
});

describe('carve-out write hole — every probe blocks (interactive surface)', () => {
  const probes = [
    // The five commands from the original probe.
    `printf 'Host *\\n  ProxyCommand touch /tmp/pwned\\n' >> ~/.ssh/config`,
    `echo 'evil.com ssh-ed25519 AAAA' >> ~/.ssh/known_hosts`,
    `sed -i '' 's/a/b/' ~/.ssh/config`,
    'cp /tmp/x ~/.ssh/config',
    'tee -a ~/.ssh/config < /tmp/x',
    // Every redirection form.
    'echo x > ~/.ssh/config',
    'echo x >| ~/.ssh/config',
    'echo x &> ~/.ssh/config',
    'echo x 1> ~/.ssh/config',
    'cat ~/.ssh/config 1>~/.ssh/known_hosts',
    'cat <> ~/.ssh/config',
    'cat /tmp/x>~/.ssh/config',
    // Write-capable "readers" deliberately left off the allowlist.
    'mv /tmp/x ~/.ssh/known_hosts',
    'install /tmp/x ~/.ssh/config',
    'ln -sf /tmp/x ~/.ssh/config',
    'dd if=/tmp/x of=~/.ssh/config',
    'truncate -s0 ~/.ssh/known_hosts',
    `sed -n 'w /tmp/out' ~/.ssh/config`,
    `sed '1w ~/.ssh/config' /tmp/x`,
    `awk '{print > "/tmp/o"}' ~/.ssh/config`,
    'sort -o ~/.ssh/known_hosts /tmp/x',
    'uniq /tmp/x ~/.ssh/known_hosts',
    `rg --pre 'sh -c' x ~/.ssh/config`,
    'less ~/.ssh/config',
    'more ~/.ssh/config',
    // Chaining, background, substitution, env prefix, wrappers.
    'cat ~/.ssh/config; touch /tmp/x',
    'cat ~/.ssh/config && rm -f /tmp/x',
    'cat ~/.ssh/config || true',
    'cat ~/.ssh/config & echo x',
    'cat ~/.ssh/config\ntouch ~/.ssh/config',
    'cat $(echo ~/.ssh/config)',
    'cat `echo ~/.ssh/config`',
    'cat <(cat ~/.ssh/config)',
    'diff ~/.ssh/config <(echo x)',
    'LC_ALL=C cat ~/.ssh/config',
    'env cat ~/.ssh/config',
    'xargs cat ~/.ssh/config',
    'cat $X ~/.ssh/config',
    // Interpreter one-liners: the signal check used to read the scrubbed string.
    `python -c "open(expanduser('~/.ssh/config'),'a').write('x')"`,
    `python3 -c "print(open('~/.ssh/known_hosts').read())"`,
    `node -e "require('fs').appendFileSync('~/.afk/config/mcp.json','x')"`,
    // The AFK config carve-outs share the class (mcp.json/schedules.json = exec).
    `echo '{"mcpServers":{"x":{"command":"sh"}}}' > ~/.afk/config/mcp.json`,
    'tee ~/.afk/config/schedules.json < /tmp/x',
    'cp /tmp/x $HOME/.afk/config/mcp.json',
    `sed -i 's/a/b/' ~/.afk/config/schedules.json`,
    // Public keys are a READ grant only.
    'echo x > ~/.ssh/id_ed25519.pub',
    'cp /tmp/x ~/.ssh/id_ed25519.pub',
    'cat ~/.ssh/id_ed25519.pub >> ~/.ssh/known_hosts',
  ];
  it.each(probes)('blocks %s', (cmd) => {
    expect(decide(cmd)).toBe('block');
  });
});

describe('carve-out read-only shapes stay allowed', () => {
  it.each([
    'cat ~/.ssh/config',
    'cat "$HOME/.ssh/known_hosts"',
    'cat "~/.ssh/config" 2>/dev/null',
    'grep -i host ~/.ssh/config | head -5',
    'wc -l ~/.ssh/known_hosts',
    'cat ~/.afk/config/mcp.json',
    'head -n 20 ~/.afk/config/schedules.json',
    'cat ~/.ssh/id_ed25519.pub',
    'cat $HOME/.ssh/id_rsa.pub ~/.ssh/work-laptop.pub',
    'ls -l ~/.ssh/config ~/.ssh/github@corp.pub',
  ])('allows %s', (cmd) => {
    expect(decide(cmd)).not.toBe('block');
  });

  it('an AFK_READ_DENYLIST re-deny of ~/.ssh blocks public keys too', () => {
    process.env['AFK_READ_DENYLIST'] = '~/.ssh';
    _resetReadDenylistCacheForTests();
    expect(decide('cat ~/.ssh/id_ed25519.pub')).toBe('block');
  });
});

describe('public-key scrub is exact: lookalikes stay blocked', () => {
  it.each([
    'cat ~/.ssh/id_rsa',
    'cat ~/.ssh/github_key',
    'cat ~/.ssh/*.pub',
    'cat ~/.ssh/id_rsa{.pub,}',
    'cat ~/.ssh/x.pub"/../id_rsa"',
    `cat ~/.ssh/x.pub'/../id_rsa'`,
    'cat ~/.ssh/x.pub/../id_rsa',
    'cat ~/.ssh/x.pub.bak',
    'cat ~/.ssh/.pub',
    'cat ~/.ssh/keys/x.pub',
    'cat ~/.ssh/x.pub ~/.ssh/id_rsa',
    'cat ~/.ssh/id_rsa.pub?',
    'cat ~/.ssh/[i]d_rsa.pub',
    // Out of scope by design: ssh -i (its %d token defeats the lexical scan).
    'ssh -i ~/.ssh/id_ed25519 host',
  ])('blocks %s', (cmd) => {
    expect(decide(cmd)).toBe('block');
  });
});

// Hook <-> typed-handler parity: for `cat <path>` the bash verdict must match
// isReadDenied for every ssh public-key shape (the scrub defers to it).
describe('bash <-> isReadDenied parity for ssh public keys', () => {
  it.each([
    'id_ed25519.pub',
    'github@corp.pub',
    'id_ed25519',
    '.pub',
    'x.pub.bak',
  ])('cat ~/.ssh/%s agrees with the typed read surface', (name) => {
    const typedDenied = isReadDenied(join(homedir(), '.ssh', name)).denied;
    expect(decide(`cat ~/.ssh/${name}`) === 'block').toBe(typedDenied);
  });
});

// Advisory: when AFK_HOME is relocated UNDER ~/.ssh, a pubkey inside that
// AFK subtree (e.g. ~/.ssh/afk/id_ed25519.pub) is still blocked on the bash
// surface — it fails the DIRECT-child test (it is nested two levels under
// ~/.ssh, not one), and the enclosing ~/.ssh root catches it.
// A pubkey at the TOP of ~/.ssh (e.g. ~/.ssh/id_ed25519.pub) is still ALLOWED
// because the derived AFK config root (~/.ssh/afk/config) is a CHILD of
// ~/.ssh, not a parent, so gateSshPubKeyDir returns ~/.ssh unchanged.
describe('advisory — AFK_HOME relocated under ~/.ssh: nested pubkeys blocked, top-level still allowed', () => {
  beforeEach(() => {
    process.env['AFK_HOME'] = join(homedir(), '.ssh', 'afk');
    _resetReadDenylistCacheForTests();
  });
  afterEach(() => {
    delete process.env['AFK_HOME'];
    _resetReadDenylistCacheForTests();
  });

  it('cat ~/.ssh/afk/id_ed25519.pub is blocked (nested, not a direct .ssh child)', () => {
    // ~/.ssh/afk/id_ed25519.pub is two levels under ~/.ssh; isSshPubKeyChild
    // requires a DIRECT child, so this falls through to the enclosing ~/.ssh block.
    expect(decide('cat ~/.ssh/afk/id_ed25519.pub')).toBe('block');
  });

  it('cat ~/.ssh/id_ed25519.pub is still allowed (gateSshPubKeyDir keeps the pattern)', () => {
    // The derived root ~/.ssh/afk/config is a CHILD of ~/.ssh, so it is not
    // an ancestor gate — gateSshPubKeyDir returns ~/.ssh, the pattern is active,
    // and a direct *.pub child is scrubbed as allowed.
    expect(decide('cat ~/.ssh/id_ed25519.pub')).not.toBe('block');
  });
});

describe('isProvablyReadOnly — the gate itself', () => {
  it.each([
    'cat a',
    'cat a | grep b | wc -l',
    'cat a 2>/dev/null',
    'cat a 2>&1 | head',
    'cat $HOME/a ${HOME}/b',
  ])('accepts %s', (cmd) => {
    expect(isProvablyReadOnly(cmd)).toBe(true);
  });

  it.each([
    'cat a > b',
    'cat a >> b',
    'cat "a>b"',
    // Fail-closed over-block, deliberate: `>` disqualifies even when quoted.
    "grep 'x>y' a",
    'cat a; ls',
    'cat a && ls',
    'cat a || ls',
    'cat a &',
    'cat a\nls',
    'cat $(x)',
    'cat `x`',
    'cat $X',
    'cat (a)',
    'X=1 cat a',
    '/bin/cat a',
    'sed -n p a',
    'awk 1 a',
    'tee a',
    'cat a | tee b',
    'python -c 1',
    "cat 'unterminated",
    '',
  ])('rejects %s', (cmd) => {
    expect(isProvablyReadOnly(cmd)).toBe(false);
  });
});
