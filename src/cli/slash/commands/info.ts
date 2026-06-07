/**
 * Information / introspection commands:
 *   /cost /tokens /history /reset /model /tools /mcp /debug
 *
 * These all read from SessionStats or session metadata and format for
 * display. `/model` mutates state by calling `session.setModel()`.
 */

import { palette } from '../../palette.js';
import { divider } from '../../render.js';
import { formatCost, formatTokens } from '../../format-utils.js';
import { contextLimitFor, MODEL_CONTEXT_LIMITS } from '../../model-limits.js';
import { renderDebugBanner } from '../../debug-banner.js';
import { providerForModel } from '../../../agent/providers/index.js';
import { slotForInput } from '../../../agent/session/model-slots.js';
import type { SlashCommand } from '../types.js';
import type { AgentModelInput } from '../../../agent/types.js';

/** Display hint only — not used for validation. Full model IDs (org/model) are also accepted. */
const MODEL_ALIASES_HINT = ['small', 'medium', 'large', 'opus', 'opus_1m', 'sonnet', 'sonnet_1m', 'haiku'] as const;

const costCmd: SlashCommand = {
  name: '/cost',
  summary: 'Show total and per-turn cost',
  hint: 'When you want a dollar breakdown of this session — total, average per turn, and the recent turn-by-turn series.',
  async handler(ctx) {
    const { stats, out } = ctx;
    out.line();
    out.line(palette.bold('Session cost'));
    out.line(divider());
    out.line(`  total       ${palette.success(formatCost(stats.totalCostUsd))}`);
    out.line(`  turns       ${palette.meta(String(stats.totalTurns))}`);
    if (stats.totalTurns > 0) {
      const avg = stats.totalCostUsd / stats.totalTurns;
      out.line(`  avg/turn    ${palette.meta(formatCost(avg))}`);
    }
    if (stats.turnCosts.length > 0) {
      const last5 = stats.turnCosts.slice(-5).map(formatCost).join(palette.dim(' · '));
      out.line(`  last 5      ${last5}`);
    }
    out.line();
    return 'continue';
  },
};

