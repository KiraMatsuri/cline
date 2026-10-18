#requires -Version 5.1
<#
  P0-2 gate: integration test for the student-log path resolution chain in
  scripts/analyze-student-log.ts (requirement 1: no more hard-coded log path).

  Usage: powershell -NoProfile -File scripts/verify/log-path-cli.test.ps1

  Assertions are driven by exit codes plus the machine-readable JSON export
  (--json --out), so this file stays pure ASCII and is encoding-safe on
  Windows PowerShell 5.1.
#>
# Windows PowerShell 5.1 turns native stderr into a terminating error under 'Stop',
# so keep 'Continue' here and let Assert-That be the only source of failure.
$ErrorActionPreference = 'Continue'
$env:NODE_NO_WARNINGS = '1'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repo

$cli = Join-Path $repo 'scripts\analyze-student-log.ts'
$tmp = Join-Path $repo '.tmp-test\cli-gate'
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

$script:failures = @()
$script:checks = 0

function Assert-That([string]$name, [bool]$cond, [string]$detail) {
    $script:checks++
    if ($cond) {
        Write-Host ("  PASS  {0}" -f $name) -ForegroundColor Green
    } else {
        Write-Host ("  FAIL  {0} :: {1}" -f $name, $detail) -ForegroundColor Red
        $script:failures += ("{0} :: {1}" -f $name, $detail)
    }
}

