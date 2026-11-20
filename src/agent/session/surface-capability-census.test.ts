import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { token } from './__test-utils__/surface-census-runtime.js';
import { probe, surfaces, type Surface } from './__test-utils__/surface-census-scenarios.js';
import { type SurfaceRuntime } from './__test-utils__/surface-census-runtime.js';
import { exemptions, productionSites } from './__test-utils__/surface-census-sites.js';

const src = fileURLToPath(new URL('../../', import.meta.url));
type Status = 'wired' | 'gap' | 'intentional' | 'not machine-checked';
interface Cell { status: Status; reason?: string; source?: string; quote?: string }
const wired: Cell = { status: 'wired' };
const gap: Cell = { status: 'gap' };
const intentional = (reason: string, source: string, quote: string): Cell => ({ status: 'intentional', reason, source, quote });
const unchecked = (reason: string): Cell => ({ status: 'not machine-checked', reason });
const ownership = 'agent/session/wire-executors.ts';
const cli = 'cli/commands/';
const daemon = `${cli}daemon-session-factory.ts`;

// Contract: entries describe builder wiring when optional inputs are supplied,
// not whether a user enabled tracing/configured MCP on a particular run.
// Gaps are assertions of absence, not exemptions: fixing one MUST update this
// table. An intentional omission needs a live source rationale, never our guess.
// Unknown sandbox exports fail closed. Real helpers and object spreads execute;
// AST scanning below is only for discovery, not capability inference.
const census: Record<Surface, Record<string, Cell>> = {
  REPL: {
    sessionTrace: wired, childTrace: wired, skillTrace: wired,
    sessionPrompt: wired, childPrompt: wired, childOverlay: wired,
    sessionOverlay: wired, hooksAtSessionCwd: wired,
    childCwd: wired, nestedCwd: wired, background: wired, diskMcp: wired, userHooks: wired,
    modelRouting: wired,
    outerOrchestration: unchecked('Component builders run with explicit inputs; bootstrapSession CLI/UI orchestration and prompt resolution are not executed.'),
  },
  chat: {
    sessionTrace: wired, childTrace: wired, skillTrace: wired,
    sessionPrompt: wired, childPrompt: wired, childOverlay: wired,
    sessionOverlay: wired, hooksAtSessionCwd: wired,
    childCwd: wired, nestedCwd: wired,
    background: intentional('Background dispatch is documented as REPL-only (historical policy; Telegram/web now also wire it).',
      ownership, 'elsewhere background dispatch reports as unconfigured'),
    diskMcp: wired, userHooks: wired, modelRouting: wired,
    outerOrchestration: unchecked('Builder/MCP helper run with explicit inputs; chat action trace creation and base/overlay resolution are not executed.'),
  },
  daemon: {
    sessionTrace: wired, childTrace: wired, skillTrace: wired,
    sessionPrompt: gap, sessionOverlay: gap, hooksAtSessionCwd: wired,
    childPrompt: intentional('Task children fall back to the handoff contract.', daemon, 'Daemon tasks carry no base prompt'),
    childOverlay: gap, childCwd: wired, nestedCwd: wired,
    background: intentional('Background dispatch is interactive-only.', daemon, 'No backgroundRegistry: background dispatch is interactive-only.'),
    diskMcp: wired, userHooks: wired, modelRouting: wired, outerOrchestration: unchecked('Builder chain runs; SDK/network/disk infrastructure and process startup are faked.'),
  },
  Telegram: {
    sessionTrace: wired, childTrace: wired,
    skillTrace: intentional('Preserved narrower tracing on skill forks.', ownership, 'Telegram traces its manager/agent/compose paths but leaves skill forks'),
    sessionPrompt: wired, childPrompt: wired, childOverlay: wired, childCwd: wired,
    sessionOverlay: wired, hooksAtSessionCwd: wired,
    nestedCwd: intentional('Preserved narrower anchoring at depth two.', ownership, 'Telegram passes `undefined` here to preserve its existing (narrower)'),
    background: wired, diskMcp: wired, userHooks: wired, modelRouting: wired, outerOrchestration: unchecked('Builder chain runs; SDK/network/disk infrastructure and process startup are faked.'),
  },
  web: {
    sessionTrace: wired, childTrace: wired, skillTrace: wired,
    sessionPrompt: wired, childPrompt: wired, childOverlay: wired,
    childCwd: wired, nestedCwd: wired, background: wired, diskMcp: wired,
    sessionOverlay: wired, hooksAtSessionCwd: gap,
    userHooks: gap, modelRouting: gap, outerOrchestration: unchecked('Builder chain runs; SDK/network/disk infrastructure and process startup are faked.'),
  },
  ACP: {
    sessionTrace: gap, childTrace: gap, skillTrace: gap,
    sessionPrompt: gap, childPrompt: gap, childOverlay: gap,
    sessionOverlay: gap, hooksAtSessionCwd: gap,
    childCwd: gap, nestedCwd: gap, background: gap, diskMcp: gap,
    userHooks: wired, modelRouting: gap, outerOrchestration: unchecked('Builder chain runs; SDK/network/disk infrastructure and process startup are faked.'),
  },
};