/** Render token usage using SDK's getContextUsage breakdown when available. */
function renderSdkBreakdown(
  out: import('../types.js').Writer,
  usage: Awaited<ReturnType<import('../../../agent/session.js').AgentSession['getContextUsage']>>,
): void {
  const api = usage.apiUsage;
  const input = api?.input_tokens ?? 0;
  const output = api?.output_tokens ?? 0;
  const cacheRead = api?.cache_read_input_tokens ?? 0;
  const cacheCreate = api?.cache_creation_input_tokens ?? 0;
  const lastTurnTotal = input + output + cacheRead + cacheCreate;

  out.line();
  out.line(palette.bold('Token usage') + palette.dim('  (SDK breakdown)'));
  out.line(divider());

  // Cumulative context vs model max — the authoritative numbers.
  out.line(`  total         ${palette.success(formatTokens(usage.totalTokens))}  of  ${palette.meta(formatTokens(usage.maxTokens))}  (${palette.meta(`${Math.round(usage.percentage * 100) / 100}%`)})`);
  if (usage.autoCompactThreshold && usage.isAutoCompactEnabled) {
    out.line(`  compact at    ${palette.meta(formatTokens(usage.autoCompactThreshold))}`);
  }

  // Last-turn API usage (what Anthropic billed for the most recent call).
  out.line();
  out.line(palette.dim('  Last turn (API):'));
  out.line(`    input       ${palette.meta(formatTokens(input))}`);
  out.line(`    output      ${palette.meta(formatTokens(output))}`);
  out.line(`    cache read  ${palette.meta(formatTokens(cacheRead))}`);
  out.line(`    cache creat ${palette.meta(formatTokens(cacheCreate))}`);
  out.line(`    total       ${palette.meta(formatTokens(lastTurnTotal))}`);

  // Top categories by tokens.
  const cats = usage.categories ?? [];
  if (cats.length > 0) {
    const top = [...cats].sort((a, b) => b.tokens - a.tokens).slice(0, 5);
    out.line();
    out.line(palette.dim('  Top categories:'));
    for (const c of top) {
      out.line(`    ${palette.warning(c.name.padEnd(18))} ${palette.meta(formatTokens(c.tokens))}`);
    }
  }

  // Tools detail (system + MCP).
  const systemTools = usage.systemTools ?? [];
  const mcpTools = usage.mcpTools ?? [];
  if (systemTools.length > 0 || mcpTools.length > 0) {
    out.line();
    const sysTotal = systemTools.reduce((s, t) => s + t.tokens, 0);
    const mcpTotal = mcpTools.reduce((s, t) => s + t.tokens, 0);
    if (systemTools.length > 0) {
      out.line(palette.dim(`  system tools  ${systemTools.length} tools, ${formatTokens(sysTotal)} tokens`));
    }
    if (mcpTools.length > 0) {
      out.line(palette.dim(`  MCP tools     ${mcpTools.length} tools, ${formatTokens(mcpTotal)} tokens`));
    }
  }

  // Agents + skills + slash commands summary lines.
  const agents = usage.agents ?? [];
  if (agents.length > 0) {
    const agentsTotal = agents.reduce((s, a) => s + a.tokens, 0);
    out.line(palette.dim(`  agents        ${agents.length} loaded, ${formatTokens(agentsTotal)} tokens`));
  }
  if (usage.skills) {
    const skills = usage.skills;
    out.line(palette.dim(`  skills        ${skills.includedSkills}/${skills.totalSkills} included, ${formatTokens(skills.tokens)} tokens`));
  }
  if (usage.slashCommands) {
    const sc = usage.slashCommands;
    out.line(palette.dim(`  slash cmds    ${sc.includedCommands}/${sc.totalCommands} included, ${formatTokens(sc.tokens)} tokens`));
  }

  out.line();
}

/** Render token usage from local SessionStats when SDK data unavailable. */
function renderLocalFallback(
  out: import('../types.js').Writer,
  stats: import('../types.js').SessionStats,
): void {
  const sumInput = stats.turnTokens.reduce((s, t) => s + t.input, 0);
  const sumOutput = stats.turnTokens.reduce((s, t) => s + t.output, 0);
  const sumCache = stats.turnTokens.reduce((s, t) => s + t.cache, 0);
  const total = sumInput + sumOutput;
  const limit = contextLimitFor(stats.model);
  // Context fill = the LAST turn's footprint, not a sum across turns. Each
  // turn's `cache` is the whole prior conversation read from cache, so summing
  // it across turns multiplies the conversation by the turn count and can blow
  // past 100%. The latest turn's footprint already reflects the full window.
  const lastTurn = stats.turnTokens[stats.turnTokens.length - 1];
  const contextUsed = lastTurn
    ? lastTurn.footprint ?? lastTurn.input + lastTurn.output + lastTurn.cache
    : 0;
  const pct = limit > 0 ? Math.round((contextUsed / limit) * 100) : 0;

  out.line();
  out.line(palette.bold('Token usage') + palette.dim('  (local stats — SDK breakdown unavailable)'));
  out.line(divider());
  out.line(`  input       ${palette.meta(formatTokens(sumInput))}`);
  out.line(`  output      ${palette.meta(formatTokens(sumOutput))}`);
  out.line(`  cache read  ${palette.meta(formatTokens(sumCache))}`);
  out.line(`  total       ${palette.success(formatTokens(total))}`);
  out.line(`  context     ${palette.meta(`${pct}% of ${formatTokens(limit)}  (${stats.model})`)}`);
  out.line();
}

