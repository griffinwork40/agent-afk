/**
 * Skill auto-routing directive and system prompt assembly.
 *
 * Appends the routing directive to the base system prompt when auto-routing
 * is enabled for the current surface. Callers are responsible for disabling
 * auto-routing for child sessions if recursive skill invocation should be
 * prevented.
 *
 * Also appends the end-of-turn protocol on interactive surfaces (REPL,
 * Telegram). This is REPL infrastructure: the verdict-ledger / verdict-card
 * UI in `cli/commands/interactive/` depends on the model emitting one of four
 * named terminal states (Done / Blocked / Asking / Interrupted) at the tail
 * of every turn. Without the directive present, `parseTerminalState()`
 * silently returns null and the rail never renders. Injecting the directive
 * in code — rather than as a tier-4 prompt fallback — means any user-supplied
 * system prompt (AFK.md, afk.config.json, AFK_SYSTEM_PROMPT env) still gets
 * the protocol. Non-interactive surfaces (one-shot `chat`, sub-agent threads)
 * skip the directive because their output is consumed programmatically and
 * the terminal-state heading would corrupt downstream parsing.
 *
 * @module agent/routing-directive
 */

export const ROUTING_DIRECTIVE = `[skill-routing: active]

Route recurring work through registered skills instead of rolling ad-hoc solutions:

- Before non-trivial implementation (multi-file edits, new features, config/build changes — anything that writes) → \`/ground-state\` first. Do NOT substitute inline \`git status\`/\`get_runtime_state\` — the skill triangulates git + infra + prior-session memory in parallel, which the inline checks miss. If \`/ground-state\` dispatch fails (depth limit, unavailable), fall back to inline checks AND note the coverage gap.
- Bugs, failing tests, or regressions → \`/diagnose\`
- High-stakes sub-agent output that will drive edits or commits → \`/shadow-verify\` before acting
- Refactor needing parallel waves → \`/parallelize\`
- Parallel or dependent multi-task work → \`compose\` tool (DAG of subagent nodes)
- Greenfield feature where a written spec would genuinely help (novel scope, multi-day work, or external stakeholders involved) → \`/mint\`

Do NOT reach for \`/mint\` for: bug fixes (use \`/diagnose\`), refactors with known shape, single-feature edits, work already spec'd in chat, or anything where the spec/approve pause would feel like ceremony. Implement directly in those cases.

Common composed sequences — reach for these when the task shape matches:

- Bug with failing test and non-trivial fix → \`/diagnose\` → \`/shadow-verify\` on the proposed fix
- Refactor needing parallel waves → plan → \`/parallelize\` → build waves
- Diagnose + fix in parallel → \`compose\` with two independent nodes
- Research → implement → verify pipeline → \`compose\` with edges: research→implement→verify
- Multiple independent investigations → \`compose\` with N nodes, no edges

Reach for context-isolated investigators when the task is exploratory:

- Map an unfamiliar module before editing → \`/gather\` or \`/research\`
- Re-derive a load-bearing claim independently → \`/shadow-verify\`
- Audit a diff before merge → \`/review\`
- Generate alternatives before committing to a plan → \`/devils-advocate\`

Or dispatch a raw \`agent\` call when no skill matches but the work is parallelizable, verification-heavy, or would otherwise consume substantial inline context.

Skip orchestration for: single-line edits, trivial Q&A, and direct tool calls the user explicitly requested. The goal is leverage, not ceremony. If a skill would add overhead without adding value, don't invoke it.

Default to acting autonomously. \`ask_question\` is a last resort, not a first move — every question blocks on the operator, who is often away from keyboard.

Before you ask, you MUST exhaust the tools you have: read the files, check git, search the codebase and docs, inspect runtime state. If any tool can get you the answer, use the tool — never ask the operator for something you can discover yourself. When a wrong guess would be cheap or reversible, make a reasonable assumption, proceed, and state the assumption instead of asking.

Reserve \`ask_question\` for the narrow set of things no tool can resolve: a genuinely ambiguous requirement whose readings lead to materially different work, a decision with significant or irreversible consequences, or context that lives only in the operator's head (a preference, a secret, an external constraint):

- Question types: \`text\` (open-ended), \`confirm\` (yes/no), \`choice\` (single pick from list), \`multi_choice\` (multi-pick), \`number\` (numeric with optional bounds). When \`allow_custom: true\`, the result may include \`custom_value\` instead of \`value\` — check \`content.custom_value !== undefined\` to detect a free-form answer.
- Ask one focused question at a time. Do NOT ask multiple questions in a single call, and do NOT stack several ask_question calls across a turn — fold the genuine unknowns into the single most decision-relevant question.
- Do NOT use when the user has already provided sufficient context — infer and proceed instead.
- The result \`action\` will be \`accept\` (answered), \`cancel\` (user interrupted), \`decline\` (no handler), or \`skip\` (optional question skipped).
- \`allow_custom\` (choice/multi_choice only): opt-in to a free-form entry affordance. On accept, \`content\` has \`{ value: null, custom_value: "<text>" }\` rather than \`{ value: "<listed-string>" }\`.
- After a \`cancel\` or \`decline\`, stop and tell the user what information you need — do not loop and re-ask.`;

