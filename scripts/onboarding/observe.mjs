// Record-only driver. Entry points supply an isolated, credential-free environment.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const windows = process.platform === 'win32';
const log = resolve(process.argv[2]);
const shell = process.argv[3];
const summary = [];
let infrastructureError = false;
mkdirSync(dirname(log), { recursive: true });
const args = command => windows
  ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference = 'Continue'; ${command}; $ok = $?; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }; if (!$ok) { exit 1 }`]
  : ['-c', command];
appendFileSync(log, `Onboarding observation\nStarted: ${new Date().toISOString()}\nPublished npm latest, not this checkout. Closed stdin, isolated AFK home.\nOutput streams merged in arrival order; no output truncation.\n`);

async function step(label, command, timeout = 60000) {
  const started = Date.now();
  appendFileSync(log, `\n=== ${label} ===\nCommand: ${command}\nShell: ${shell} ${JSON.stringify(args(command))}\nStarted: ${new Date().toISOString()}\n`);
  const result = await new Promise(resolveResult => {
    const child = spawn(shell, args(command), { stdio: ['pipe', 'pipe', 'pipe'], detached: !windows });
    child.stdin.end();
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', data => appendFileSync(log, data));
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (windows) spawnSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F']);
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } }
    }, timeout);
    child.on('error', error => {
      infrastructureError = true;
      appendFileSync(log, `\nObservation infrastructure spawn error: ${error.message}\n`);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolveResult({ code, signal, timedOut });
    });
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(2);
  appendFileSync(log, `\nExit code: ${result.code}; signal: ${result.signal}; timeout: ${result.timedOut}; duration: ${seconds}s\n`);
  summary.push(`| ${label} | ${result.code ?? 'no exit'} | ${seconds}s | ${result.timedOut ? 'timed out' : 'recorded'} |`);
}

await step('OS and shell', windows
  ? '[Environment]::OSVersion.VersionString; $PSVersionTable | Format-List; Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber'
  : 'sw_vers; uname -a; printf "Login shell: %s\\n" "$SHELL"; /bin/bash --version; /bin/zsh --version');
if (windows) await step('Execution policy (D11)', 'Get-ExecutionPolicy -List | Format-Table');
await step('Node version (C4)', 'node --version');
await step('npm as typed (D11)', 'npm --version');
if (windows) await step('npm.cmd version (D11)', 'npm.cmd --version');
await step('npm global prefix (D2 D4)', windows ? 'npm.cmd prefix -g' : 'npm prefix -g');
await step('Prerequisites (D8 F11 F12)', windows
  ? 'Get-Command git,python,python3,cl,msbuild -ErrorAction SilentlyContinue | Select-Object Name,Source; exit 0'
  : 'command -v git; command -v python3; xcode-select -p');
await step('Package metadata (C4 D5 I7)', windows
  ? 'npm.cmd view agent-afk version engines dist-tags --json'
  : 'npm view agent-afk version engines dist-tags --json');
await step('Global install (D2 D5 D7 D8)', windows
  ? 'npm.cmd install -g agent-afk' : 'npm install -g agent-afk', 900000);
await step('Fresh shell PATH discovery (D3 D4)', windows
  ? 'Get-Command afk,afk.cmd -ErrorAction SilentlyContinue | Select-Object Name,Source; where.exe afk'
  : '/bin/zsh -lic \'command -v afk; print -r -- "$PATH"\'');
// Keychain is account-scoped, not HOME-scoped. Do not refresh a real token.
const keychain = !windows ? spawnSync('/usr/bin/security',
  ['find-generic-password', '-s', 'Claude Code-credentials'], { stdio: 'ignore', timeout: 5000 }) : undefined;
// security exits 44 for item-not-found. Any other result is unsafe or unknown.
const skipLaunch = keychain !== undefined && keychain.status !== 44;
if (skipLaunch) {
  appendFileSync(log, `\nSkipped afk launches: Claude Code Keychain entry present or check inconclusive (exit ${keychain.status}). Use a fresh macOS account.\n`);
  summary.push('| afk launches | skipped | 0s | Keychain present or inconclusive |');
} else {
  await step('afk version', 'afk --version');
  await step('afk doctor (J1 J2 J3 J6)', 'afk doctor');
  await step('Bare afk, no credential and closed stdin (E1 E13)', 'afk');
  if (windows) {
    await step('afk.cmd version', 'afk.cmd --version');
    await step('afk.cmd doctor (J1 J2 J3 J6)', 'afk.cmd doctor');
    await step('Bare afk.cmd, closed stdin (E1)', 'afk.cmd');
  }
  await step('Help without credentials (J10)', windows ? 'afk.cmd --help' : 'afk --help');
}
writeFileSync(`${log}.summary.md`, `## Onboarding observation\n\nHosted runners are not retail clean machines. Nonzero exits are findings, not job failures. Read the full log before drawing conclusions.\n\n| Step | Exit | Duration | Result |\n| --- | --- | --- | --- |\n${summary.join('\n')}\n\nNo credential, model message, service, update, or policy change was attempted.\n`);
console.log(`Observation complete: ${log}`);
if (infrastructureError) process.exitCode = 1;
