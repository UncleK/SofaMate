$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$bundledCargo = Join-Path $projectRoot '.tools/tauri-rust/cargo'
if (Test-Path (Join-Path $bundledCargo 'bin/cargo.exe')) {
  $env:CARGO_HOME = $bundledCargo
  $env:RUSTUP_HOME = Join-Path $projectRoot '.tools/tauri-rust/rustup'
  $env:PATH = (Join-Path $env:CARGO_HOME 'bin') + ';' + $env:PATH
}
$env:CARGO_BUILD_JOBS = '2'
Push-Location $PSScriptRoot
try {
  & npm.cmd ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
  & npm.cmd run build -- -- --locked
  if ($LASTEXITCODE -ne 0) { throw 'Tauri build failed' }
} finally { Pop-Location }
