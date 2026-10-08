<#
.SYNOPSIS
  Rebuild out/vise.exe and out/vise-cli.exe, safe to run from inside a running Vise.

.DESCRIPTION
  The build compiles to *.next.exe and then renames: a running exe cannot be
  overwritten on Windows but can be renamed, so the running copy keeps working
  (it is kept as *.old). Nothing is ever stopped or killed. The new build takes
  effect when Vise is restarted.

.PARAMETER Restart
  Start the new out/vise.exe as a separate process afterwards. Close the old
  window yourself; the old process ends on its own when its window closes.
#>
param([switch]$Restart)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

bun run build:exe
if ($LASTEXITCODE -ne 0) { throw "build:exe failed ($LASTEXITCODE)" }

$exe = Join-Path (Get-Location) 'out\vise.exe'
& $exe --version

if ($Restart) {
  Start-Process -FilePath $exe
  Write-Host 'Started the new vise.exe. Close the old window when you are done with it.'
} else {
  Write-Host 'Restart Vise (or run scripts/rebuild.ps1 -Restart) to use the new build.'
}
