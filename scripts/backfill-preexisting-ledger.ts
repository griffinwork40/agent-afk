/**
 * One-time backfill script: scans historical transcript files for pre-existing-
 * defect flags, clusters by locus, ranks by session count + recency, performs
 * lightweight liveness checks, and writes a markdown ledger to a local path
 * under the AFK state/framework dir (never inside the repo).
 *
 * Usage:
 *   pnpm backfill:preexisting
 *   pnpm backfill:preexisting --test-top 3   # run vitest on top-3 test loci
 *
 * Invariants:
 *   - No transcript prose is persisted — only loci, counts, dates, filenames.
 *   - No network or LLM calls.
 *   - Transcript files are read-only (no mutation).
 *
 * @module scripts/backfill-preexisting-ledger
 */

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { getTranscriptsDir } from '../src/paths.js';
import { detectInText } from '../src/agent/preexisting-ledger/detector.js';
import { getPreexistingBackfillPath } from '../src/agent/preexisting-ledger/paths.js';
import { findLocusMatches, resolveLocusPath } from '../src/agent/preexisting-ledger/resolve.js';

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const testTopFlag = args.indexOf('--test-top');
const testTopN = testTopFlag >= 0 ? parseInt(args[testTopFlag + 1] ?? '0', 10) : 0;

// ---------------------------------------------------------------------------
// Transcript scanning
// ---------------------------------------------------------------------------

interface TranscriptHit {
  locus: string;
  signal: string;
  category: string;
  transcriptFile: string;
  sessionDate: string;
}

