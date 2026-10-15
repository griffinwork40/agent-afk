/** Narrow data exemptions for the two bash gates. Not a shell parser: ambiguous
 * syntax stays visible to the existing patterns (false positives beat bypasses).
 */
import { tokenizeSegments } from './tools/readonly-bash.tokenizer.js';

interface Word { text: string; start: number; end: number; quoted: boolean }

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
      if (ch === '\\' || ch === '`' || ch === '$' || /[;|&()#]/.test(ch)) return null;
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
  const lines = command.split('\n');
  const output: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.includes('<<')) {
      const match = /<<(-?)[ \t]*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|([A-Za-z_]\w*))/.exec(line);
      // Without a recognizable delimiter, scan the remainder unchanged.
      if (!match || line.indexOf('<<', match.index + 2) >= 0) {
        output.push(...lines.slice(i));
        break;
      }
      const delimiter = match[2] ?? match[3] ?? match[4]!;
      let end = i + 1;
      while (end < lines.length &&
        (match[1] ? lines[end]!.replace(/^\t+/, '') : lines[end]) !== delimiter) end++;
      if (end === lines.length) { output.push(...lines.slice(i)); break; }
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
      if (!exempt) { output.push(...lines.slice(i)); break; }
      output.push(maskArguments(line));
      output.push(...lines.slice(i + 1, end).map(() => ''));
      output.push(lines[end]!);
      i = end;
      continue;
    }
    // Unsupported syntax can continue across newlines (quotes, substitutions,
    // backslashes). Do not mistake a later line in that payload for a command.
    if (!words(line)) { output.push(...lines.slice(i)); break; }
    const masked = maskArguments(line);
    // Preserve the existing literal-search exemption only for non-executing
    // text commands, not shell/interpreter payloads or command substitutions.
    const tokens = tokenizeSegments(masked);
    const literalSearch = words(masked) && tokens.length === 1 &&
      ['echo', 'grep', 'rg'].includes(tokens[0]?.[0] ?? '');
    output.push(stripLiterals && literalSearch ? masked.replace(/'[^']*'/g, '') : masked);
  }
  return output.join('\n');
}
