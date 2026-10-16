import { describe, it, expect } from 'vitest';
import { shQuote, shQuotePath, buildLaunchScript, buildFollowScript, buildCancelScript } from './remote-script.js';
import { sshArgs } from './ssh-runner.js';
import { createEventCollector } from './remote-events.js';

describe('shQuote / shQuotePath', () => {
  it('single-quotes and escapes embedded quotes', () => {
    expect(shQuote("it's $HOME `x`")).toBe(`'it'\\''s $HOME \`x\`'`);
  });
  it('expands a leading ~ to the remote $HOME only', () => {
    expect(shQuotePath('~/Projects/a b')).toBe(`"$HOME"/'Projects/a b'`);
    expect(shQuotePath('~')).toBe('"$HOME"');
    expect(shQuotePath('/abs/~x')).toBe(`'/abs/~x'`);
  });
});

describe('buildLaunchScript', () => {
  const base = { runId: 'r1', sessionId: 's-1' };

  it('inlines the recursion guard and detaches afk with nohup', () => {
    const s = buildLaunchScript(base);
    expect(s).toContain('AFK_MAX_NESTING_DEPTH=0 AFK_REMOTE_DEPTH=1 nohup "$p"');
    expect(s).toContain(`'chat' '--format' 'stream-json' '--session-id' 's-1'`);
    expect(s).toContain('< "$d/prompt" > "$d/out.ndjson" 2> "$d/err.log" &');
    expect(s).toContain('PATH="$(dirname "$p"):$PATH"');
  });

  it('uses --resume instead of --session-id and passes model/cwd quoted', () => {
    const s = buildLaunchScript({ ...base, resume: 'old-id', model: "x'y", cwd: '~/repo' });
    expect(s).toContain(`'--resume' 'old-id'`);
    expect(s).not.toContain('--session-id');
    expect(s).toContain(`'--model' 'x'\\''y'`);
    expect(s).toContain(`cd "$HOME"/'repo' ||`);
  });

  it('uses an explicit afkPath when given and resolves otherwise', () => {
    expect(buildLaunchScript({ ...base, afkPath: '/opt/afk' })).toContain(`p='/opt/afk'`);
    const s = buildLaunchScript(base);
    expect(s).toContain(`p=''`);
    expect(s).toContain('-ic');
    expect(s).toContain('.nvm/versions/node/*/bin/afk');
  });

  it('never embeds the prompt', () => {
    expect(buildLaunchScript(base)).toContain('cat > "$d/prompt"');
  });
});

describe('follow / cancel scripts', () => {
  it('follows from a 1-based start line', () => {
    expect(buildFollowScript('r1', 7)).toContain('tail -n +7 -f "$d/out.ndjson"');
    expect(buildFollowScript('r1', 0)).toContain('tail -n +1 -f');
  });
  it('cancel kills the recorded pid and always succeeds', () => {
    const s = buildCancelScript('r1');
    expect(s).toContain('kill "$pid"');
    expect(s.trim().endsWith('exit 0')).toBe(true);
  });
});

describe('sshArgs', () => {
  it('runs the script under /bin/sh with fail-fast options and an option terminator', () => {
    const args = sshArgs('user@host', 'echo hi');
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('ConnectTimeout=5');
    expect(args.slice(-3)).toEqual(['--', 'user@host', `/bin/sh -c 'echo hi'`]);
  });
});

describe('createEventCollector', () => {
  it('ignores unknown and malformed lines and prefers trailing chunks', () => {
    const c = createEventCollector();
    expect(c.push('garbage')).toBe(false);
    expect(c.push(JSON.stringify({ type: 'future_event' }))).toBe(false);
    c.push(JSON.stringify({ type: 'message', message: { content: 'round 1' } }));
    expect(c.finalMessage()).toBe('round 1');
    c.push(JSON.stringify({ type: 'chunk', chunk: { type: 'content', content: 'tail' } }));
    expect(c.finalMessage()).toBe('tail');
    expect(c.push(JSON.stringify({ type: 'done' }))).toBe(true);
    expect(c.terminal()).toEqual({ type: 'done' });
  });
});