function extractAssistantBlocks(markdown: string): string[] {
  // Transcripts use ## Assistant headers; extract each block.
  const blocks: string[] = [];
  const sections = markdown.split(/^##\s+/m);
  for (const section of sections) {
    if (section.startsWith('Assistant')) {
      blocks.push(section.slice('Assistant'.length));
    }
  }
  return blocks;
}

function scanTranscript(filePath: string, fileName: string): TranscriptHit[] {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const blocks = extractAssistantBlocks(content);
  const hits: TranscriptHit[] = [];
  // Derive a session date from the filename (ISO-ish prefix).
  const dateMatch = /^(\d{4}-\d{2}-\d{2})/.exec(fileName);
  const sessionDate = dateMatch ? dateMatch[1]! : '';
  for (const block of blocks) {
    const entries = detectInText(block);
    for (const entry of entries) {
      for (const locus of entry.loci) {
        hits.push({ locus, signal: entry.signal, category: entry.category, transcriptFile: fileName, sessionDate });
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Clustering and ranking
// ---------------------------------------------------------------------------

interface Cluster {
  locus: string;
  category: string;
  sessionCount: number;
  transcriptFiles: string[];
  lastSeen: string;
}

function clusterHits(hits: TranscriptHit[]): Cluster[] {
  // Normalise locus: trim backticks and whitespace.
  const normalize = (l: string) => l.replace(/^`|`$/g, '').trim();

  const map = new Map<string, { category: string; files: Set<string>; dates: string[] }>();
  for (const hit of hits) {
    const key = normalize(hit.locus);
    if (!map.has(key)) {
      map.set(key, { category: hit.category, files: new Set(), dates: [] });
    }
    const entry = map.get(key)!;
    entry.files.add(hit.transcriptFile);
    if (hit.sessionDate) entry.dates.push(hit.sessionDate);
  }

  const clusters: Cluster[] = [];
  for (const [locus, { category, files, dates }] of map.entries()) {
    const lastSeen = dates.length > 0 ? dates.sort().at(-1)! : '';
    clusters.push({ locus, category, sessionCount: files.size, transcriptFiles: [...files], lastSeen });
  }

  // Rank: descending sessionCount, then descending lastSeen.
  clusters.sort((a, b) => {
    if (b.sessionCount !== a.sessionCount) return b.sessionCount - a.sessionCount;
    return b.lastSeen.localeCompare(a.lastSeen);
  });

  return clusters;
}

// ---------------------------------------------------------------------------
// Liveness checks
// ---------------------------------------------------------------------------

interface LivenessResult {
  fileExists?: boolean;
  codeLines?: number | null;
  vitestResult?: 'pass' | 'fail' | 'skip' | 'error';
  recheckCmd?: string;
  /** Tracked files a bare/partial locus matches when it names more than one. */
  ambiguous?: string[];
}

function countCodeLines(filePath: string): number | null {
  try {
    const lines = readFileSync(filePath, 'utf8').split('\n');
    let count = 0;
    let inBlock = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      if (inBlock) {
        if (trimmed.includes('*/')) inBlock = false;
        continue;
      }
      if (trimmed.startsWith('/*') || trimmed.startsWith('/**')) {
        inBlock = true;
        if (trimmed.includes('*/')) inBlock = false;
        continue;
      }
      if (trimmed.startsWith('//')) continue;
      count++;
    }
    return count;
  } catch {
    return null;
  }
}

let trackedFilesCache: string[] | undefined;

/** Repo-tracked files (one `git ls-files` per run). Empty when git is unavailable. */
function trackedFiles(repoCwd: string): string[] {
  if (trackedFilesCache) return trackedFilesCache;
  try {
    const out = execFileSync('git', ['ls-files'], { cwd: repoCwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    trackedFilesCache = out.split('\n').filter(Boolean);
  } catch {
    trackedFilesCache = [];
  }
  return trackedFilesCache;
}

function checkFileLiveness(locus: string, repoCwd: string): LivenessResult {
  const resolved = resolveLocusPath(locus, trackedFiles(repoCwd));
  const candidate = join(repoCwd, resolved ?? locus);
  const fileExists = existsSync(candidate);
  const result: LivenessResult = { fileExists };
  if (fileExists) {
    result.codeLines = countCodeLines(candidate);
  }
  return result;
}

function checkGateLiveness(locus: string): LivenessResult {
  return { recheckCmd: `pnpm ${locus}` };
}

function runVitest(testFile: string, repoCwd: string): 'pass' | 'fail' | 'error' {
  const resolved = resolveLocusPath(testFile, trackedFiles(repoCwd));
  if (!resolved) return 'error';
  try {
    execFileSync('pnpm', ['test', resolved], { cwd: repoCwd, stdio: 'pipe', timeout: 120_000 });
    return 'pass';
  } catch {
    return 'fail';
  }
}

function checkLiveness(cluster: Cluster, repoCwd: string, runVitest_: boolean): LivenessResult {
  const { locus, category } = cluster;
  // Gate-style locus (has colons)
  if (locus.includes(':')) return checkGateLiveness(locus);
  // A bare or partial name that matches several tracked files cannot be
  // checked honestly: running or measuring the first match reports the
  // liveness of a file the agent may never have meant.
  const matches = findLocusMatches(locus, trackedFiles(repoCwd));
  if (matches.length > 1) return { ambiguous: matches };
  // Test file
  if (/\.(test|spec)\.[jt]sx?/.test(locus)) {
    if (runVitest_) {
      const vr = runVitest(locus, repoCwd);
      return { vitestResult: vr };
    }
    return { vitestResult: 'skip', recheckCmd: `pnpm test ${locus}` };
  }
  // File path
  if (locus.includes('/') || category === 'size-ceiling') {
    return checkFileLiveness(locus, repoCwd);
  }
  return {};
}

// ---------------------------------------------------------------------------
// Markdown output
// ---------------------------------------------------------------------------

function renderMarkdown(clusters: Cluster[], liveness: Map<string, LivenessResult>, total: number, transcriptCount: number): string {
  const lines: string[] = [
    '# Pre-existing Defect Ledger (Backfill)',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Transcripts scanned: ${transcriptCount}`,
    `Total hit-locus pairs: ${total}`,
    `Distinct loci: ${clusters.length}`,
    '',
    '---',
    '',
    '## Top Clusters',
    '',
    '| Rank | Locus | Category | Sessions | Last Seen | Liveness |',
    '|------|-------|----------|----------|-----------|----------|',
  ];

  const top = clusters.slice(0, 50);
  for (let i = 0; i < top.length; i++) {
    const c = top[i]!;
    const lr = liveness.get(c.locus) ?? {};
    let livenessStr = '';
    if (lr.ambiguous) {
      livenessStr = `ambiguous (${lr.ambiguous.length} files)`;
    } else if (lr.fileExists !== undefined) {
      livenessStr = lr.fileExists
        ? `exists${lr.codeLines != null ? ` (${lr.codeLines} loc)` : ''}`
        : 'NOT FOUND';
    } else if (lr.vitestResult) {
      livenessStr = lr.vitestResult === 'skip'
        ? `recheck: ${lr.recheckCmd ?? ''}`
        : `vitest: ${lr.vitestResult}`;
    } else if (lr.recheckCmd) {
      livenessStr = `recheck: ${lr.recheckCmd}`;
    } else {
      livenessStr = '-';
    }
    lines.push(`| ${i + 1} | \`${c.locus}\` | ${c.category} | ${c.sessionCount} | ${c.lastSeen} | ${livenessStr} |`);
  }

  lines.push('', '---', '', '## Full List', '');
  for (const c of clusters) {
    lines.push(`- \`${c.locus}\` — ${c.sessionCount} sessions, last ${c.lastSeen}`);
  }

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transcriptsDir = getTranscriptsDir();

  let transcriptFiles: string[] = [];
  try {
    transcriptFiles = readdirSync(transcriptsDir)
      .filter((f) => f.endsWith('.md'))
      .sort();
  } catch {
    console.error(`Transcripts dir not found: ${transcriptsDir}`);
    process.exit(1);
  }

  console.log(`Scanning ${transcriptFiles.length} transcripts in ${transcriptsDir} ...`);

  const allHits: TranscriptHit[] = [];
  for (const f of transcriptFiles) {
    const hits = scanTranscript(join(transcriptsDir, f), f);
    allHits.push(...hits);
  }

  console.log(`Found ${allHits.length} hit-locus pairs across ${transcriptFiles.length} transcripts.`);

  const clusters = clusterHits(allHits);
  console.log(`Distinct loci: ${clusters.length}`);

  // Determine repo cwd (best effort: run from the script's directory).
  const repoCwd = process.cwd();

  // Liveness checks for top 50 clusters.
  const livenessMap = new Map<string, LivenessResult>();
  const top50 = clusters.slice(0, 50);

  // Determine which test loci to run vitest on.
  const testLoci = top50.filter((c) => /\.(test|spec)\.[jt]sx?/.test(c.locus));
  const runTestSet = new Set(testLoci.slice(0, testTopN).map((c) => c.locus));

  for (const c of top50) {
    const runV = runTestSet.has(c.locus);
    livenessMap.set(c.locus, checkLiveness(c, repoCwd, runV));
  }

  const outputPath = getPreexistingBackfillPath();
  mkdirSync(dirname(outputPath), { recursive: true });
  const md = renderMarkdown(clusters, livenessMap, allHits.length, transcriptFiles.length);
  writeFileSync(outputPath, md, 'utf8');

  console.log(`\nLedger written to: ${outputPath}`);
  console.log('\nTop 10 clusters:');
  console.log('Rank | Locus | Sessions | Last Seen | Liveness');
  console.log('-----|-------|----------|-----------|--------');
  for (let i = 0; i < Math.min(10, clusters.length); i++) {
    const c = clusters[i]!;
    const lr = livenessMap.get(c.locus) ?? {};
    let ls = '-';
    if (lr.ambiguous) ls = `ambiguous (${lr.ambiguous.length} files)`;
    else if (lr.fileExists !== undefined) ls = lr.fileExists ? `exists (${lr.codeLines ?? '?'} loc)` : 'NOT FOUND';
    else if (lr.vitestResult) ls = `vitest:${lr.vitestResult}`;
    else if (lr.recheckCmd) ls = `recheck:pnpm ${c.locus}`;
    console.log(`  ${i + 1} | ${c.locus} | ${c.sessionCount} | ${c.lastSeen} | ${ls}`);
  }
}

main().catch((err) => {
  console.error('backfill-preexisting-ledger failed:', err);
  process.exit(1);
});
