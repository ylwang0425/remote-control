param(
  [string]$NodePath,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$ClientArguments
)
$ErrorActionPreference = 'Stop'
if (-not $NodePath) {
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($nodeCommand) { $NodePath = $nodeCommand.Source }
}
if (-not $NodePath -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
  throw 'Use -NodePath with the absolute node.exe path in your AI-Remote-Windows folder, or install Node 22+.'
}
& $NodePath (Join-Path $PSScriptRoot 'remote-ai.cjs') @ClientArguments
exit $LASTEXITCODE
