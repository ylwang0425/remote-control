[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $LauncherPath
)

$ErrorActionPreference = 'Stop'
$resolvedLauncher = [IO.Path]::GetFullPath($LauncherPath)
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($resolvedLauncher, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) {
  throw 'The FullControl launcher did not parse.'
}
$outcomeAst = $ast.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'New-BridgeStopOutcome'
}, $true)
if ($null -eq $outcomeAst) { throw 'The launcher stop-outcome helper was not found.' }
$reparseAst = $ast.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-NoReparsePoint'
}, $true)
if ($null -eq $reparseAst) { throw 'The launcher reparse-point check was not found.' }
$nativeChildrenAst = $ast.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Wait-ForCodexNativeChildren'
}, $true)
if ($null -eq $nativeChildrenAst) { throw 'The launcher native-child drain helper was not found.' }

# Execute only pure helpers extracted from the source. The launcher, native
# applications and real process-control code are never invoked here.
Invoke-Expression $outcomeAst.Extent.Text
Invoke-Expression $reparseAst.Extent.Text
Invoke-Expression $nativeChildrenAst.Extent.Text

$clean = New-BridgeStopOutcome $true 0 $false
$crashed = New-BridgeStopOutcome $true 17 $false
$forcedTimeout = New-BridgeStopOutcome $true 0 $true
$stillRunningAfterTimeout = New-BridgeStopOutcome $false $null $true

if (-not $clean.Stopped -or -not $clean.Graceful) { throw 'A zero-exit graceful stop was not accepted.' }
if (-not $crashed.Stopped -or $crashed.Graceful) { throw 'A nonzero bridge exit was incorrectly accepted as graceful.' }
if (-not $forcedTimeout.Stopped -or $forcedTimeout.Graceful) { throw 'A timeout followed by forced cleanup was incorrectly accepted as graceful.' }
if ($stillRunningAfterTimeout.Stopped -or $stillRunningAfterTimeout.Graceful) { throw 'A process that survived timeout cleanup was incorrectly accepted as stopped.' }

$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('codex-native-child-drain-' + [Guid]::NewGuid().ToString('N'))
$runId = 'aabbccdd-eeff-4a11-8a22-334455667788'
$instanceId = '11223344-5566-4778-899a-aabbccddeeff'
[void][IO.Directory]::CreateDirectory($fixtureRoot)
try {
  $emptyRegistry = Wait-ForCodexNativeChildren $fixtureRoot $runId 1
  if (-not $emptyRegistry) { throw 'An empty native-control registry was not accepted as drained.' }

  $descriptorPath = Join-Path $fixtureRoot "codex-native-$runId-$instanceId.json"
  $validDescriptor = [ordered]@{
    protocol = 1
    backend = 'codex-desktop-app-server-stdio'
    runId = $runId
    instanceId = $instanceId
    host = '127.0.0.1'
    port = 12345
    token = ('x' * 43)
    proxyPid = $PID
    nativePid = ($PID + 1)
  }
  [IO.File]::WriteAllText($descriptorPath, (ConvertTo-Json -InputObject $validDescriptor -Compress))
  $pendingChild = Wait-ForCodexNativeChildren $fixtureRoot $runId 0
  if ($pendingChild) { throw 'A live native-child descriptor was incorrectly accepted as drained.' }

  $wrongRunDescriptor = [ordered]@{
    protocol = 1
    backend = 'codex-desktop-app-server-stdio'
    runId = '00000000-0000-4000-8000-000000000000'
    instanceId = $instanceId
    host = '127.0.0.1'
    port = 12345
    token = ('x' * 43)
    proxyPid = $PID
    nativePid = ($PID + 1)
  }
  [IO.File]::WriteAllText($descriptorPath, (ConvertTo-Json -InputObject $wrongRunDescriptor -Compress))
  $rejectedWrongRunDescriptor = $false
  try { [void](Wait-ForCodexNativeChildren $fixtureRoot $runId 0) }
  catch { $rejectedWrongRunDescriptor = $true }
  if (-not $rejectedWrongRunDescriptor) { throw 'A descriptor for a different run was not rejected.' }

  [IO.File]::WriteAllText($descriptorPath, (ConvertTo-Json -InputObject $validDescriptor -Compress))

  [IO.File]::Delete($descriptorPath)
  $exitedChild = Wait-ForCodexNativeChildren $fixtureRoot $runId 1
  if (-not $exitedChild) { throw 'A removed native-child descriptor was not accepted as drained.' }

  [IO.File]::WriteAllText((Join-Path $fixtureRoot "codex-native-$runId-not-a-uuid.json"), '{}')
  $rejectedUnexpectedDescriptor = $false
  try { [void](Wait-ForCodexNativeChildren $fixtureRoot $runId 0) }
  catch { $rejectedUnexpectedDescriptor = $true }
  if (-not $rejectedUnexpectedDescriptor) { throw 'An unexpected descriptor name was not rejected.' }
} finally {
  if ([IO.Directory]::Exists($fixtureRoot)) { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force }
}

Write-Output 'PowerShell bridge stop and native-child drain fixtures: passed'
