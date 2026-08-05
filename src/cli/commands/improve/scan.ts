import { Command } from 'commander';
import { handleCommandError } from '../../errors/index.js';
import { scanWitness, parseDuration } from '../../../improve/scan/reader.js';
import { DEFAULT_MIN_REPEATS } from '../../../improve/scan/detectors/repeated-tool-use.js';
import { DEFAULT_CLOSURE_ANOMALY_MIN_OCCURRENCES } from '../../../improve/scan/detectors/closure-anomaly.js';
import { DEFAULT_SUBAGENT_BLOCK_MIN_OCCURRENCES } from '../../../improve/scan/detectors/subagent-block.js';
import { DEFAULT_SUBAGENT_READ_DENIAL_MIN_OCCURRENCES } from '../../../improve/scan/detectors/subagent-read-denial.js';
import {
  DEFAULT_TOOL_FAILURE_MIN_FAILURES,
  DEFAULT_TOOL_FAILURE_MIN_RATE,
} from '../../../improve/scan/detectors/tool-failure-density.js';
import {
  knownDetectorNames,
  runAllDetectors,
  disabledByDefaultDetectorNames,
  type DetectorOptions,
} from '../../../improve/scan/detectors/index.js';
import { writeCard } from '../../../improve/scan/card-writer.js';

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