/**
 * End-of-turn protocol directive — canonical source.
 *
 * This constant is the single source of truth for the end-of-turn protocol;
 * do NOT duplicate it in any prompt file (the duplicated copy in
 * `prompts/system-prompt.md` was removed precisely because it could drift
 * from this constant and reach the model on top of it). Kept here as a code
 * constant — not loaded from the prompt file — so it survives every
 * user-configurable system-prompt tier (env, afk.config.json, AFK.md). The
 * verdict-ledger and verdict-card surfaces in `cli/commands/interactive/`
 * depend on this contract.
 *
 * The parser at `src/cli/commands/interactive/terminal-state.ts` walks the
 * last ~40 lines of the assistant's final text looking for a short heading
 * line that resolves to `Done` / `Blocked` / `Asking` / `Interrupted`, then
 * captures the bullets that follow. The format below produces output the
 * parser accepts.
 */
export const END_OF_TURN_DIRECTIVE = `[end-of-turn protocol]

Every turn must end in one externally identifiable terminal state. AFK users need inspectable artifacts, not ceremony.

**Done**
- What was done
- Evidence that exists
- What changed in the world
- Anything still pending or deferred, with why

**Blocked**
- What blocks
- What must change to unblock
- What has already been done

**Asking**
- One precise question
- The assumption it resolves
- What you will do once answered

**Interrupted**
- What you were doing
- Where state was saved
- What resumption requires

Never end a turn mid-loop without one of these. The terminal-state heading must be the last block of the response, with no trailing prose after it.`;

/**
 * Identifies the surface assembling the prompt. Interactive surfaces (`repl`,
 * `telegram`) receive the end-of-turn protocol; non-interactive surfaces
 * (`one-shot`, `subagent`) do not, since their output is consumed
 * programmatically and a terminal-state heading would corrupt downstream
 * parsing.
 *
 * Default is `'one-shot'` — the safe, no-protocol choice — so callers that
 * don't pass a surface tag never silently break non-interactive output.
 */
export type PromptSurface = 'repl' | 'telegram' | 'one-shot' | 'subagent';

const SURFACES_WITH_END_OF_TURN: ReadonlySet<PromptSurface> = new Set([
  'repl',
  'telegram',
]);

export function assembleSystemPrompt(
  base: string | undefined,
  autoRouting: boolean,
  surface: PromptSurface = 'one-shot',
): string | undefined {
  if (!base) return base;
  const parts: string[] = [base];
  if (autoRouting) parts.push(ROUTING_DIRECTIVE);
  if (SURFACES_WITH_END_OF_TURN.has(surface)) parts.push(END_OF_TURN_DIRECTIVE);
  return parts.join('\n\n');
}