const hookDirectories: Record<Surface, string | undefined> = {
  REPL: 'session-cwd', chat: 'session-cwd', daemon: 'session-cwd',
  Telegram: 'session-cwd', web: undefined, ACP: 'host-cwd',
};

function actual(rt: SurfaceRuntime, otherModel: SurfaceRuntime): Record<string, boolean> {
  const wire = rt.calls('wireExecutors')[0]?.args[0] as Record<string, unknown> | undefined;
  const config = rt.sessions[0];
  const has = (key: string): boolean => wire?.[key] !== undefined;
  const providers = rt.calls('provider');
  const mcpPassed = providers.some((o) => (o.args[1] as Record<string, unknown> | undefined)?.['mcpManager'] === rt.mcp());
  const hookArgs = rt.calls('loadHooksConfig')[0]?.args[0] as { cwd?: string } | undefined;
  const contains = (value: unknown, text: string): boolean => typeof value === 'string' && value.includes(text);
  return {
    sessionTrace: config?.['traceWriter'] !== undefined,
    childTrace: has('traceWriter'), skillTrace: has('skillTraceWriter'),
    sessionPrompt: config?.['systemPrompt'] !== undefined,
    sessionOverlay: contains(config?.['systemPrompt'], 'overlay'),
    childPrompt: has('systemPrompt'), childOverlay: has('operatorOverlay'),
    childCwd: has('cwd'), nestedCwd: has('nestedCwd'), background: has('backgroundRegistry'),
    hooksAtSessionCwd: hookArgs?.cwd === 'session-cwd',
    diskMcp: rt.calls('loadMcpConfig').length > 0 && mcpPassed,
    userHooks: rt.calls('loadHooksConfig').length > 0 && rt.calls('createDefaultHookRegistry').some((o) => o.args[4] === token),
    modelRouting: providers[0]?.args[0] !== otherModel.calls('provider')[0]?.args[0],
  };
}

function checkValues(surface: Surface, rt: SurfaceRuntime): void {
  const wire = rt.calls('wireExecutors')[0]?.args[0] as Record<string, unknown>;
  for (const key of ['cwd', 'nestedCwd']) {
    if (wire[key] !== undefined) expect(wire[key], `${surface}/${key}: preserve the supplied session cwd`).toBe('session-cwd');
  }
  for (const key of ['traceWriter', 'skillTraceWriter']) {
    if (wire[key] !== undefined) expect(wire[key], `${surface}/${key}: pass the session-owned witness writer`).toBe(token);
  }
  if (rt.sessions[0]?.['traceWriter'] !== undefined) expect(rt.sessions[0]?.['traceWriter']).toBe(token);
  if (rt.sessions[0]?.['systemPrompt'] !== undefined) expect(rt.sessions[0]?.['systemPrompt'], `${surface}/sessionPrompt: forward the base`).toContain('base');
  if (wire['systemPrompt'] !== undefined) expect(wire['systemPrompt'], `${surface}/childPrompt: forward the base`).toContain('base');
  for (const call of rt.calls('loadMcpConfig')) {
    expect((call.args[0] as { cwd?: string }).cwd, `${surface}/diskMcp: load project config at the session cwd`).toBe('session-cwd');
  }
  if (wire['operatorOverlay'] !== undefined) expect(wire['operatorOverlay'], `${surface}/childOverlay: forward operator instructions`).toBe('overlay');
}

