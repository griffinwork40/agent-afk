import { afterEach, describe, expect, it, vi } from 'vitest';

const { exec, input } = vi.hoisted(() => ({ exec: vi.fn(), input: vi.fn() }));
vi.mock('../../../utils/exec-file.js', () => ({ execFileAsync: exec }));
vi.mock('../../../agent/gh.js', async (original) => ({
  ...await original<typeof import('../../../agent/gh.js')>(),
  defaultExecWithInput: input,
}));

import { checkGhReady, _resetCacheForTest } from '../../../agent/gh.js';
import { defaultBugFileDeps } from './bug.file.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  _resetCacheForTest();
});

describe('/bug --file host selection', () => {
  it('pins all gh operations to github.com despite GH_HOST and an ambient cache hit', async () => {
    vi.stubEnv('GH_HOST', 'ghe.example.com');
    exec.mockImplementation(async (_file: string, args: string[]) => ({
      stdout: args[0] === 'api' ? 'octocat\n' : args[0] === 'repo' ? 'TRIAGE\n' : '', stderr: '',
    }));
    input.mockResolvedValue({ stdout: 'https://github.com/griffinwork40/agent-afk/issues/123\n', stderr: '' });
    await checkGhReady(); // ambient host success must not authorize github.com
    exec.mockClear();
    expect(await defaultBugFileDeps.checkGhReady()).toEqual({ ok: true });
    expect(exec).toHaveBeenCalledWith('gh', ['auth', 'status', '--hostname', 'github.com'], expect.anything());
    expect(await defaultBugFileDeps.getGhLogin()).toBe('octocat');
    expect(exec).toHaveBeenCalledWith('gh', ['api', 'user', '--jq', '.login', '--hostname', 'github.com'], expect.anything());
    const repo = 'github.com/griffinwork40/agent-afk';
    expect(await defaultBugFileDeps.getViewerPermission(repo)).toBe('TRIAGE');
    expect(exec).toHaveBeenCalledWith('gh', ['repo', 'view', repo, '--json', 'viewerPermission', '--jq', '.viewerPermission'], expect.anything());
    await defaultBugFileDeps.createIssue({ repo, title: 't', body: 'b', labels: ['bug', 'triage'] });
    expect(input).toHaveBeenCalledWith('gh', ['issue', 'create', '--repo', repo, '--title', 't', '--body-file', '-', '--label', 'bug', '--label', 'triage'], 'b');
  });

  it('does not treat cached GHE authentication as github.com authentication', async () => {
    vi.stubEnv('GH_HOST', 'ghe.example.com');
    exec.mockResolvedValue({ stdout: '', stderr: '' });
    await checkGhReady();
    exec.mockImplementation(async (_file: string, args: string[]) => {
      if (args.includes('--hostname')) throw new Error('not authenticated on github.com');
      return { stdout: '', stderr: '' };
    });
    expect(await defaultBugFileDeps.checkGhReady()).toMatchObject({ ok: false });
  });

  it('does not reuse an ambient in-flight probe for a host-specific request', async () => {
    let release!: () => void;
    exec.mockImplementation(async (_file: string, args: string[]) => {
      if (args[0] === 'auth' && !args.includes('--hostname')) {
        await new Promise<void>((resolve) => { release = resolve; });
      }
      return { stdout: '', stderr: '' };
    });
    const ambient = checkGhReady();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(await defaultBugFileDeps.checkGhReady()).toEqual({ ok: true });
    release();
    await ambient;
  });
});
