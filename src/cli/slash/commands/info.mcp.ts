/**
 * `/mcp` slash command — list connected MCP servers and surface pending
 * OAuth URLs. Split out of `info.ts` (file-size ceiling, #3481).
 *
 * Sub-commands:
 *   /mcp                    list connected servers + status dots
 *   /mcp auth               show pending OAuth URLs
 *   /mcp auth complete <server> <code>   complete an OAuth flow
 *
 * @module cli/slash/commands/info.mcp
 */

import { palette } from '../../palette.js';
import { divider } from '../../render.js';
import { errorMessage } from '../../../utils/errors.js';
import type { SlashCommand } from '../types.js';

export const mcpCmd: SlashCommand = {
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
          `Could not read OAuth state: ${errorMessage(err)}`,
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
          `OAuth completion failed for "${serverName}": ${errorMessage(err)}`,
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
      ctx.out.error(`Could not read MCP servers: ${errorMessage(err)}`);
    }
    return 'continue';
  },
};
