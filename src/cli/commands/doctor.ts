import { Command } from 'commander';
import { palette } from '../palette.js';
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
        checks.forEach((check) => {
          let icon: string;
          if (check.state === 'pass') {
            icon = palette.success('✓');
          } else if (check.state === 'warn') {
            icon = palette.warning('⚠');
          } else {
            icon = palette.error('✗');
          }

          let line = `${icon} ${check.name}`;
          if (check.detail) {
            line += ` — ${check.detail}`;
          }
          console.log(line);

          if (check.state === 'fail' && check.fix) {
            console.log(`  Fix: ${check.fix}`);
          }
        });

        console.log(
          `\nSummary: ${summary.passed} passed, ${summary.warned} warned, ${summary.failed} failed`,
        );
      }

      process.exit(summary.failed > 0 ? 1 : 0);
    });
}