const tokensCmd: SlashCommand = {
  name: '/tokens',
  aliases: ['/ctx'],
  summary: 'Show token usage (SDK breakdown with local-stats fallback)',
  hint: 'When you want to know how full the context window is — input/output/cache breakdown plus % of the model\'s limit used.',
  async handler(ctx) {
    try {
      const usage = await ctx.session.current.getContextUsage();
      renderSdkBreakdown(ctx.out, usage);
    } catch {
      // SDK subprocess may not be up yet (init timing) or the call may
      // fail under unusual conditions. Fall back to the locally-tracked
      // stats so the user still sees something useful.
      renderLocalFallback(ctx.out, ctx.stats);
    }
    return 'continue';
  },
};

const historyCmd: SlashCommand = {
  name: '/history',
  summary: 'Show conversation history',
  async handler(ctx) {
    const { stats, out } = ctx;
    if (stats.turns.length === 0) {
      out.info('No turns yet in this session.');
      return 'continue';
    }
    out.line();
    out.line(palette.bold(`Session history  (${stats.turns.length} turn${stats.turns.length === 1 ? '' : 's'})`));
    out.line(divider());
    stats.turns.forEach((turn, i) => {
      const idx = palette.meta(`#${i + 1}`);
      const userPreview = turn.user.length > 100 ? turn.user.slice(0, 97) + '...' : turn.user;
      const asstPreview = turn.assistant.length > 100 ? turn.assistant.slice(0, 97) + '...' : turn.assistant;
      out.line(`  ${idx}  ${palette.user('▶')} ${userPreview}`);
      out.line(`      ${palette.brand('◆')} ${palette.dim(asstPreview)}`);
    });
    out.line();
    return 'continue';
  },
};

const resetCmd: SlashCommand = {
  name: '/reset',
  summary: 'Clear screen, history, and session stats',
  async handler(ctx) {
    const { stats, ui, out } = ctx;
    try {
      await ctx.session.current.sendMessage('/clear');
    } catch {
      // best-effort
    }
    stats.totalTurns = 0;
    stats.totalCostUsd = 0;
    stats.totalTokens = 0;
    stats.totalDurationMs = 0;
    stats.turnCosts.length = 0;
    stats.turnTokens.length = 0;
    stats.turns.length = 0;
    stats.sessionStartTime = Date.now();
    ui.clearScreen();
    out.success('Session reset.');
    return 'continue';
  },
};

const modelCmd: SlashCommand = {
  name: '/model',
  usage: '/model <small|medium|large|opus|sonnet|haiku|org/model>',
  summary: 'Switch the active model mid-session',
  hint: 'Switch the capability tier (small/medium/large — or your configured names) or pass a full model id. Upgrade to large for a hard problem, downshift to small for cheap iteration — context carries over. Also accepts HuggingFace-style ids (e.g. mlx-community/Qwen3-30B-A3B-4bit).',
  async handler(ctx, args) {
    const target = args.trim().toLowerCase();
    if (!target) {
      ctx.out.info(`Current model: ${palette.brand(ctx.stats.model)}`);
      ctx.out.line(palette.dim(`  Aliases: ${MODEL_ALIASES_HINT.join(', ')}  (or any org/model HF id)`));
      return 'continue';
    }
    // Accept slot tier names / configured custom names, known Claude aliases,
    // OR full HF-style org/model ids (routed openai-compatible). Bare unknown
    // strings (e.g. typos) are rejected — they'd silently fall through to
    // anthropic-direct and produce an unhelpful API error at turn time.
    const isKnownAlias = MODEL_ALIASES_HINT.includes(target as (typeof MODEL_ALIASES_HINT)[number]);
    const isSlotName = slotForInput(target) !== undefined;
    const isHFStyleId = providerForModel(target) === 'openai-compatible';
    if (!isKnownAlias && !isSlotName && !isHFStyleId) {
      ctx.out.warn(`Unknown model: ${target}. Aliases: ${MODEL_ALIASES_HINT.join(', ')}  (or org/model for local/OpenAI-compatible)`);
      return 'continue';
    }
    try {
      await ctx.session.current.setModel(target as AgentModelInput);
      ctx.stats.model = target as AgentModelInput;
      ctx.ui.repaintStatusLine();
      ctx.out.success(`Model switched to ${palette.brand(target)}`);
    } catch (err) {
      ctx.out.error(`Failed to switch model: ${err instanceof Error ? err.message : String(err)}`);
    }
    return 'continue';
  },
};

