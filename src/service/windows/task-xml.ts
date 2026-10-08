/**
 * Pure Windows Task Scheduler XML generation — the win32 analog of
 * `launchd/plist.ts`'s `renderPlist` and `systemd/unit.ts`'s
 * `renderServiceUnit`. No I/O; deterministic output (sorted env keys)
 * so test snapshots are stable across machines.
 *
 * Schema: Task Scheduler 2.0 (`http://schemas.microsoft.com/windows/2004/02/mit/task`).
 * The task is registered as user-level (LogonType InteractiveToken,
 * RunLevel LeastPrivilege) so no elevation is required.
 *
 * Crash restart is handled via `<RestartOnFailure>` (Interval PT1M,
 * Count 999) so the service behaves like launchd `KeepAlive` and systemd
 * `Restart=always` across crash, OOM, and manual kills.
 *
 * Environment: Task Scheduler has no native env block in the XML schema.
 * We prepend `set "K=V" && ` segments in the cmd.exe command line. Only
 * sorted, safe values are accepted (values containing `"`, `%`, CR, LF,
 * or NUL are rejected to keep the quoting model simple and to prevent
 * newline injection that could split the `set` chain).
 *
 * Security note: the task XML file is written to disk with mode 0o600,
 * but NTFS does not honour POSIX permission bits — the file ACL is
 * controlled by Windows, not by the mode parameter. Environment variable
 * values stored in the task XML therefore sit in plaintext on disk under
 * standard NTFS ACLs. Do not pass secrets through the task environment
 * until NTFS ACL hardening is implemented.
 *
 * @module service/windows/task-xml
 */

/** Inputs that fully determine a generated Task Scheduler XML task. */
export interface TaskXmlOptions {
  /** Task name / label, e.g. `AFK-telegram`. */
  label: string;
  /** The user whose logon triggers the task, from `os.userInfo().username`. */
  userId: string;
  /** Argv — first element is the executable (absolute path). */
  programArguments: string[];
  /** Working directory for the process. */
  workingDirectory: string;
  /** Log file where stdout+stderr are appended. */
  logFile: string;
  /**
   * Extra env vars. Task Scheduler has no native env block; each entry is
   * prepended as `set "K=V" && ` in the cmd.exe arguments string.
   * Keys must match `[A-Za-z_][A-Za-z0-9_]*` — entries with non-conforming
   * keys are silently skipped. Values containing `"`, `%`, CR, LF, or NUL
   * are also silently skipped (documented here).
   */
  environmentVariables?: Record<string, string>;
}

/** XML-escape a value for use inside an XML attribute or element. */
function xmlEsc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Quote one cmd.exe argument using double-quote wrapping. Embedded
 * double-quotes are doubled (`"` → `""`). The result is safe to embed
 * inside the outer `cmd /d /s /c "..."` wrapper as long as the outer
 * wrapper itself uses the same quoting convention used below.
 */
function cmdQuoteArg(arg: string): string {
  // Escape embedded double-quotes by doubling them (cmd.exe convention).
  return `"${arg.replace(/"/g, '""')}"`;
}

/**
 * Build the cmd.exe /C arguments string that:
 *   1. Optionally sets environment variables with `set "K=V" && `.
 *   2. Invokes the program with its arguments.
 *   3. Redirects stdout+stderr to the log file (appending).
 *
 * The entire expression is wrapped in an extra pair of double-quotes as
 * required by `cmd /d /s /c "<expression>"`. Values containing `"`, `%`,
 * CR, LF, or NUL are skipped (see module docstring).
 */