function sourceComments(file: string): string {
  const text = readFileSync(path.join(src, file), 'utf8');
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  const comments: string[] = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia) comments.push(scanner.getTokenText());
  }
  return comments.join('\n');
}

function check(surface: string, capability: string, cell: Cell, present: boolean): void {
  if (cell.status === 'not machine-checked') {
    expect(cell.reason, `${surface}/${capability}: document why this is not machine-checked`).toBeTruthy();
    return;
  }
  const message = `${surface} / ${capability}: census says ${cell.status}, builder is ${present ? 'wired' : 'omitted'}. ` +
    'Either wire/restore the capability, or update the census to a known gap or a source-cited intentional omission. ' +
    'If a gap was fixed, remove the gap by marking it wired; do not weaken the probe.';
  expect(present, message).toBe(cell.status === 'wired');
  if (cell.status === 'intentional') {
    expect(cell.reason, message).toBeTruthy();
    expect(cell.source, message).toBeTruthy();
    expect(cell.quote, message).toBeTruthy();
    expect(sourceComments(cell.source!), `${message} Rationale must remain in a source comment, not a string or inferred policy.`).toContain(cell.quote);
  }
}

describe('session surface capability census', () => {
  it('accounts for every production session constructor and executor bootstrap', () => {
    for (const [file, reason] of Object.entries(exemptions)) {
      expect(expectedSites.some((site) => site.startsWith(`${file}:`)), reason).toBe(true);
    }
    expect(productionSites(src), 'New production bootstrap: add a surface probe/census, or a source-cited non-surface exemption in surface-census-sites.ts.').toEqual(expectedSites);
  });

  for (const surface of surfaces) {
    it(`${surface}: capabilities and hook config directory match the reasoned census`, async () => {
      const rt = await probe(src, surface);
      const otherModel = await probe(src, surface, 'gpt-4o');
      expect(rt.sessions, `${surface}: probe must reach exactly one real session constructor boundary`).toHaveLength(1);
      expect(rt.calls('wireExecutors'), `${surface}: probe must reach the executor builder`).toHaveLength(1);
      expect(rt.calls('provider'), `${surface}: probe must actually construct a provider`).not.toHaveLength(0);
      checkValues(surface, rt);
      const observed = actual(rt, otherModel);
      expect(Object.keys(census[surface]).filter((key) => key !== 'outerOrchestration').sort()).toEqual(Object.keys(observed).sort());
      for (const [capability, cell] of Object.entries(census[surface])) {
        check(surface, capability, cell, observed[capability] ?? false);
      }
      const hooks = rt.calls('loadHooksConfig');
      if (hookDirectories[surface] !== undefined) {
        expect(hooks, `${surface}/userHooks: load user hook config, or record why not`).toHaveLength(1);
        const options = (hooks[0]?.args[0] ?? {}) as { cwd?: string };
        expect(options.cwd ?? 'host-cwd', `${surface}/userHooks directory drift: update wiring or census with rationale`).toBe(hookDirectories[surface]);
      }
    });
  }
});

// Discovery includes SDK/child/probe constructors: explicitly account for them
// rather than silently excluding whole directories that could gain a surface.
const expectedSites = [
  'agent/daemon/session-spawn.ts:AgentSession',
  'agent/query.ts:AgentSession',
  'agent/session/create-wired-executors.ts:wireExecutors',
  'agent/subagent/fork-model-fallback.ts:AgentSession',
  'agent/subagent/fork-wiring.ts:AgentSession',
  'cli/commands/acp.session.ts:AgentSession', 'cli/commands/acp.session.ts:wireExecutors',
  'cli/commands/chat.session-setup.ts:AgentSession', 'cli/commands/chat.session-setup.ts:wireExecutors',
  'cli/commands/daemon-session-factory.ts:AgentSession', 'cli/commands/daemon-session-factory.ts:wireExecutors',
  'cli/commands/interactive/bootstrap-infra.ts:wireExecutors',
  'cli/commands/interactive/bootstrap-session-builder.ts:AgentSession',
  'cli/commands/status.ts:AgentSession',
  'telegram/construct-session.ts:AgentSession', 'telegram/wire-telegram-executors.ts:wireExecutors',
  'web-server/session-owner.ts:AgentSession', 'web-server/session-owner.wiring.ts:wireExecutors',
].sort();
