/**
 * CLI command: `afk insights`
 *
 * Aggregates all local AFK telemetry into a self-contained HTML report.
 *
 * Options:
 *   --days <n>       Lookback window in days (default: 30)
 *   --output <path>  Output path for HTML report (default: ~/.afk/cache/insights.html)
 *   --no-open        Do not automatically open the report in a browser
 *
 * @module cli/commands/insights
 */

import { Command } from 'commander';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { handleCommandError } from '../errors/index.js';
import { getAfkCacheDir } from '../../paths.js';
import { aggregateAll } from '../../insights/aggregators/index.js';
import { evaluateRecommendations } from '../../insights/recommendations.js';
import { generateHtml } from '../../insights/html.js';
import { openInBrowser } from '../../insights/open.js';

export function registerInsightsCommand(program: Command): void {
  program
    .command('insights')
    .description('Generate a local usage analytics report from AFK telemetry')
    .option('--days <n>', 'Lookback window in days', '30')
    .option('--output <path>', 'Output file path for the HTML report')
    .option('--no-open', 'Do not open the report in a browser after generation')
    .action(
      async (opts: { days: string; output?: string; open: boolean }) => {
        try {
          const days = Math.max(1, parseInt(opts.days, 10) || 30);

          // Determine output path
          const cacheDir = getAfkCacheDir();
          const outputPath = opts.output ?? join(cacheDir, 'insights.html');

          // Ensure output directory exists
          mkdirSync(dirname(outputPath), { recursive: true });

          // Aggregate → evaluate → render
          const aggregates = await aggregateAll({ days });
          const recommendations = evaluateRecommendations(aggregates);
          const html = generateHtml(aggregates, recommendations, { days });

          // Write report
          writeFileSync(outputPath, html, 'utf-8');
          process.stdout.write(`✓ Insights report written to ${outputPath}\n`);

          // Open in browser unless suppressed
          if (opts.open !== false) {
            openInBrowser(outputPath);
          }
        } catch (err) {
          handleCommandError(err);
        }
      },
    );
}
