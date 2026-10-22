import { palette } from '../../palette.js';
import { divider } from '../../render.js';
import { formatTokens } from '../../format-utils.js';
import { cacheHitRate } from '../../commands/trace-usage-format.js';
import { readTokenUsage, type LocalTokenUsage } from '../../../agent/session-control/index.js';
import { writeKeyValue, writeTable } from '../output-blocks.js';
import type { SlashCommand } from '../types.js';

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
  // Contract: never sum the four fields above (mixed basis, double-counts
  // prior rounds). `totalTokens` and `context_window_tokens` both hold the
  // SAME last-round footprint (buildContextUsageFields, auto-compact.ts), so
  // neither is a cumulative total. Precedence matches context-sampler.ts's
  // resolveUsedTokens (status line) — arbitrary today per that docstring.
  const lastTurnTotal = usage.totalTokens ?? api?.context_window_tokens ?? 0;
  const hitRate = cacheHitRate(cacheRead, cacheCreate);

  writeKeyValue(out, {
    title: 'Token usage (SDK breakdown)',
    entries: [
      { key: 'total', value: `${formatTokens(usage.totalTokens ?? 0)} of ${formatTokens(usage.maxTokens ?? 0)} (${usage.percentage !== undefined ? Math.round(usage.percentage * 100) / 100 : '?'}%)` },
      ...(usage.autoCompactThreshold && usage.isAutoCompactEnabled
        ? [{ key: 'compact at', value: formatTokens(usage.autoCompactThreshold) }] : []),
    ],
  }, () => {
    out.line();
    out.line(palette.bold('Token usage') + palette.dim('  (SDK breakdown)'));
    out.line(divider());
  
    // Cumulative context vs model max — the authoritative numbers.
    out.line(`  total         ${palette.success(formatTokens(usage.totalTokens ?? 0))}  of  ${palette.meta(formatTokens(usage.maxTokens ?? 0))}  (${palette.meta(`${usage.percentage !== undefined ? Math.round(usage.percentage * 100) / 100 : '?'}%`)})`);
    if (usage.autoCompactThreshold && usage.isAutoCompactEnabled) {
      out.line(`  compact at    ${palette.meta(formatTokens(usage.autoCompactThreshold))}`);
    }
  });

  // Last-turn API usage (what Anthropic billed for the most recent call).
  writeKeyValue(out, {
    title: 'Last turn (API)',
    entries: [
      { key: 'input', value: `${formatTokens(input)} (turn total)` },
      { key: 'output', value: `${formatTokens(output)} (turn total)` },
      { key: 'cache read', value: `${formatTokens(cacheRead)} (last call)` },
      { key: 'cache creat', value: `${formatTokens(cacheCreate)} (last call)` },
      ...(hitRate !== undefined ? [{ key: 'cache hit', value: `${hitRate}% (of cached tokens, last call)` }] : []),
      { key: 'window', value: `${formatTokens(lastTurnTotal)} (last call occupancy)` },
    ],
  }, () => {
    out.line();
    out.line(palette.dim('  Last turn (API):'));
    out.line(`    input       ${palette.meta(formatTokens(input))}  ${palette.dim('(turn total)')}`);
    out.line(`    output      ${palette.meta(formatTokens(output))}  ${palette.dim('(turn total)')}`);
    out.line(`    cache read  ${palette.meta(formatTokens(cacheRead))}  ${palette.dim('(last call)')}`);
    out.line(`    cache creat ${palette.meta(formatTokens(cacheCreate))}  ${palette.dim('(last call)')}`);
    if (hitRate !== undefined) {
      out.line(`    cache hit   ${palette.meta(`${hitRate}%`)}  ${palette.dim('(of cached tokens, last call)')}`);
    }
    out.line(`    window      ${palette.meta(formatTokens(lastTurnTotal))}  ${palette.dim('(last call occupancy)')}`);
  });

  // Top categories by tokens.
  const cats = usage.categories ?? [];
  if (cats.length > 0) {
    const top = [...cats].sort((a, b) => b.tokens - a.tokens).slice(0, 5);
    writeTable(out, {
      title: 'Top categories', columns: ['Category', 'Tokens'],
      rows: top.map((c) => [c.name, formatTokens(c.tokens)]),
    }, () => {
      out.line();
      out.line(palette.dim('  Top categories:'));
      for (const c of top) {
        out.line(`    ${palette.warning(c.name.padEnd(18))} ${palette.meta(formatTokens(c.tokens))}`);
      }
    });
  }

  const resourceEntries: Array<{ key: string; value: string }> = [];
  for (const [key, resources] of [
    ['system tools', usage.systemTools ?? []], ['MCP tools', usage.mcpTools ?? []],
    ['agents', usage.agents ?? []],
  ] as const) {
    if (resources.length > 0) resourceEntries.push({ key,
      value: `${resources.length} ${key === 'agents' ? 'loaded' : 'tools'}, ${formatTokens(resources.reduce((sum, item) => sum + item.tokens, 0))} tokens`,
    });
  }
  if (usage.skills) resourceEntries.push({ key: 'skills',
    value: `${usage.skills.includedSkills}/${usage.skills.totalSkills} included, ${formatTokens(usage.skills.tokens)} tokens`,
  });
  if (usage.slashCommands) resourceEntries.push({ key: 'slash cmds',
    value: `${usage.slashCommands.includedCommands}/${usage.slashCommands.totalCommands} included, ${formatTokens(usage.slashCommands.tokens)} tokens`,
  });
  if (resourceEntries.length > 0) writeKeyValue(out, { title: 'Loaded resources', entries: resourceEntries }, () => {
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
  });

  out.line();
}

/** Render token usage from local SessionStats when SDK data unavailable. */
function renderLocalFallback(
  out: import('../types.js').Writer,
  usage: LocalTokenUsage,
): void {
  const { input: sumInput, output: sumOutput, cache: sumCache, total, contextLimit: limit, percentage: pct } = usage;

  writeKeyValue(out, {
    title: 'Token usage (local stats — SDK breakdown unavailable)',
    entries: [
      { key: 'input', value: formatTokens(sumInput) },
      { key: 'output', value: formatTokens(sumOutput) },
      { key: 'cache read', value: formatTokens(sumCache) },
      { key: 'total', value: formatTokens(total) },
      { key: 'context', value: `${pct}% of ${formatTokens(limit)}  (${usage.model})` },
    ],
  }, () => {
    out.line();
    out.line(palette.bold('Token usage') + palette.dim('  (local stats — SDK breakdown unavailable)'));
    out.line(divider());
    out.line(`  input       ${palette.meta(formatTokens(sumInput))}`);
    out.line(`  output      ${palette.meta(formatTokens(sumOutput))}`);
    out.line(`  cache read  ${palette.meta(formatTokens(sumCache))}`);
    out.line(`  total       ${palette.success(formatTokens(total))}`);
    out.line(`  context     ${palette.meta(`${pct}% of ${formatTokens(limit)}  (${usage.model})`)}`);
    out.line();
  });
}

export const tokensCmd: SlashCommand = {
  name: '/tokens',
  aliases: ['/ctx'],
  summary: 'Show token usage (SDK breakdown with local-stats fallback)',
  hint: 'When you want to know how full the context window is — input/output/cache breakdown plus % of the model\'s limit used.',
  async handler(ctx) {
    const result = await readTokenUsage(ctx.session.current, ctx.stats);
    if (result.kind === 'sdk') renderSdkBreakdown(ctx.out, result.usage);
    else renderLocalFallback(ctx.out, result);
    return 'continue';
  },
};

