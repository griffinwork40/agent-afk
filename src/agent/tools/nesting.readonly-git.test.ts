/**
 * #3754 item 2: AFK_READONLY_GIT_TOOL removes generic `bash` from every
 * read-only child surface and adds `git_read`; with the flag off nothing
 * changes. Exercised through the real provider builders and the per-query
 * dispatcher (advertised toolDefs + enforced permission gate).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHILD_ALLOWED_TOOLS,
  RECON_ALLOWED_TOOLS,
  buildComposeNodeProvider,
  buildReadOnlyReconProvider,
  buildSkillRestrictedProvider,
  createChildProviderFactory,
} from './nesting.js';
import { resolveComposeNodeAgent } from './compose-agent-resolve.js';
import { builtinAgents } from '../agents/builtins.js';
import { swapBashForGitRead } from './readonly-git-surface.js';
import type { ModelProvider } from '../provider.js';
import type { SessionToolDispatcher } from './dispatcher.js';

const FLAG = 'AFK_READONLY_GIT_TOOL';
let tmp: string;
let saved: string | undefined;
const opened: ModelProvider[] = [];

beforeEach(() => {
  saved = process.env[FLAG];
  tmp = mkdtempSync(join(tmpdir(), 'ro-git-'));
});
afterEach(async () => {
  if (saved === undefined) delete process.env[FLAG]; else process.env[FLAG] = saved;
  for (const p of opened.splice(0)) await (p as { close?: () => Promise<void> }).close?.();
  rmSync(tmp, { recursive: true, force: true });
});

function dispatcher(p: ModelProvider): SessionToolDispatcher {
  opened.push(p);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (p as any).buildDispatcher('default', {
    cwd: tmp, readRoots: [tmp], writeRoots: [tmp],
    sessionId: 's', parentSessionId: 'parent', subagentId: 'child-1',
  }) as SessionToolDispatcher;
}

function names(p: ModelProvider): string[] {
  return dispatcher(p).toolDefs.map((t) => t.name);
}

async function run(p: ModelProvider, name: string, input: unknown): Promise<{ content: unknown; isError?: boolean }> {
  return dispatcher(p).execute({ id: `${name}-1`, name, input, signal: new AbortController().signal } as never);
}

function readOnlySurfaces(): Array<[string, () => ModelProvider]> {
  const factory = createChildProviderFactory();
  // Resolved lazily inside the builder: the compose gate is computed at resolve
  // time, after beforeEach has set (or cleared) the flag.
  const composeNode = (): ModelProvider => {
    const resolved = resolveComposeNodeAgent('git-investigator', builtinAgents());
    return buildComposeNodeProvider('sonnet', undefined, {
      readOnlyBash: true,
      ...(resolved.canUseTool !== undefined ? { canUseTool: resolved.canUseTool } : {}),
      ...(resolved.namedAgentAllowedTools !== undefined ? { namedAgentAllowedTools: resolved.namedAgentAllowedTools } : {}),
    });
  };
  return [
    ['read-only skill fork (factory)', () => factory({ childExecutor: undefined as never, model: 'sonnet', allowedTools: [...RECON_ALLOWED_TOOLS], readOnlyBash: true })],
    ['read-only skill fork (factory, openai)', () => factory({ childExecutor: undefined as never, model: 'gpt-4o', allowedTools: [...RECON_ALLOWED_TOOLS], readOnlyBash: true })],
    ['read-only skill fork (depth cap)', () => buildReadOnlyReconProvider('sonnet')],
    ['read-only skill fork (depth cap, openai)', () => buildReadOnlyReconProvider('gpt-4o')],
    ['bash:read-only named agent (cap path)', () => buildSkillRestrictedProvider(['bash', 'read_file', 'grep', 'glob'], 'sonnet', true)],
    ['compose node running git-investigator', composeNode],
  ];
}

describe('AFK_READONLY_GIT_TOOL off (default): unchanged', () => {
  beforeEach(() => { delete process.env[FLAG]; });

  it.each(readOnlySurfaces())('%s keeps bash and has no git_read', (_label, build) => {
    const tools = names(build());
    expect(tools).toContain('bash');
    expect(tools).not.toContain('git_read');
  });

  it('write-capable child keeps bash and has no git_read', () => {
    const tools = names(createChildProviderFactory()({ childExecutor: undefined as never, model: 'sonnet' }));
    expect(tools).toContain('bash');
    expect(tools).not.toContain('git_read');
  });

  it('git_read is not dispatchable', async () => {
    const r = await run(buildReadOnlyReconProvider('sonnet'), 'git_read', { subcommand: 'status' });
    expect(r.isError).toBe(true);
  });
});

describe('AFK_READONLY_GIT_TOOL on', () => {
  beforeEach(() => { process.env[FLAG] = '1'; });

  it.each(readOnlySurfaces())('%s: no bash, has git_read', (_label, build) => {
    const tools = names(build());
    expect(tools).not.toContain('bash');
    expect(tools).toContain('git_read');
  });

  it('a read-only bash call is refused at dispatch even if attempted', async () => {
    const r = await run(buildReadOnlyReconProvider('sonnet'), 'bash', { command: 'git status' });
    expect(r.isError).toBe(true);
  });

  it.each(readOnlySurfaces())('%s: git_read passes the permission gates', async (_label, build) => {
    const r = await run(build(), 'git_read', { subcommand: 'log', args: ['--output=/tmp/x'] });
    // Reached the handler (policy rejection text), not the permission gate.
    expect(String(r.content)).toContain('Rejected option');
  });

  it('write-capable children are unchanged (flag only touches read-only surfaces)', () => {
    // CHILD_ALLOWED_TOOLS is not widened: a write-capable child already has bash.
    const tools = names(createChildProviderFactory()({ childExecutor: undefined as never, model: 'sonnet' }));
    expect(tools).toContain('bash');
    expect(tools).not.toContain('git_read');
  });

  it('a read-only surface that never had bash does not gain git_read', () => {
    expect(swapBashForGitRead(['read_file', 'grep'])).toEqual(['read_file', 'grep']);
    const tools = names(buildSkillRestrictedProvider(['read_file', 'grep'], 'sonnet', true));
    expect(tools).not.toContain('git_read');
  });

  it('shared allowlist constants are not mutated', () => {
    expect(RECON_ALLOWED_TOOLS).toContain('bash');
    expect(CHILD_ALLOWED_TOOLS).toContain('bash');
  });
});