function buildCmdArguments(
  args: string[],
  logFile: string,
  env?: Record<string, string>,
): string {
  const envParts: string[] = [];
  if (env && Object.keys(env).length > 0) {
    for (const k of Object.keys(env).sort()) {
      // Reject keys that are not valid identifier-style names — any of `"`, `=`,
      // `%`, CR, or LF in the key would break the `set "K=V"` quoting model.
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
      const v = env[k] ?? '';
      // Reject values with " or % — both break cmd.exe quoting.
      // Also reject CR, LF, NUL — any of these would split the `set` chain
      // or corrupt the cmd.exe command line.
      if (v.includes('"') || v.includes('%') || /[\r\n\0]/.test(v)) continue;
      // set "K=V" — wrapping value in quotes handles spaces; no % expansion.
      envParts.push(`set "${k}=${v}"`);
    }
  }
  const progParts = args.map(cmdQuoteArg);
  const redirect = `>> ${cmdQuoteArg(logFile)} 2>&1`;
  const inner = [...envParts.map((e) => `${e} &&`), ...progParts, redirect].join(' ');
  // The outer /C "" wrapper: wrap inner in an additional pair of quotes.
  return `/d /s /c "${inner}"`;
}

/**
 * Render a Windows Task Scheduler XML task definition as a UTF-8 string.
 * The caller is responsible for writing it as UTF-16LE with a BOM, which
 * `schtasks /XML` requires.
 *
 * Invariants:
 *   - LogonTrigger (current user) ≈ launchd `RunAtLoad`.
 *   - RestartOnFailure Interval PT1M Count 999 ≈ launchd `KeepAlive`.
 *   - DisallowStartIfOnBatteries false + StopIfGoingOnBatteries false:
 *     keeps the service running on laptops on battery.
 *   - ExecutionTimeLimit PT0S: no timeout — the task runs indefinitely.
 *   - MultipleInstancesPolicy IgnoreNew: no parallel instances.
 */
export function renderTaskXml(opts: TaskXmlOptions): string {
  const cmdArgs = buildCmdArguments(opts.programArguments, opts.logFile, opts.environmentVariables);
  const lines: string[] = [];
  // The declaration says UTF-16 because the caller (writeUtf16Le) re-encodes
  // this UTF-8 string as UTF-16LE with a BOM before writing to disk.
  // The in-memory string is UTF-8; the on-disk file is UTF-16LE.
  lines.push('<?xml version="1.0" encoding="UTF-16"?>');
  lines.push('<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">');
  // RegistrationInfo
  lines.push('  <RegistrationInfo>');
  lines.push(`    <Description>${xmlEsc(opts.label)} AFK service</Description>`);
  lines.push('  </RegistrationInfo>');
  // Triggers
  lines.push('  <Triggers>');
  lines.push('    <LogonTrigger>');
  lines.push('      <Enabled>true</Enabled>');
  lines.push(`      <UserId>${xmlEsc(opts.userId)}</UserId>`);
  lines.push('    </LogonTrigger>');
  lines.push('  </Triggers>');
  // Principals
  lines.push('  <Principals>');
  lines.push('    <Principal id="Author">');
  lines.push(`      <UserId>${xmlEsc(opts.userId)}</UserId>`);
  lines.push('      <LogonType>InteractiveToken</LogonType>');
  lines.push('      <RunLevel>LeastPrivilege</RunLevel>');
  lines.push('    </Principal>');
  lines.push('  </Principals>');
  // Settings
  lines.push('  <Settings>');
  lines.push('    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
  lines.push('    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
  lines.push('    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>');
  lines.push('    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
  lines.push('    <Hidden>true</Hidden>');
  lines.push('    <StartWhenAvailable>true</StartWhenAvailable>');
  lines.push('    <RestartOnFailure>');
  lines.push('      <Interval>PT1M</Interval>');
  lines.push('      <Count>999</Count>');
  lines.push('    </RestartOnFailure>');
  lines.push('  </Settings>');
  // Actions
  lines.push('  <Actions Context="Author">');
  lines.push('    <Exec>');
  lines.push('      <Command>cmd.exe</Command>');
  lines.push(`      <Arguments>${xmlEsc(cmdArgs)}</Arguments>`);
  lines.push(`      <WorkingDirectory>${xmlEsc(opts.workingDirectory)}</WorkingDirectory>`);
  lines.push('    </Exec>');
  lines.push('  </Actions>');
  lines.push('</Task>');
  return lines.join('\n') + '\n';
}