function Invoke-Cli([string[]]$argList, [string]$workDir) {
    Push-Location $workDir
    try {
        $out = & node $cli @argList 2>&1 | Out-String
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    return [pscustomobject]@{ Output = $out; Code = $code }
}

# Run the CLI with --json --out and return {exit, output, json}
$script:jsonSeq = 0
function Invoke-CliJson([string[]]$argList, [string]$workDir) {
    $script:jsonSeq++
    $outFile = Join-Path $tmp ("out\analysis-" + $script:jsonSeq + ".json")
    $r = Invoke-Cli ($argList + @('--json', '--out', $outFile)) $workDir
    $j = $null
    if (Test-Path $outFile) {
        try { $j = Get-Content $outFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $j = $null }
    }
    return [pscustomobject]@{ Output = $r.Output; Code = $r.Code; Json = $j; JsonPath = $outFile }
}

# ---------- fixtures ----------
$wsA = Join-Path $tmp 'ws-a'
New-Item -ItemType Directory -Force -Path (Join-Path $wsA '.cline-logs') | Out-Null
$logA = Join-Path $wsA '.cline-logs\student_interactions.log'
@(
    '{"ts":"2026-10-01T01:00:00.000Z","taskId":"t1","role":"user","event":"task_start"}'
    '{"ts":"2026-10-01T01:01:00.000Z","taskId":"t1","role":"assistant","event":"code_generation","text":"x"}'
    '{ this line is broken json'
    '{"ts":"2026-10-01T01:02:00.000Z","taskId":"t1","role":"user","event":"code_edit","language":"ts"}'
) | Set-Content -Path $logA -Encoding ASCII

$wsEmpty = Join-Path $tmp 'ws-empty'
New-Item -ItemType Directory -Force -Path $wsEmpty | Out-Null

$wsZero = Join-Path $tmp 'ws-zero'
New-Item -ItemType Directory -Force -Path (Join-Path $wsZero '.cline-logs') | Out-Null
$logZero = Join-Path $wsZero '.cline-logs\student_interactions.log'
New-Item -ItemType File -Force -Path $logZero | Out-Null

$wsDeep = Join-Path $wsA 'src\nested\deeper'
New-Item -ItemType Directory -Force -Path $wsDeep | Out-Null

Write-Host ""
Write-Host "== 1. no argument: hit default log in cwd ==" -ForegroundColor Cyan
$r = Invoke-CliJson @() $wsA
Assert-That 'exit 0' ($r.Code -eq 0) ("exit=" + $r.Code + " out=" + $r.Output)
Assert-That 'logSource=cwd' ($r.Json.logSource -eq 'cwd') ([string]$r.Json.logSource)
Assert-That 'logPath is the workspace log' ($r.Json.logPath -eq $logA) ([string]$r.Json.logPath)
Assert-That 'eventCount=3' ($r.Json.eventCount -eq 3) ([string]$r.Json.eventCount)
Assert-That 'parseErrors=1 (broken line skipped)' ($r.Json.parseErrors -eq 1) ([string]$r.Json.parseErrors)

Write-Host "== 2. run from sub-directory: walk up to workspace root ==" -ForegroundColor Cyan
$r = Invoke-CliJson @() $wsDeep
Assert-That 'exit 0' ($r.Code -eq 0) ("exit=" + $r.Code + " out=" + $r.Output)
Assert-That 'logSource=cwd-ancestor' ($r.Json.logSource -eq 'cwd-ancestor') ([string]$r.Json.logSource)
Assert-That 'same log file' ($r.Json.logPath -eq $logA) ([string]$r.Json.logPath)

Write-Host "== 3. explicit log path argument wins ==" -ForegroundColor Cyan
$r = Invoke-CliJson @($logA) $wsEmpty
Assert-That 'exit 0' ($r.Code -eq 0) ("exit=" + $r.Code + " out=" + $r.Output)
Assert-That 'logSource=arg' ($r.Json.logSource -eq 'arg') ([string]$r.Json.logSource)
Assert-That 'eventCount=3' ($r.Json.eventCount -eq 3) ([string]$r.Json.eventCount)

Write-Host "== 4. --workspace <dir> ==" -ForegroundColor Cyan
$r = Invoke-CliJson @('--workspace', $wsA) $wsEmpty
Assert-That 'exit 0' ($r.Code -eq 0) ("exit=" + $r.Code + " out=" + $r.Output)
Assert-That 'logSource=workspace-arg' ($r.Json.logSource -eq 'workspace-arg') ([string]$r.Json.logSource)

Write-Host "== 5. BN-01: workspace dir has no log (must fail, must not fall back) ==" -ForegroundColor Cyan
$r = Invoke-Cli @('--workspace', $wsEmpty) $wsEmpty
Assert-That 'exit 1' ($r.Code -eq 1) ("exit=" + $r.Code + " out=" + $r.Output)
Assert-That 'names the missing candidate path' ($r.Output -match [regex]::Escape($logA.Replace('ws-a', 'ws-empty'))) $r.Output

Write-Host "== 6. explicit path does not exist ==" -ForegroundColor Cyan
$missing = Join-Path $tmp 'nope\student_interactions.log'
$r = Invoke-Cli @($missing) $wsA
Assert-That 'exit 1' ($r.Code -eq 1) ("exit=" + $r.Code + " out=" + $r.Output)
Assert-That 'no silent fallback to cwd log' (-not ($r.Json)) ([string]$r.Json.logPath)

Write-Host "== 7. zero-byte log + --strict ==" -ForegroundColor Cyan
$r = Invoke-Cli @('--strict', '--workspace', $wsZero) $tmp
Assert-That 'exit 2' ($r.Code -eq 2) ("exit=" + $r.Code + " out=" + $r.Output)
Assert-That 'reports the zero-byte path' ($r.Output -match [regex]::Escape($logZero)) $r.Output

Write-Host "== 8. argument errors ==" -ForegroundColor Cyan
$r = Invoke-Cli @('--bogus') $wsA
Assert-That 'unknown option -> exit 3' ($r.Code -eq 3) ("exit=" + $r.Code + " out=" + $r.Output)
$r = Invoke-Cli @($logA, $logA) $wsA
Assert-That 'two positionals -> exit 3' ($r.Code -eq 3) ("exit=" + $r.Code + " out=" + $r.Output)
$r = Invoke-Cli @('--workspace', $wsA, $logA) $wsA
Assert-That '--workspace + log path -> exit 3' ($r.Code -eq 3) ("exit=" + $r.Code + " out=" + $r.Output)
$r = Invoke-Cli @('--help') $wsA
Assert-That '--help -> exit 0' ($r.Code -eq 0) ("exit=" + $r.Code + " out=" + $r.Output)
Assert-That '--help prints the script name' ($r.Output -match 'analyze-student-log\.ts') $r.Output

Write-Host "== 9. JSON export payload ==" -ForegroundColor Cyan
$r = Invoke-CliJson @($logA) $wsA
Assert-That 'has logPathCandidates array' ($r.Json.logPathCandidates.Count -ge 1) ([string]$r.Json.logPathCandidates.Count)
Assert-That 'has aiDependencyScore metric' ($null -ne $r.Json.studentProfile.aiDependencyScore) ([string]$r.Json.studentProfile.aiDependencyScore)
Assert-That 'has generatedAt timestamp' ($null -ne $r.Json.generatedAt) ([string]$r.Json.generatedAt)
Assert-That 'has analysis payload' ($null -ne $r.Json.analysis) 'analysis missing'

Write-Host "== 10. source guards (no hard-coded absolute path) ==" -ForegroundColor Cyan
# Strip comment lines first: the docs intentionally describe the old hard-coded
# path, and that mention is fine - only executable code must be path-free.
function Get-CodeLines([string]$path) {
    $lines = Get-Content $path -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
    if ($null -eq $lines) { return '' }
    return (($lines -split "`r?`n") | Where-Object { $_ -notmatch '^\s*(\*|//|/\*)' }) -join "`n"
}
$cliCode = Get-CodeLines (Join-Path $repo 'scripts\analyze-student-log.ts')
Assert-That 'CLI code no longer hard-codes cline-test' (-not ($cliCode -match 'cline-test')) 'found cline-test in code'
$resolverCode = Get-CodeLines (Join-Path $repo 'src\core\teaching\logPathResolver.ts')
Assert-That 'resolver code has no drive-letter literal' (-not ($resolverCode -match '[A-Za-z]:[\\/]')) 'found drive literal in code'

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ""
if ($script:failures.Count -eq 0) {
    Write-Host ("P0-2 CLI gate PASSED: " + $script:checks + "/" + $script:checks + " assertions") -ForegroundColor Green
    exit 0
} else {
    Write-Host ("P0-2 CLI gate FAILED: " + $script:failures.Count + "/" + $script:checks + " assertions") -ForegroundColor Red
    $script:failures | ForEach-Object { Write-Host ("   - " + $_) -ForegroundColor Red }
    exit 1
}
