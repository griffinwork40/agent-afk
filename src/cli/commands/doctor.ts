import { Command } from 'commander';
import { healthCheckRows, healthCheckSummary } from '../render/status-panel.js';
import { runDoctorChecks } from './doctor-checks.js';

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check system health and configuration')
    .option('-f, --format <format>', 'Output format (text|json)', 'text')
    .action(async (options: { format: string }) => {
      const checks = await runDoctorChecks();

      const summary = {
        passed: checks.filter((c) => c.state === 'pass').length,
        warned: checks.filter((c) => c.state === 'warn').length,
        failed: checks.filter((c) => c.state === 'fail').length,
      };

      if (options.format === 'json') {
        console.log(JSON.stringify({ checks, summary }, null, 2));
      } else {
        for (const check of checks) {
          for (const line of healthCheckRows(check)) {
            console.log(line);
          }
        }
        console.log('\n' + healthCheckSummary(checks));
      }

      process.exit(summary.failed > 0 ? 1 : 0);
    });
}
