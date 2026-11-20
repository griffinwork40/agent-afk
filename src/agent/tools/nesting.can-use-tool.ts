/**
 * Surface-supplied approval gate for forked children (`agent`, `skill`,
 * `compose`), threaded to every child provider construction.
 *
 * Contract:
 *   - A surface opts in by passing {@link ChildCanUseToolFactory} as
 *     `WireExecutorsOptions.childCanUseTool`. The factory is called ONCE per
 *     child provider construction (including a model-fallback rebuild) with the
 *     child's {@link ChildToolOrigin}, and returns the `CanUseTool` that child's
 *     dispatcher awaits before each tool call — or `undefined` to leave that
 *     child ungated. Returning a per-child callback is how the surface labels a
 *     request (route, depth, agent type) without widening `CanUseTool` itself.
 *   - The callback is passed in the provider CONSTRUCTOR options: a prebuilt
 *     `AgentConfig.provider` is queried directly (provider-lifecycle.ts), so a
 *     callback left on the child config never reaches the dispatcher.
 *   - Deny semantics are the dispatcher's own (`runCanUseTool`): a deny or a
 *     throw becomes an ordinary `permission-denied` tool result the child's
 *     model sees, and the child keeps running — identical to a top-level deny.
 *   - Absent option ⇒ no key is added anywhere; every provider is constructed
 *     with exactly the options it had before.
 *   - Routes outside the factory reach the same gate: depth-cap restricted
 *     providers look it up from the factory they hold (`childGateFor`); inline
 *     skill handlers receive `SkillExecutionContext.childGate` and put it on
 *     each fork's `config.canUseTool`; read-only phase providers take the fork
 *     config's `canUseTool`. Own allowlists always run first.
 *
 * @module agent/tools/nesting.can-use-tool
 */

import type { CanUseTool } from '../types.js';

/** Which fork route built the child. */
export type ChildToolRoute = 'agent' | 'skill' | 'compose';

/** Identity of a forked child, handed to the surface's gate factory. */
export interface ChildToolOrigin {
  route: ChildToolRoute;
  /** The child's own depth: 1 = forked directly by the top-level session. */
  depth: number;
  /** Named agent type (`agent_type`), skill name, or compose node `agent_type`. */
  agentType?: string;
  /** Caller-chosen label: `agent` `id_prefix` or the compose node id. */
  label?: string;
}

/** Returns the approval callback for one child, or `undefined` for none. */
export type ChildCanUseToolFactory = (origin: ChildToolOrigin) => CanUseTool | undefined;

/** Session-wide option bag carrying the surface gate factory (absent = off). */
export interface ChildGateOptions {
  /**
   * Surface-supplied approval gate for every forked child's tool calls, at
   * every depth and through every fork route. See this module's contract.
   */
  childCanUseTool?: ChildCanUseToolFactory;
}

/** Per-construction child identity, passed alongside the factory args. */
export interface ChildGateArgs {
  /** Which route / depth / label this provider is being built for. */
  origin?: ChildToolOrigin;
}

/** Origin of a skill-forked child at `depth` (its own depth). */
export function skillChildOrigin(depth: number, skillName: string | undefined): ChildToolOrigin {
  return { route: 'skill', depth, ...(skillName !== undefined ? { agentType: skillName } : {}) };
}

/** Origin of an `agent`-tool child at `depth` (its own depth). */
export function agentChildOrigin(depth: number, agentType: string | undefined, label: string | undefined): ChildToolOrigin {
  return {
    route: 'agent',
    depth,
    ...(agentType !== undefined ? { agentType } : {}),
    ...(label !== undefined ? { label } : {}),
  };
}

/**
 * Conditional-spread helper: `{ canUseTool }` when a factory is configured and
 * yields a callback for this origin, else `{}` (absent stays absent). A missing
 * origin (a direct factory caller that passes none) still consults the gate,
 * labelled `{ route: 'agent', depth: 0 }` (depth unknown) — fail closed, never
 * skipped.
 */
export function childGateOpt(
  factory: ChildCanUseToolFactory | undefined,
  origin: ChildToolOrigin | undefined,
): { canUseTool: CanUseTool } | Record<string, never> {
  if (factory === undefined) return {};
  const canUseTool = factory(origin ?? { route: 'agent', depth: 0 });
  return canUseTool !== undefined ? { canUseTool } : {};
}