export function registerScanSubcommand(improve: Command): void {
  improve
    .command('scan')
    .description(
      'Run registered detectors against witness traces. Dry-run by default.\n' +
      `  Some detectors are disabled by default (pass --include-disabled to enable): ${disabledByDefaultDetectorNames().join(', ')}.`,
    )
    .option('--since <duration>', 'Only scan sessions newer than this (e.g. 7d, 24h, all)', '7d')
    .option('--write', 'Persist failure cards to disk. Without this flag, scan is dry-run.', false)
    .option(
      '--min-repeats <n>',
      `repeated-tool-use threshold (default ${DEFAULT_MIN_REPEATS})`,
      String(DEFAULT_MIN_REPEATS),
    )
    .option(
      '--closure-min-occurrences <n>',
      `closure-anomaly threshold (default ${DEFAULT_CLOSURE_ANOMALY_MIN_OCCURRENCES})`,
      String(DEFAULT_CLOSURE_ANOMALY_MIN_OCCURRENCES),
    )
    .option(
      '--block-min-occurrences <n>',
      `subagent-block threshold (default ${DEFAULT_SUBAGENT_BLOCK_MIN_OCCURRENCES})`,
      String(DEFAULT_SUBAGENT_BLOCK_MIN_OCCURRENCES),
    )
    .option(
      '--read-denial-min-occurrences <n>',
      `subagent-read-denial threshold (default ${DEFAULT_SUBAGENT_READ_DENIAL_MIN_OCCURRENCES})`,
      String(DEFAULT_SUBAGENT_READ_DENIAL_MIN_OCCURRENCES),
    )
    .option(
      '--tool-failure-min-failures <n>',
      `tool-failure-density absolute count threshold (default ${DEFAULT_TOOL_FAILURE_MIN_FAILURES})`,
      String(DEFAULT_TOOL_FAILURE_MIN_FAILURES),
    )
    .option(
      '--tool-failure-min-rate <rate>',
      `tool-failure-density rate threshold, 0–1 (default ${DEFAULT_TOOL_FAILURE_MIN_RATE})`,
      String(DEFAULT_TOOL_FAILURE_MIN_RATE),
    )
    .option(
      '--only <names>',
      `Comma-separated detector names to run (any of: ${knownDetectorNames().join(', ')})`,
    )
    .option(
      '--include-disabled',
      `Run detectors marked disabled-by-default (currently: ${disabledByDefaultDetectorNames().join(', ')})`,
      false,
    )
    .action(
      (opts: {
        since: string;
        write: boolean;
        minRepeats: string;
        closureMinOccurrences: string;
        blockMinOccurrences: string;
        readDenialMinOccurrences: string;
        toolFailureMinFailures: string;
        toolFailureMinRate: string;
        only?: string;
        includeDisabled: boolean;
      }) => {
        try {
          const minRepeats = parsePositiveInt(opts.minRepeats, 'min-repeats', 2);
          const closureMin = parsePositiveInt(
            opts.closureMinOccurrences,
            'closure-min-occurrences',
            1,
          );
          const blockMin = parsePositiveInt(opts.blockMinOccurrences, 'block-min-occurrences', 1);
          const readDenialMin = parsePositiveInt(
            opts.readDenialMinOccurrences,
            'read-denial-min-occurrences',
            1,
          );
          const tfMinFailures = parsePositiveInt(
            opts.toolFailureMinFailures,
            'tool-failure-min-failures',
            1,
          );
          const tfMinRate = parseRate(opts.toolFailureMinRate, 'tool-failure-min-rate');

          let enabled: Set<string> | undefined;
          if (opts.only) {
            const requested = opts.only.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
            const known = new Set(knownDetectorNames());
            const unknown = requested.filter((n) => !known.has(n));
            if (unknown.length > 0) {
              console.error(
                `Unknown detector(s): ${unknown.join(', ')}. Known: ${knownDetectorNames().join(', ')}`,
              );
              process.exit(2);
            }
            enabled = new Set(requested);
          }

          let sinceMs: number | undefined;
          if (opts.since && opts.since !== 'all') {
            const ms = parseDuration(opts.since);
            if (ms === undefined) {
              console.error(
                `Invalid --since: '${opts.since}'. Use forms like '7d', '24h', '30m', '3600s', or 'all'.`,
              );
              process.exit(2);
            }
            sinceMs = Date.now() - ms;
          }

          const scan = scanWitness({ sinceMs });
          const detectorOptions: DetectorOptions = {
            minRepeats,
            closureAnomalyMinOccurrences: closureMin,
            subagentBlockMinOccurrences: blockMin,
            subagentReadDenialMinOccurrences: readDenialMin,
            toolFailureMinFailures: tfMinFailures,
            toolFailureMinRate: tfMinRate,
          };
          const detections = runAllDetectors(
            scan.sessions,
            detectorOptions,
            enabled,
            opts.includeDisabled,
          );

          console.log(`Scanned ${scan.sessionsScanned} sessions`);
          if (scan.sessionsSkippedOld > 0) {
            console.log(`  ↳ skipped ${scan.sessionsSkippedOld} older than --since`);
          }
          if (scan.sessionsSkippedEmpty > 0) {
            console.log(`  ↳ skipped ${scan.sessionsSkippedEmpty} with missing/unreadable trace.jsonl`);
          }
          if (scan.invalidLineCount > 0) {
            console.log(`  ⚠ ${scan.invalidLineCount} invalid JSONL lines skipped`);
          }

          // Surface a note when disabled-by-default detectors were silently skipped.
          const disabled = disabledByDefaultDetectorNames();
          if (!opts.only && !opts.includeDisabled && disabled.length > 0) {
            console.log(
              `Skipped ${disabled.length} detectors (disabled by default — pass --only or --include-disabled): ${disabled.join(', ')}`,
            );
          }

          // Per-pattern summary.
          const byPattern = new Map<string, number>();
          for (const d of detections) {
            byPattern.set(d.pattern, (byPattern.get(d.pattern) ?? 0) + 1);
          }
          console.log(`Detections: ${detections.length}`);
          for (const [pattern, count] of byPattern.entries()) {
            console.log(`  ↳ ${pattern}: ${count}`);
          }

          if (detections.length === 0) {
            if (opts.write) console.log('No cards written.');
            return;
          }

          for (const d of detections) {
            console.log(`  • ${d.slug}  [${d.severity}]  ${d.pattern}  evidence=${d.evidence.length}`);
          }

          if (!opts.write) {
            console.log('');
            console.log('(dry-run — pass --write to persist cards)');
            return;
          }

          let created = 0;
          let updated = 0;
          let noop = 0;
          for (const d of detections) {
            const outcome = writeCard(d);
            if (outcome.event === 'created') created += 1;
            else if (outcome.event === 'updated') updated += 1;
            else noop += 1;
          }
          console.log('');
          console.log(`Wrote cards: ${created} created, ${updated} updated, ${noop} no-op merges.`);
        } catch (err) {
          handleCommandError(err);
        }
      },
    );
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function parsePositiveInt(input: string, name: string, min: number): number {
  const n = Number.parseInt(input, 10);
  if (!Number.isFinite(n) || n < min) {
    console.error(`Invalid --${name}: '${input}' (must be integer >= ${min})`);
    process.exit(2);
  }
  return n;
}

function parseRate(input: string, name: string): number {
  const n = Number.parseFloat(input);
  if (!Number.isFinite(n) || n <= 0 || n > 1) {
    console.error(`Invalid --${name}: '${input}' (must be number in (0, 1])`);
    process.exit(2);
  }
  return n;
}