const toolsCmd: SlashCommand = {
  name: '/tools',
  summary: 'List tools available to the session',
  async handler(ctx) {
    try {
      const meta = await ctx.session.current.waitForInitialization();
      const tools = meta.tools ?? [];
      if (tools.length === 0) {
        ctx.out.info('No tools reported by the session.');
        return 'continue';
      }
      ctx.out.line();
      ctx.out.line(palette.bold(`Tools  (${tools.length})`));
      ctx.out.line(divider());
      const columns = 3;
      const rows = Math.ceil(tools.length / columns);
      const colWidth = Math.max(...tools.map((t) => t.length)) + 2;
      for (let r = 0; r < rows; r++) {
        const row: string[] = [];
        for (let c = 0; c < columns; c++) {
          const idx = c * rows + r;
          if (idx < tools.length) row.push(tools[idx]!.padEnd(colWidth));
        }
        ctx.out.line('  ' + row.join(''));
      }
      ctx.out.line();
    } catch (err) {
      ctx.out.error(`Could not read session tools: ${err instanceof Error ? err.message : String(err)}`);
    }
    return 'continue';
  },
};

const mcpCmd: SlashCommand = {
  name: '/mcp',
  summary: 'List MCP servers connected to the session ("/mcp auth" to surface pending OAuth URLs)',
  async handler(ctx, args) {
    const sub = (args ?? '').trim().toLowerCase();

    // Sub-command dispatch — keep the surface lazy so the file isn't imported
    // unless the operator asks for OAuth surfacing.
    if (sub === 'auth') {
      try {
        const { readOauthPending } = await import('../../../agent/mcp/oauth.js');
        const pending = readOauthPending();
        if (Object.keys(pending).length === 0) {
          ctx.out.info('No MCP servers are waiting for OAuth.');
          return 'continue';
        }
        ctx.out.line();
        ctx.out.line(palette.bold(`MCP OAuth pending  (${Object.keys(pending).length})`));
        ctx.out.line(divider());
        for (const [name, entry] of Object.entries(pending)) {
          const age = Date.now() - entry.timestamp;
          const ageMin = Math.round(age / 60_000);
          ctx.out.line(`  ${palette.warning('●')} ${name}  ${palette.dim(`(${ageMin}m ago)`)}`);
          ctx.out.line(`     ${palette.info(entry.authorizationUrl)}`);
        }
        ctx.out.line();
        ctx.out.line(
          palette.dim(
            '  Open each URL in a browser. After authorizing, paste the code with:',
          ),
        );
        ctx.out.line(
          palette.dim('    /mcp auth complete <serverName> <code>'),
        );
        ctx.out.line();
      } catch (err) {
        ctx.out.error(
          `Could not read OAuth state: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return 'continue';
    }

    // /mcp auth complete <serverName> <code>
    // NOTE: use the original `args` (not lowercased `sub`) for parsing so that
    // mixed-case OAuth codes are delivered to the token endpoint verbatim.
    if (sub.startsWith('auth complete ')) {
      const rawArgs = (args ?? '').trim();
      // rawArgs is "auth complete <serverName> <code>" — strip the fixed prefix
      // case-insensitively by taking everything after the first 14 chars
      // ("auth complete ").  We match on sub (lowercased) for routing but
      // extract values from rawArgs so case is preserved.
      const rest = rawArgs.slice(rawArgs.toLowerCase().indexOf('auth complete ') + 'auth complete '.length).trim();
      // Split on first whitespace: serverName may contain hyphens/dots but
      // not spaces; everything after is the code.
      const spaceIdx = rest.indexOf(' ');
      if (spaceIdx === -1 || rest.slice(0, spaceIdx).length === 0 || rest.slice(spaceIdx + 1).trim().length === 0) {
        ctx.out.error('Usage: /mcp auth complete <serverName> <code>');
        return 'continue';
      }
      const serverName = rest.slice(0, spaceIdx).trim();
      const code = rest.slice(spaceIdx + 1).trim();

      if (!ctx.mcpManager) {
        ctx.out.error(
          'No MCP manager available in this session. ' +
          'Make sure an mcp.json config is present and at least one server is enabled.',
        );
        return 'continue';
      }

      try {
        ctx.out.info(`Completing OAuth for "${serverName}"…`);
        await ctx.mcpManager.completeAuth(serverName, code);
        ctx.out.success(
          `OAuth complete for "${serverName}" — server is now connected.`,
        );
      } catch (err) {
        ctx.out.error(
          `OAuth completion failed for "${serverName}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return 'continue';
    }

    if (sub !== '' && sub !== 'auth') {
      ctx.out.error(
        `Unknown /mcp subcommand: "${sub}". Try: /mcp, /mcp auth, /mcp auth complete <server> <code>.`,
      );
      return 'continue';
    }

    try {
      const meta = await ctx.session.current.waitForInitialization();
      const servers = meta.mcpServers ?? [];
      if (servers.length === 0) {
        ctx.out.info('No MCP servers connected.');
        return 'continue';
      }
      ctx.out.line();
      ctx.out.line(palette.bold(`MCP servers  (${servers.length})`));
      ctx.out.line(divider());
      let pendingCount = 0;
      for (const s of servers) {
        const name = typeof s === 'string' ? s : (s as { name?: string }).name ?? JSON.stringify(s);
        const status = typeof s === 'object' && s !== null && 'status' in s ? String((s as { status: unknown }).status) : '';
        const dot = status === 'connected' ? palette.success('●') : palette.warning('●');
        ctx.out.line(`  ${dot} ${name}${status ? palette.dim(`  (${status})`) : ''}`);
        if (status === 'oauth_pending') pendingCount++;
      }
      ctx.out.line();
      if (pendingCount > 0) {
        ctx.out.line(
          palette.dim(`  ${pendingCount} server(s) need OAuth — run "/mcp auth" to see authorization URLs.`),
        );
        ctx.out.line();
      }
    } catch (err) {
      ctx.out.error(`Could not read MCP servers: ${err instanceof Error ? err.message : String(err)}`);
    }
    return 'continue';
  },
};

const limitsCmd: SlashCommand = {
  name: '/limits',
  summary: 'Show known per-model context-window limits',
  async handler(ctx) {
    ctx.out.line();
    ctx.out.line(palette.bold('Context-window limits'));
    ctx.out.line(divider());
    for (const [model, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
      const marker = model === ctx.stats.model ? palette.brand(' ← active') : '';
      ctx.out.line(`  ${palette.warning(model.padEnd(12))} ${palette.meta(formatTokens(limit))}${marker}`);
    }
    ctx.out.line();
    return 'continue';
  },
};

const debugCmd: SlashCommand = {
  name: '/debug',
  summary: 'Show SDK session metadata (tools, MCP, skills, plugins, etc.)',
  hint: 'When something feels broken and you want to inspect what the session actually loaded — tools, MCP servers, plugins, system prompt source.',
  async handler(ctx) {
    try {
      const meta = await ctx.session.current.waitForInitialization();
      ctx.out.line();
      ctx.out.line(renderDebugBanner(meta));
      ctx.out.line();
    } catch (err) {
      ctx.out.error(`Could not read session metadata: ${err instanceof Error ? err.message : String(err)}`);
    }
    return 'continue';
  },
};

export const infoCommands: SlashCommand[] = [
  costCmd, tokensCmd, historyCmd, resetCmd, modelCmd, toolsCmd, mcpCmd, limitsCmd, debugCmd,
];
