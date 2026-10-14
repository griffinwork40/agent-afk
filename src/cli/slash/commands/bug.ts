/**
 * /bug [description] — print a prefilled GitHub issue link for reporting an
 * afk bug.
 *
 * Nothing is sent from the CLI: the user opens the link, reviews the exact
 * public text and the account it will post as on GitHub's own form, and
 * clicks Submit. That keeps the command usable by every npm user (no `gh`
 * install or login, no write access) and makes GitHub's page the
 * confirmation step.
 *
 * Attached automatically: afk version, Node version, OS, model, session id.
 * Deliberately NOT attached: cwd, transcript, tool output, trace contents.
 * Body shaping and the URL rules live in `bug.body.ts`.
 */

import os from 'node:os';
import { palette } from '../../palette.js';
import { getVersion } from '../../version.js';
import { hyperlink, hyperlinksEnabled } from '../../hyperlink.js';
import { BUG_REPORT_REPO, buildBugReportLink, type BugEnvironment } from './bug.body.js';
import type { SlashCommand, SlashContext, SlashResult } from '../types.js';

/** Environment block for the report. Exported for tests. */
export function collectBugEnvironment(ctx: SlashContext): BugEnvironment {
  const env: BugEnvironment = {
    version: getVersion(),
    nodeVersion: process.version,
    os: `${os.platform()} ${os.release()} (${os.arch()})`,
    model: ctx.stats.model,
  };
  if (ctx.stats.sessionId) env.sessionId = ctx.stats.sessionId;
  return env;
}

export const bugCmd: SlashCommand = {
  name: '/bug',
  usage: '/bug [what went wrong]',
  hint: 'Report an afk bug. Prints a prefilled GitHub issue link with your afk version, Node, OS and model; nothing is sent until you submit it on GitHub.',
  summary: 'Report a bug (prints a prefilled GitHub issue link)',
  async handler(ctx, args): Promise<SlashResult> {
    const description = args.trim();
    const { url, truncated } = buildBugReportLink(description, collectBugEnvironment(ctx));

    ctx.out.warn(
      `This creates a PUBLIC issue on ${BUG_REPORT_REPO}. ` +
        'Review the text on GitHub before you submit; nothing is sent until you click Submit.',
    );
    if (truncated) {
      ctx.out.warn('Your description was shortened to fit the URL limit; paste the rest on GitHub.');
    }
    if (hyperlinksEnabled()) {
      ctx.out.info(hyperlink(palette.success('Open the prefilled bug report on GitHub'), url));
    }
    // Always print the raw URL: opening a browser can fail silently on
    // headless, SSH, or WSL hosts, and a printed link can still be copied.
    ctx.out.line(url);
    if (!description) {
      ctx.out.line(palette.dim('Tip: /bug <what went wrong> fills in the title for you.'));
    }
    return 'continue';
  },
};
