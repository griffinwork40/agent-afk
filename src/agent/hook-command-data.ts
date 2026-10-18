/** Narrow data exemptions for the two bash gates. Not a shell parser: ambiguous
 * syntax stays visible to the existing patterns (false positives beat bypasses).
 */
import { tokenizeSegments } from './tools/readonly-bash.tokenizer.js';

interface Word { text: string; start: number; end: number; quoted: boolean }

/**
 * Strip shell comments: a `#` that begins a new word outside quotes starts a
 * comment through end-of-line. Returns the command portion without the comment.
 * Quote-aware: `#` inside single or double quotes is literal.
 */
function stripShellComment(line: string): string {
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === "'") {
      i++;
      while (i < line.length && line[i] !== "'") i++;
      if (i < line.length) i++;
    } else if (ch === '"') {
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < line.length) i++;
        i++;
      }
      if (i < line.length) i++;
    } else if (ch === '\\' && i + 1 < line.length) {
      i += 2;
    } else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]!))) {
      return line.slice(0, i).trimEnd();
    } else {
      i++;
    }
  }
  return line;
}

/** Preserve offsets and quote provenance that tokenizeSegments intentionally drops. */
function words(line: string): Word[] | null {
  const result: Word[] = [];
  let i = 0;
  while (i < line.length) {
    if (/\s/.test(line[i]!)) { i++; continue; }
    const start = i;
    let text = '';
    let quoted = false;
    while (i < line.length && !/\s/.test(line[i]!)) {
      const ch = line[i++]!;
      if (ch === '\\' || ch === '`' || ch === '$' || /[;|&()]/.test(ch)) return null;
      if (ch === "'" || ch === '"') {
        quoted = true;
        while (i < line.length && line[i] !== ch) {
          const c = line[i++]!;
          if (ch === '"' && /[$`\\]/.test(c)) return null;
          text += c;
        }
        if (line[i] !== ch) return null;
        i++;
      } else text += ch;
    }
    result.push({ text, start, end: i, quoted });
  }
  return result;
}

/**
 * Mask multiline quoted arguments in allowlisted commands before line splitting.
 * A single-quoted or double-quoted argument to a known flag (--body, -m, etc.)
 * that spans newlines has its content replaced with spaces so that the
 * line-by-line scanner does not see the inner text as separate commands.
 * Executable substitutions ($(...), backticks) inside double quotes bail out.
 */
function maskMultilineQuotedArgs(command: string): string {
  // Invariant: only mask arguments to known data-carrying flags in allowlisted
  // commands. Executable payloads (bash -c '...') must remain visible.
  const dataFlags = new Set([
    '-m', '--message', '--body', '--title',
  ]);
  const chars = command.split('');
  let i = 0;
  while (i < command.length) {
    const ch = command[i]!;
    if (ch === '\\' && i + 1 < command.length) { i += 2; continue; }
    if (ch === "'") {
      const qStart = i;
      i++;
      while (i < command.length && command[i] !== "'") i++;
      if (i >= command.length) break;
      i++; // closing quote
      // Check if this quoted span contains newlines and is preceded by a data flag.
      const span = command.slice(qStart, i);
      if (!span.includes('\n')) continue;
      // Walk backward past optional = to find the flag.
      const before = command.slice(0, qStart);
      const flagMatch = /(?:^|[\s=])(-m|--message|--body|--title)\s*=?\s*$/.exec(before);
      if (!flagMatch || !dataFlags.has(flagMatch[1]!)) continue;
      // Verify the command starts with an allowlisted consumer.
      const prefix = command.slice(0, flagMatch.index).trimStart() + ' ' + flagMatch[1]!;
      const prefixTokens = prefix.trim().split(/\s+/);
      if (!isDataConsumerPrefix(prefixTokens)) continue;
      for (let j = qStart + 1; j < i - 1; j++) chars[j] = chars[j] === '\n' ? '\n' : ' ';
    } else if (ch === '"') {
      const qStart = i;
      i++;
      let hasSubstitution = false;
      while (i < command.length && command[i] !== '"') {
        const c = command[i]!;
        if (c === '\\' && i + 1 < command.length) { i += 2; continue; }
        if (c === '$' || c === '`') { hasSubstitution = true; }
        i++;
      }
      if (i >= command.length) break;
      i++; // closing quote
      if (hasSubstitution) continue;
      const span = command.slice(qStart, i);
      if (!span.includes('\n')) continue;
      const before = command.slice(0, qStart);
      const flagMatch = /(?:^|[\s=])(-m|--message|--body|--title)\s*=?\s*$/.exec(before);
      if (!flagMatch || !dataFlags.has(flagMatch[1]!)) continue;
      const prefix = command.slice(0, flagMatch.index).trimStart() + ' ' + flagMatch[1]!;
      const prefixTokens = prefix.trim().split(/\s+/);
      if (!isDataConsumerPrefix(prefixTokens)) continue;
      for (let j = qStart + 1; j < i - 1; j++) chars[j] = chars[j] === '\n' ? '\n' : ' ';
    } else {
      i++;
    }
  }
  return chars.join('');
}

/**
 * Check whether a token prefix matches an allowlisted data consumer command.
 * Only `-c`/`-C` git flags are skipped; other global flags like `--no-pager`
 * or `--git-dir` are not handled (conservative: may produce false positives).
 */
function isDataConsumerPrefix(tokens: string[]): boolean {
  if (tokens[0] === 'git') {
    let k = 1;
    while (tokens[k] === '-c' || tokens[k] === '-C') k += 2;
    return tokens[k] === 'commit';
  }
  if (tokens[0] === 'gh' && (tokens[1] === 'pr' || tokens[1] === 'issue') &&
      ['create', 'edit', 'comment'].includes(tokens[2] ?? '')) return true;
  return false;
}

function consumer(tokens: readonly string[]): 'git' | 'gh' | 'text' | null {
  // No wrappers, aliases, assignments, or executable basename normalization.
  if (tokens[0] === 'tee') return 'text';
  if (tokens[0] === 'cat') return 'text';
  if (tokens[0] === 'git') {
    let i = 1;
    while (tokens[i] === '-c' || tokens[i] === '-C') i += 2;
    return tokens[i] === 'commit' ? 'git' : null;
  }
  if (tokens[0] === 'gh' && (tokens[1] === 'pr' || tokens[1] === 'issue') &&
      ['create', 'edit', 'comment'].includes(tokens[2] ?? '')) return 'gh';
  return null;
}

function maskArguments(line: string): string {
  const parsed = words(line);
  if (!parsed) return line;
  const segments = tokenizeSegments(line);
  if (segments.length !== 1) return line;
  const kind = consumer(segments[0]!);
  const flags = kind === 'git' ? ['-m', '--message'] :
    kind === 'gh' ? ['--body', '--title'] : [];
  const chars = line.split('');
  for (let i = 0; i < parsed.length; i++) {
    const word = parsed[i]!;
    const equals = word.text.indexOf('=');
    const flag = equals < 0 ? word.text : word.text.slice(0, equals);
    const value = equals < 0 ? parsed[i + 1] : word;
    // Only fully quoted values: concatenated unquoted text remains conservative.
    const raw = value ? line.slice(value.start, value.end) : '';
    const valueRaw = equals < 0 ? raw : raw.slice(raw.indexOf('=') + 1);
    if (flags.includes(flag) && value?.quoted &&
        /^(?:'[^']*'|"[^"$`\\]*")$/.test(valueRaw)) {
      for (let j = value.start; j < value.end; j++) chars[j] = ' ';
      if (equals < 0) i++;
    }
  }
  return chars.join('');
}

/** Only a single, quoted, terminated heredoc into an allowlisted data consumer
 * is exempt. Unquoted heredocs can expand commands, even when fed to cat.
 * Unsafe heredoc bodies remain verbatim, including quotes and comment markers.
 */
export function maskHookCommandData(command: string, stripLiterals = false): string {
  const masked = maskMultilineQuotedArgs(command);
  const lines = masked.split('\n');
  const output: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.includes('<<')) {
      const match = /<<(-?)[ \t]*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|([A-Za-z_]\w*))/.exec(line);
      // Without a recognizable delimiter, scan the remainder unchanged.
      if (!match || line.indexOf('<<', match.index + 2) >= 0) {
        for (let j = i; j < lines.length; j++) output.push(lines[j]!);
        break;
      }
      const delimiter = match[2] ?? match[3] ?? match[4]!;
      let end = i + 1;
      while (end < lines.length &&
        (match[1] ? lines[end]!.replace(/^\t+/, '') : lines[end]) !== delimiter) end++;
      if (end === lines.length) { for (let j = i; j < lines.length; j++) output.push(lines[j]!); break; }
      const header = line.slice(0, match.index) + line.slice(match.index + match[0].length);
      const parsed = words(header);
      const segments = tokenizeSegments(header);
      const tokens = segments[0] ?? [];
      const kind = parsed && segments.length === 1 ? consumer(tokens) : null;
      // Check actual unquoted option words, not flag-like text inside messages.
      const stdinFlag = kind === 'git' ? ['-F', '--file'] : kind === 'gh' ? ['--body-file'] : [];
      const stdinOption = parsed?.some((word, index) => !word.quoted && stdinFlag.includes(word.text) &&
        parsed[index + 1]?.text === '-' && !parsed[index + 1]?.quoted);
      // cat must have a real output redirection; quoted '>' is just an argument.
      const writesFile = tokens[0] === 'tee' || (tokens[0] === 'cat' &&
        parsed?.some((word) => !word.quoted && /^>>?(?:[^<>]|$)/.test(word.text)));
      const stdin = kind === 'text' ? writesFile : stdinOption;
      // A regex hit inside a quoted argument is not a heredoc operator. Require
      // a word beginning at the operator and a complete delimiter token.
      const operatorWord = words(line)?.find((word) => word.start === match.index);
      const boundary = line[match.index + match[0].length];
      const exempt = Boolean((match[2] || match[3]) && stdin && kind && operatorWord &&
        (boundary === undefined || /\s/.test(boundary)));
      if (!exempt) { for (let j = i; j < lines.length; j++) output.push(lines[j]!); break; }
      output.push(maskArguments(line));
      // Limitation: the heredoc body window (i+1..end-1) is blanked per-line
      // but there is a cross-call write-then-execute gap: a `cat >file` or `tee`
      // heredoc is exempted from masking after the header is checked, yet the
      // file written in one tool call may be executed by a later call. This
      // exemption only prevents false positives on clearly non-executable sinks;
      // the cross-call gap is an accepted limitation of static single-call analysis.
      for (let j = i + 1; j < end; j++) output.push('');
      output.push(lines[end]!);
      i = end;
      continue;
    }
    // Strip shell comments before testing parsability. A `#` starting a word
    // outside quotes begins a comment; the comment text is not executable.
    const decommented = stripShellComment(line);
    // Unsupported syntax can continue across newlines (quotes, substitutions,
    // backslashes). Do not mistake a later line in that payload for a command.
    if (!words(decommented)) { for (let j = i; j < lines.length; j++) output.push(lines[j]!); break; }
    const masked2 = maskArguments(decommented);
    // Preserve the existing literal-search exemption only for non-executing
    // text commands, not shell/interpreter payloads or command substitutions.
    const tokens = tokenizeSegments(masked2);
    const literalSearch = words(masked2) && tokens.length === 1 &&
      ['echo', 'grep', 'rg'].includes(tokens[0]?.[0] ?? '');
    output.push(stripLiterals && literalSearch ? masked2.replace(/'[^']*'/g, '') : masked2);
  }
  return output.join('\n');
}
