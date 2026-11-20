# Compatible with Windows PowerShell 5.1. Never changes execution policy.
# Usage: & .\scripts\onboarding\observe-windows.ps1 -LogPath .\onboarding-windows.log
param(
    [string]$LogPath = 'onboarding-windows.log',
    [switch]$WithoutGit
)
$ErrorActionPreference = 'Stop'
$log = [IO.Path]::GetFullPath($LogPath)
$directory = [IO.Path]::GetDirectoryName($log)
[IO.Directory]::CreateDirectory($directory) | Out-Null
"Observation bootstrap`r`nCommand: node --version" | Set-Content -LiteralPath $log -Encoding UTF8
try {
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    & $node --version 2>&1 | Out-File -LiteralPath $log -Append -Encoding UTF8
    "Exit code: $LASTEXITCODE" | Out-File -LiteralPath $log -Append -Encoding UTF8
} catch {
    $_ | Out-File -LiteralPath $log -Append -Encoding UTF8
    '## Observation could not run. Node unavailable; see bootstrap log.' | Set-Content -LiteralPath "$log.summary.md"
    exit 1
}
$sandbox = Join-Path $directory ('.onboarding-home-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($sandbox) | Out-Null
$driver = Join-Path $PSScriptRoot 'observe.mjs'
$shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$info = New-Object System.Diagnostics.ProcessStartInfo
$info.FileName = $node
$info.Arguments = '"' + $driver + '" "' + $log + '" "' + $shell + '"'
$info.UseShellExecute = $false
# Include-list: provider keys, npm tokens and AFK settings must not leak in.
# Keep real APPDATA so npm uses the installer's normal global prefix. AFK_HOME
# and USERPROFILE isolate afk and Claude credential files from this account.
$info.EnvironmentVariables.Clear()
foreach ($name in @('PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT',
    'TEMP', 'TMP', 'PROCESSOR_ARCHITECTURE', 'ProgramFiles', 'ProgramFiles(x86)',
    'ProgramW6432', 'LOCALAPPDATA', 'APPDATA')) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ($null -ne $value) { $info.EnvironmentVariables[$name] = $value }
}
if ($WithoutGit) {
    $info.EnvironmentVariables['PATH'] = (($info.EnvironmentVariables['PATH'] -split ';') |
        Where-Object { $_ -notmatch '(?i)\\git(?:\\|$)' }) -join ';'
}
$info.EnvironmentVariables['HOME'] = $sandbox
$info.EnvironmentVariables['USERPROFILE'] = $sandbox
$info.EnvironmentVariables['AFK_HOME'] = Join-Path $sandbox '.afk'
$info.EnvironmentVariables['NPM_CONFIG_USERCONFIG'] = Join-Path $sandbox '.npmrc'
$info.EnvironmentVariables['NO_COLOR'] = '1'
$info.WorkingDirectory = $sandbox
$process = [Diagnostics.Process]::Start($info)
$process.WaitForExit()
if ($process.ExitCode -ne 0) { exit 1 }
if (!(Test-Path -LiteralPath $log) -or (Get-Item -LiteralPath $log).Length -eq 0) { exit 1 }
if (!(Test-Path -LiteralPath "$log.summary.md")) { exit 1 }
if ($WithoutGit) {
    "`r`nMode: Git directories removed from child PATH; not an uninstall." | Out-File -LiteralPath $log -Append -Encoding UTF8
}
exit 0