/**
 * Chain a node's own restriction gate (e.g. a compose named-agent allowlist)
 * with the surface gate. The restriction runs first: a tool the node can never
 * use is denied without asking the human. Either alone is returned unchanged.
 */
export function chainCanUseTool(
  first: CanUseTool | undefined,
  second: CanUseTool | undefined,
): CanUseTool | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return async (toolName, input, options) => {
    const r = await first(toolName, input, options);
    if (r.behavior === 'deny') return r;
    const nextInput = r.updatedInput ?? input;
    const r2 = await second(toolName, nextInput, options);
    // Keep the first gate's rewrite when the second allows without its own.
    if (r2.behavior === 'allow' && r2.updatedInput === undefined && r.updatedInput !== undefined) {
      return { ...r2, updatedInput: r.updatedInput };
    }
    return r2;
  };
}

/**
 * A compose node's provider restrictions with the surface gate attached as
 * `surfaceGate` (chained after the node's own allowlist gate by
 * `resolveComposeNodeProvider`). Absent factory ⇒ `restrictions` returned as-is.
 */
export function composeNodeGated<R extends object>(
  restrictions: R,
  factory: ChildCanUseToolFactory | undefined,
  node: { id: string; agent_type?: string | undefined },
  composeDepth: number,
): R | (R & { surfaceGate: CanUseTool }) {
  if (factory === undefined) return restrictions;
  const surfaceGate = factory({
    route: 'compose',
    depth: composeDepth + 1,
    ...(node.agent_type !== undefined ? { agentType: node.agent_type } : {}),
    label: node.id,
  });
  return surfaceGate !== undefined ? { ...restrictions, surfaceGate } : restrictions;
}

// Contract (gate carriage without new plumbing): every executor at every depth
// already holds the session's child provider factory, so the surface gate
// factory is registered against that function object. Depth-cap restricted
// providers and inline skill handlers look it up from the factory they were
// handed. Nothing is registered when the option is absent.
const gateByProviderFactory = new WeakMap<object, ChildCanUseToolFactory>();

/** Record `gate` as the surface gate of `providerFactory` (no-op when absent). */
export function attachChildGate<F extends object>(providerFactory: F, gate: ChildCanUseToolFactory | undefined): F {
  if (gate !== undefined) gateByProviderFactory.set(providerFactory, gate);
  return providerFactory;
}

/** The surface gate registered for `providerFactory`, if any. */
export function childGateOf(providerFactory: object | undefined): ChildCanUseToolFactory | undefined {
  return providerFactory === undefined ? undefined : gateByProviderFactory.get(providerFactory);
}

/**
 * Per-label gate an inline skill handler applies to the children it forks
 * through its own `SubagentManager` (route `skill`, depth `childDepth`).
 * Undefined when no surface gate is configured.
 */
export function inlineSkillChildGate(
  factory: ChildCanUseToolFactory | undefined,
  childDepth: number,
): ((agentType: string) => CanUseTool | undefined) | undefined {
  if (factory === undefined) return undefined;
  return (agentType) => factory(skillChildOrigin(childDepth, agentType));
}

/** `{ canUseTool }` for a fork config: `own` (if any) first, then the surface gate. */
export function forkConfigGate(
  gate: ((agentType: string) => CanUseTool | undefined) | undefined,
  agentType: string,
  own?: CanUseTool,
): { canUseTool: CanUseTool } | Record<string, never> {
  const canUseTool = chainCanUseTool(own, gate?.(agentType));
  return canUseTool !== undefined ? { canUseTool } : {};
}

/** The surface gate callback for one child built from `providerFactory`, or undefined. */
export function childGateFor(providerFactory: object | undefined, origin: ChildToolOrigin): CanUseTool | undefined {
  return childGateOf(providerFactory)?.(origin);
}

/** `{ childGate }` for an inline handler's SkillExecutionContext, or `{}` when no gate. */
export function inlineChildGateOpt(
  providerFactory: object | undefined,
  childDepth: number,
): { childGate: (agentType: string) => CanUseTool | undefined } | Record<string, never> {
  const childGate = inlineSkillChildGate(childGateOf(providerFactory), childDepth);
  return childGate !== undefined ? { childGate } : {};
}
