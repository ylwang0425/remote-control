[CmdletBinding()]
param(
  [string] $CodexDesktopPath,
  [string] $CodexCliPath,
  [ValidateRange(5, 120)]
  [int] $StartupTimeoutSeconds = 60
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ScriptRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$PackageRoot = if ([IO.File]::Exists((Join-Path $ScriptRoot 'node.exe'))) {
  $ScriptRoot
} else {
  [IO.Path]::GetFullPath((Join-Path $ScriptRoot '..'))
}
$RegistryParent = $null
$RegistryDir = $null
$BridgeProcess = $null
$DesktopProcess = $null
$stopToken = $null
$nativeProxyExitCheckCompleted = $false
$nativeProxyExitVerified = $false
$EnvironmentNames = @(
  'PATH', 'CODEX_CLI_PATH', 'AI_REMOTE_CODEX_NATIVE_CONTROL',
  'CODEX_NATIVE_CONTROL_DIR', 'CODEX_NATIVE_RUN_ID',
  'CODEX_NATIVE_NODE_PATH', 'CODEX_NATIVE_REAL_CLI_PATH', 'AI_REMOTE_CODEX_READY_TIMEOUT_MS',
  'AI_REMOTE_BRIDGE_STOP_TOKEN'
)
$OriginalEnvironment = @{}
foreach ($name in $EnvironmentNames) {
  $OriginalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

function Resolve-RequiredFile([string] $Path, [string] $Description) {
  if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathRooted($Path)) {
    throw "$Description must be an absolute file path."
  }
  $resolved = [IO.Path]::GetFullPath($Path)
  if (-not [IO.File]::Exists($resolved)) { throw "$Description was not found." }
  return $resolved
}

function Get-CodexPackagePathShape([string] $ExecutablePath) {
  if ([string]::IsNullOrWhiteSpace($ExecutablePath) -or -not [IO.Path]::IsPathRooted($ExecutablePath)) { return $null }
  $resolved = [IO.Path]::GetFullPath($ExecutablePath)
  if ([IO.Path]::GetFileName($resolved) -ine 'ChatGPT.exe' -or -not [IO.File]::Exists($resolved)) { return $null }
  $appDirectory = Split-Path -Parent $resolved
  if ([IO.Path]::GetFileName($appDirectory) -ine 'app') { return $null }
  $packageRoot = [IO.Path]::GetFullPath((Split-Path -Parent $appDirectory))
  $packageName = [IO.Path]::GetFileName($packageRoot)
  if ($packageName -notmatch '^OpenAI\.Codex_[0-9]+(?:\.[0-9]+){1,3}_x64__2p2nqsd0c76g0$') { return $null }
  $windowsApps = [IO.Path]::GetFullPath((Join-Path $env:ProgramFiles 'WindowsApps'))
  if ([IO.Path]::GetDirectoryName($packageRoot) -ine $windowsApps) { return $null }
  return $packageRoot
}

function Get-CodexPackageRoot([string] $ExecutablePath) {
  $packageRoot = Get-CodexPackagePathShape $ExecutablePath
  if ($null -eq $packageRoot) { return $null }

  $manifestPath = Join-Path $packageRoot 'AppxManifest.xml'
  if (-not [IO.File]::Exists($manifestPath)) { return $null }
  $settings = [Xml.XmlReaderSettings]::new()
  $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
  $settings.XmlResolver = $null
  $reader = $null
  try {
    $reader = [Xml.XmlReader]::Create($manifestPath, $settings)
    $manifest = [Xml.XmlDocument]::new()
    $manifest.XmlResolver = $null
    $manifest.Load($reader)
    $identity = $manifest.SelectSingleNode("//*[local-name()='Identity']")
    if ($null -eq $identity -or $identity.GetAttribute('Name') -cne 'OpenAI.Codex') { return $null }
    $application = @($manifest.SelectNodes("//*[local-name()='Application']") | Where-Object {
      $_.GetAttribute('Id') -ceq 'App' -and $_.GetAttribute('EntryPoint') -ceq 'Windows.FullTrustApplication' -and
      ($_.GetAttribute('Executable').Replace('/', '\') -ieq 'app\ChatGPT.exe')
    })
    if ($application.Count -ne 1) { return $null }
    return $packageRoot
  } catch {
    return $null
  } finally {
    if ($reader) { $reader.Dispose() }
  }
}

function Resolve-CodexDesktop([string] $ExplicitPath) {
  $candidates = [Collections.Generic.List[string]]::new()
  if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
    $candidates.Add($ExplicitPath)
  } elseif (-not [string]::IsNullOrWhiteSpace($env:CODEX_DESKTOP_PATH)) {
    $candidates.Add($env:CODEX_DESKTOP_PATH)
  } else {
    $windowsApps = Join-Path $env:ProgramFiles 'WindowsApps'
    if (-not [IO.Directory]::Exists($windowsApps)) { throw 'The packaged Codex install directory was not found.' }
    try {
      foreach ($package in Get-ChildItem -LiteralPath $windowsApps -Directory -Filter 'OpenAI.Codex_*_x64__2p2nqsd0c76g0' -ErrorAction Stop) {
        if ($package.Name -match '^OpenAI\.Codex_[0-9]+(?:\.[0-9]+){1,3}_x64__2p2nqsd0c76g0$') {
          $candidates.Add((Join-Path $package.FullName 'app\ChatGPT.exe'))
        }
      }
    } catch {
      throw 'Could not discover the packaged OpenAI.Codex install. Pass -CodexDesktopPath to its app\ChatGPT.exe.'
    }
  }

  $found = @($candidates | ForEach-Object {
    if ($null -ne (Get-CodexPackageRoot $_)) { [IO.Path]::GetFullPath($_) }
  } | Select-Object -Unique)
  if ($found.Count -ne 1) {
    if ($found.Count -gt 1) { throw 'Multiple packaged OpenAI.Codex installs were found. Pass -CodexDesktopPath to select one.' }
    throw 'A verified OpenAI.Codex package was not found. Pass -CodexDesktopPath to its app\ChatGPT.exe.'
  }
  return $found[0]
}

function Assert-CodexDesktopNotRunning() {
  $processes = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='ChatGPT.exe'" -ErrorAction Stop)
  foreach ($process in $processes) {
    if ([string]::IsNullOrWhiteSpace([string]$process.ExecutablePath)) {
      throw 'A ChatGPT.exe process is running but its package identity cannot be verified; close it normally before opt-in.'
    }
    if ($null -ne (Get-CodexPackagePathShape ([string]$process.ExecutablePath))) {
      throw 'Codex Desktop is already running. Close it normally before using this explicit opt-in launcher.'
    }
  }
  $unpackaged = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='Codex.exe'" -ErrorAction Stop)
  if ($unpackaged.Count -gt 0) {
    throw 'A Codex.exe process is already running. Close the existing Codex app normally before using this launcher.'
  }
}

function Resolve-CodexCli([string] $ExplicitPath, [string] $LocalAppData) {
  $binRoot = [IO.Path]::GetFullPath((Join-Path $LocalAppData 'OpenAI\Codex\bin'))
  if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
    $selected = Resolve-RequiredFile $ExplicitPath 'Codex CLI'
    if ([IO.Path]::GetFileName($selected) -ine 'codex.exe') { throw 'Codex CLI must be named codex.exe.' }
  } else {
    if (-not [IO.Directory]::Exists($binRoot)) {
      throw 'The versioned Codex CLI was not found. Pass -CodexCliPath to an installed OpenAI Codex codex.exe.'
    }
    $found = @(Get-ChildItem -LiteralPath $binRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      $candidate = Join-Path $_.FullName 'codex.exe'
      if ([IO.File]::Exists($candidate)) { [IO.Path]::GetFullPath($candidate) }
    } | Select-Object -Unique)
    if ($found.Count -eq 1) { $selected = $found[0] }
    elseif ($found.Count -gt 1) { throw 'Multiple versioned Codex CLI installs were found. Pass -CodexCliPath to select the intended version.' }
    else { throw 'The versioned Codex CLI was not found. Pass -CodexCliPath to an installed OpenAI Codex codex.exe.' }
  }

  if ([IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName($selected)) -ine $binRoot) {
    throw 'Codex CLI must come from this Windows account LocalAppData OpenAI Codex installation.'
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $selected
  $signer = if ($signature.SignerCertificate) { $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) } else { '' }
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or $signer -cne 'OpenAI OpCo, LLC') {
    throw 'Codex CLI must have a valid Authenticode signature from OpenAI OpCo, LLC.'
  }
  return $selected
}

function Test-NoReparsePoint([string] $Path) {
  $resolved = [IO.Path]::GetFullPath($Path)
  $root = [IO.Path]::GetPathRoot($resolved)
  $current = $root
  $segments = $resolved.Substring($root.Length).Split([IO.Path]::DirectorySeparatorChar, [StringSplitOptions]::RemoveEmptyEntries)
  foreach ($segment in $segments) {
    $current = Join-Path $current $segment
    if (-not (Test-Path -LiteralPath $current)) { continue }
    $attributes = [IO.File]::GetAttributes($current)
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
  }
  return $true
}

function New-PrivateDirectoryAcl() {
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  $principals = @(
    [Security.Principal.WindowsIdentity]::GetCurrent().User,
    [Security.Principal.SecurityIdentifier]::new('S-1-5-18'),
    [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  )
  foreach ($sid in $principals) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $sid, [Security.AccessControl.FileSystemRights]::FullControl,
      ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    )
    [void]$acl.AddAccessRule($rule)
  }
  return @{ Acl = $acl; Principals = $principals }
}

function Set-PrivateDirectoryAcl([string] $Path) {
  $private = New-PrivateDirectoryAcl
  $acl = $private.Acl
  $principals = $private.Principals
  Set-Acl -LiteralPath $Path -AclObject $acl
  $readback = Get-Acl -LiteralPath $Path
  if (-not $readback.AreAccessRulesProtected) { throw 'The native-control registry ACL is inheriting permissions.' }
  $allowed = @($principals | ForEach-Object { $_.Value })
  $rules = $readback.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
  foreach ($rule in $rules) {
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
        $rule.InheritanceFlags -ne ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit) -or
        $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None -or
        $rule.IdentityReference.Value -notin $allowed) {
      throw 'The native-control registry ACL contains an unexpected permission.'
    }
  }
  if (@($rules).Count -ne 3) {
    throw 'The native-control registry ACL does not contain exactly the user, SYSTEM and Administrators.'
  }
}

function New-PrivateStopToken() {
  $bytes = New-Object byte[] 32
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  } finally {
    [Array]::Clear($bytes, 0, $bytes.Length)
    $generator.Dispose()
  }
}

function Request-OwnBridgeStop([Diagnostics.Process] $Process, [string] $Directory, [string] $RunId, [string] $Token) {
  if ($null -eq $Process) { return $true }
  $Process.Refresh()
  if ($Process.HasExited) { return $true }
  if ([string]::IsNullOrWhiteSpace($RunId) -or $RunId -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' -or
      [string]::IsNullOrWhiteSpace($Token) -or $Token -notmatch '^[A-Za-z0-9_-]{43}$') {
    throw 'The private per-run bridge stop request is not configured.'
  }
  $directoryFull = [IO.Path]::GetFullPath($Directory)
  if ([IO.Path]::GetFileName($directoryFull) -ine $RunId -or -not (Test-NoReparsePoint $directoryFull)) {
    throw 'The private per-run bridge stop directory is invalid.'
  }
  $requestPath = Join-Path $directoryFull "bridge-stop-$RunId.request"
  $temporaryPath = Join-Path $directoryFull ('.bridge-stop-' + [Guid]::NewGuid().ToString('N') + '.tmp')
  $encoding = [Text.UTF8Encoding]::new($false)
  try {
    [IO.File]::WriteAllText($temporaryPath, "$RunId`n$Token`n", $encoding)
    [IO.File]::Move($temporaryPath, $requestPath)
  } finally {
    if ([IO.File]::Exists($temporaryPath)) { [IO.File]::Delete($temporaryPath) }
  }
  return $true
}

function New-BridgeStopOutcome([bool] $Stopped, [object] $ExitCode, [bool] $Forced) {
  $graceful = $Stopped -and -not $Forced -and $null -ne $ExitCode -and [int]$ExitCode -eq 0
  return @{ Stopped = $Stopped; Graceful = [bool]$graceful }
}

function Stop-OwnBridge([Diagnostics.Process] $Process, [string] $Directory, [string] $RunId, [string] $Token) {
  if ($null -eq $Process) { return New-BridgeStopOutcome $true 0 $false }
  $Process.Refresh()
  if ($Process.HasExited) { return New-BridgeStopOutcome $true $Process.ExitCode $false }
  try { [void](Request-OwnBridgeStop $Process $Directory $RunId $Token) }
  catch { Write-Warning 'The private stop request could not be written; only this launcher''s bridge process will be stopped after the grace period.' }

  $Process.Refresh()
  if (-not $Process.HasExited -and -not $Process.WaitForExit(120000)) {
    Write-Warning 'The bridge did not finish its graceful shutdown within 120 seconds. A forced stop makes any in-flight native operation outcome unknown; stopping only the bridge process launched by this script.'
    $Process.Refresh()
    if (-not $Process.HasExited) {
      Stop-Process -InputObject $Process -ErrorAction Stop
      [void]$Process.WaitForExit(5000)
    }
    $Process.Refresh()
    $exitCode = if ($Process.HasExited) { $Process.ExitCode } else { $null }
    return New-BridgeStopOutcome $Process.HasExited $exitCode $true
  }
  $Process.Refresh()
  $stopped = $Process.HasExited
  $exitCode = if ($stopped) { $Process.ExitCode } else { $null }
  return New-BridgeStopOutcome $stopped $exitCode $false
}

function Resolve-BridgeUiPort() {
  $candidate = $null
  if ($null -ne $env:AI_REMOTE_UI_PORT) {
    # Match loadConfig's environment-over-file precedence, including an empty
    # environment value (which converts to zero and therefore falls back).
    $candidate = $env:AI_REMOTE_UI_PORT
  } else {
    $configPath = if ($null -ne $env:AI_REMOTE_CONFIG -and $env:AI_REMOTE_CONFIG.Length -gt 0) {
      $env:AI_REMOTE_CONFIG
    } else {
      Join-Path $env:USERPROFILE '.dsh\ai-remote-desktop.json'
    }
    if (-not [IO.Path]::IsPathRooted($configPath)) {
      # The bridge child runs with PackageRoot as its working directory, so a
      # relative AI_REMOTE_CONFIG must be resolved against the same directory.
      $configPath = Join-Path $PackageRoot $configPath
    }
    if ([IO.File]::Exists($configPath)) {
      try {
        $privateConfig = Get-Content -LiteralPath $configPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        $candidate = $privateConfig.uiPort
      } catch {
        # loadConfig treats an unreadable or malformed file as empty config.
        $candidate = $null
      }
    }
  }

  if ($null -eq $candidate) { return 18989 }
  if ($candidate -is [bool]) {
    $number = if ($candidate) { 1.0 } else { 0.0 }
  } elseif ($candidate -is [string]) {
    $text = $candidate.Trim()
    if ($text.Length -eq 0) {
      $number = 0.0
    } elseif ($text -match '^0[xX][0-9a-fA-F]+$') {
      try { $number = [Convert]::ToInt64($text.Substring(2), 16) } catch { $number = [double]::NaN }
    } elseif ($text -match '^0[bB][01]+$') {
      try { $number = [Convert]::ToInt64($text.Substring(2), 2) } catch { $number = [double]::NaN }
    } elseif ($text -match '^0[oO][0-7]+$') {
      try { $number = [Convert]::ToInt64($text.Substring(2), 8) } catch { $number = [double]::NaN }
    } else {
      $parsed = [double]0
      if ([double]::TryParse($text, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$parsed)) {
        $number = $parsed
      } else {
        $number = [double]::NaN
      }
    }
  } elseif ($candidate -is [ValueType]) {
    try { $number = [double]$candidate } catch { $number = [double]::NaN }
  } else {
    # Refuse exotic JSON values rather than guessing a different listener than
    # the bridge's JavaScript Number conversion would select.
    throw 'The configured bridge UI port is not a supported scalar. Set uiPort or AI_REMOTE_UI_PORT to a numeric value before using this launcher.'
  }

  if ([double]::IsNaN($number) -or [double]::IsInfinity($number) -or
      [Math]::Truncate($number) -ne $number -or $number -lt 1 -or $number -gt 65535) {
    return 18989
  }
  return [int]$number
}

function Test-LocalBridgePort([int] $Port, [int] $TimeoutMilliseconds = 300) {
  $client = [Net.Sockets.TcpClient]::new()
  try {
    $pending = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $pending.AsyncWaitHandle.WaitOne($TimeoutMilliseconds)) { return $false }
    $client.EndConnect($pending)
    return $true
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Wait-ForLocalBridge([Diagnostics.Process] $Process, [int] $Seconds, [int] $Port) {
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  do {
    $Process.Refresh()
    if ($Process.HasExited) { throw 'The bridge exited before its local status service became ready.' }
    if (Test-LocalBridgePort -Port $Port) { return }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'The bridge local status service did not start within the allowed time.'
}

function Wait-ForCodexNativeChildren([string] $Directory, [string] $RunId, [int] $Seconds) {
  if ([string]::IsNullOrWhiteSpace($RunId) -or $RunId -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' -or
      -not [IO.Directory]::Exists($Directory) -or -not (Test-NoReparsePoint $Directory)) {
    throw 'The private Codex native-control registry cannot be checked safely; it will be retained.'
  }
  $escapedRunId = [regex]::Escape($RunId)
  $descriptorFilter = "codex-native-$RunId-*.json"
  $descriptorPattern = "^codex-native-$escapedRunId-(?<instanceId>[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})\.json$"
  $expectedFields = @('backend', 'host', 'instanceId', 'nativePid', 'port', 'protocol', 'proxyPid', 'runId', 'token')
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  do {
    $descriptors = @(Get-ChildItem -LiteralPath $Directory -File -Force -Filter $descriptorFilter -ErrorAction Stop)
    foreach ($descriptor in $descriptors) {
      if ($descriptor.Name -notmatch $descriptorPattern -or -not (Test-NoReparsePoint $descriptor.FullName)) {
        throw 'The private Codex native-control registry contains an unexpected descriptor; it will be retained.'
      }
      $instanceId = $Matches['instanceId']
      if (-not [IO.File]::Exists($descriptor.FullName)) { continue }
      if ($descriptor.Length -le 0 -or $descriptor.Length -gt 4096) {
        throw 'A private Codex native-control descriptor has an unexpected size; the registry will be retained.'
      }
      $descriptorInfo = $null
      $descriptorText = $null
      try {
        $descriptorText = [IO.File]::ReadAllText($descriptor.FullName)
        $descriptorInfo = ConvertFrom-Json -InputObject $descriptorText -ErrorAction Stop
      } catch {
        if (-not [IO.File]::Exists($descriptor.FullName)) { continue }
        throw 'A private Codex native-control descriptor could not be read safely; the registry will be retained.'
      }
      if ($null -eq $descriptorInfo) {
        $descriptorText = $null
        throw 'A private Codex native-control descriptor was empty; the registry will be retained.'
      }
      $actualFields = @($descriptorInfo.PSObject.Properties.Name | Sort-Object)
      $expectedFieldKey = @($expectedFields | Sort-Object) -join '|'
      if (($actualFields -join '|') -cne $expectedFieldKey) {
        $descriptorInfo = $null
        $descriptorText = $null
        throw 'A private Codex native-control descriptor has an unexpected schema; the registry will be retained.'
      }
      $protocol = 0
      $port = 0
      $proxyPid = 0
      $nativePid = 0
      $validDescriptor =
        [int]::TryParse([string]$descriptorInfo.protocol, [ref]$protocol) -and $protocol -eq 1 -and
        [string]$descriptorInfo.backend -ceq 'codex-desktop-app-server-stdio' -and
        [string]$descriptorInfo.runId -ceq $RunId -and
        [string]$descriptorInfo.instanceId -ieq $instanceId -and
        [string]$descriptorInfo.host -ceq '127.0.0.1' -and
        [int]::TryParse([string]$descriptorInfo.port, [ref]$port) -and $port -ge 1 -and $port -le 65535 -and
        [int]::TryParse([string]$descriptorInfo.proxyPid, [ref]$proxyPid) -and $proxyPid -gt 0 -and
        [int]::TryParse([string]$descriptorInfo.nativePid, [ref]$nativePid) -and $nativePid -gt 0 -and $proxyPid -ne $nativePid -and
        $descriptorInfo.token -is [string] -and [Text.Encoding]::UTF8.GetByteCount($descriptorInfo.token) -ge 32
      $descriptorInfo.token = $null
      $descriptorInfo = $null
      $descriptorText = $null
      if (-not $validDescriptor) {
        throw 'A private Codex native-control descriptor did not match its run identity or schema; the registry will be retained.'
      }
    }
    if ($descriptors.Count -eq 0) { return $true }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  return $false
}

function Wait-ForCodexNativeReady([string] $NodePath, [string] $HelperPath, [int] $Seconds) {
  $previousTimeout = [Environment]::GetEnvironmentVariable('AI_REMOTE_CODEX_READY_TIMEOUT_MS', 'Process')
  $env:AI_REMOTE_CODEX_READY_TIMEOUT_MS = [string]($Seconds * 1000)
  try {
    $process = Start-Process -FilePath $NodePath -ArgumentList ('"{0}"' -f $HelperPath) -PassThru -Wait -WindowStyle Hidden
    if ($process.ExitCode -ne 0) {
      throw 'Codex Desktop did not expose both its app-tools channel and a matching native-control registry before the bounded startup timeout.'
    }
  } finally {
    [Environment]::SetEnvironmentVariable('AI_REMOTE_CODEX_READY_TIMEOUT_MS', $previousTimeout, 'Process')
  }
}

try {
  if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA) -or -not [IO.Directory]::Exists($env:LOCALAPPDATA)) {
    throw 'Windows LocalAppData is unavailable for the private native-control registry.'
  }
  $nodePath = Resolve-RequiredFile (Join-Path $PackageRoot 'node.exe') 'Packaged Node runtime'
  $proxyExe = Resolve-RequiredFile (Join-Path $PackageRoot 'codex-native\codex-native-proxy.exe') 'Codex native proxy executable'
  $proxyScript = Resolve-RequiredFile (Join-Path $PackageRoot 'src\codex-native-proxy.js') 'Codex native proxy script'
  $readinessScript = Resolve-RequiredFile (Join-Path $PackageRoot 'scripts\codex-fullcontrol-ready.js') 'Codex readiness probe'
  $bridgeScript = Resolve-RequiredFile (Join-Path $PackageRoot 'src\index.js') 'Desktop bridge entry point'
  $desktopPath = Resolve-CodexDesktop $CodexDesktopPath
  $cliPath = Resolve-CodexCli $CodexCliPath $env:LOCALAPPDATA
  $BridgePort = Resolve-BridgeUiPort

  if ([string]::Equals($desktopPath, $cliPath, [StringComparison]::OrdinalIgnoreCase) -or
      [string]::Equals($proxyExe, $cliPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The selected Codex CLI path cannot be the Desktop host or the proxy shim.'
  }
  Assert-CodexDesktopNotRunning
  if (Test-LocalBridgePort -Port $BridgePort) { throw "A desktop bridge is already listening on port $BridgePort. Stop it normally before starting this isolated full-control run." }

  $RegistryParent = Join-Path $env:LOCALAPPDATA 'AI-Remote\codex-native-runs'
  [void][IO.Directory]::CreateDirectory($RegistryParent)
  if (-not (Test-NoReparsePoint $RegistryParent)) { throw 'The native-control registry parent contains a reparse point.' }
  Set-PrivateDirectoryAcl $RegistryParent

  $runId = [Guid]::NewGuid().ToString('D').ToLowerInvariant()
  $RegistryDir = Join-Path $RegistryParent $runId
  [void][IO.Directory]::CreateDirectory($RegistryDir)
  if (-not (Test-NoReparsePoint $RegistryDir)) { throw 'The native-control registry contains a reparse point.' }
  Set-PrivateDirectoryAcl $RegistryDir

  $proxyDir = Split-Path -Parent $proxyExe
  $proxyDirKey = $proxyDir.TrimEnd([char]92)
  $pathEntries = @()
  foreach ($pathEntry in ($env:PATH -split ';')) {
    if (-not [string]::IsNullOrWhiteSpace($pathEntry) -and $pathEntry.TrimEnd([char]92) -ine $proxyDirKey) {
      $pathEntries += $pathEntry
    }
  }
  $env:PATH = (@($proxyDir) + $pathEntries) -join ';'
  $env:CODEX_CLI_PATH = 'codex-native-proxy'
  $env:AI_REMOTE_CODEX_NATIVE_CONTROL = '1'
  $env:CODEX_NATIVE_CONTROL_DIR = $RegistryDir
  $env:CODEX_NATIVE_RUN_ID = $runId
  $env:CODEX_NATIVE_NODE_PATH = $nodePath
  $env:CODEX_NATIVE_REAL_CLI_PATH = $cliPath
  $stopToken = New-PrivateStopToken

  Write-Host 'Starting the explicitly selected Codex Desktop preview. Source and app-server behavior were inspected against build 26.1007; this launcher has not completed native activation or a real Desktop end-to-end run.' -ForegroundColor Yellow
  Write-Host 'Native activation and a real Desktop end-to-end run are pending. Other Codex builds are unverified.' -ForegroundColor Yellow
  Write-Host 'The Codex app and bridge will inherit this run-specific, user-private registry. No credentials are shown.'
  $DesktopProcess = Start-Process -FilePath $desktopPath -WorkingDirectory (Split-Path -Parent $desktopPath) -PassThru
  Start-Sleep -Milliseconds 800
  $DesktopProcess.Refresh()
  if ($DesktopProcess.HasExited) { throw 'Codex Desktop exited during startup; the bridge will be stopped and no automatic retry will occur.' }
  Write-Host 'Waiting for the matching native child and the Codex app-tools channel before starting the bridge.'
  Wait-ForCodexNativeReady $nodePath $readinessScript $StartupTimeoutSeconds

  # Set this credential only for the bridge child, after Codex Desktop has
  # already started. The per-run file request cannot be confused with a
  # baseline bridge or another FullControl run.
  $env:AI_REMOTE_BRIDGE_STOP_TOKEN = $stopToken
  $BridgeProcess = Start-Process -FilePath $nodePath -ArgumentList ('"{0}"' -f $bridgeScript) -WorkingDirectory $PackageRoot -PassThru -WindowStyle Hidden
  Wait-ForLocalBridge $BridgeProcess $StartupTimeoutSeconds $BridgePort

  Write-Host "Codex Desktop launched. Closing Codex Desktop normally asks this run's bridge to stop and clean up."
  $bridgeExitAnnounced = $false
  $desktopExitAnnounced = $false
  while ($true) {
    $BridgeProcess.Refresh()
    $DesktopProcess.Refresh()
    if ($BridgeProcess.HasExited -and $DesktopProcess.HasExited) {
      if ($BridgeProcess.ExitCode -ne 0) { throw "The bridge exited with code $($BridgeProcess.ExitCode); this run did not shut down cleanly." }
      break
    }
    if ($BridgeProcess.HasExited -and -not $DesktopProcess.HasExited -and -not $bridgeExitAnnounced) {
      Write-Host 'The bridge has stopped. Close Codex Desktop normally before the private run registry is removed.' -ForegroundColor Yellow
      $bridgeExitAnnounced = $true
    }
    if ($DesktopProcess.HasExited -and -not $BridgeProcess.HasExited -and -not $desktopExitAnnounced) {
      Write-Host "Codex Desktop exited. Sending this run's private one-shot bridge stop request." -ForegroundColor Yellow
      $bridgeStop = Stop-OwnBridge $BridgeProcess $RegistryDir $runId $stopToken
      $desktopExitAnnounced = $true
      if (-not $bridgeStop.Stopped) { throw 'The launcher could not stop its own bridge process; the private registry was retained.' }
      if (-not $bridgeStop.Graceful) { throw 'The bridge needed a forced stop; any in-flight native operation outcome is unknown, so this run failed.' }
    }
    Start-Sleep -Milliseconds 500
  }
  Write-Host 'The bridge and Codex Desktop have exited. Waiting for this run’s Codex proxy and native child descriptors to disappear.'
  $nativeProxyExitCheckCompleted = $true
  $nativeProxyExitVerified = Wait-ForCodexNativeChildren $RegistryDir $runId 120
  if (-not $nativeProxyExitVerified) {
    throw 'A per-run Codex proxy/native child descriptor remains after the bounded wait. No native process was stopped, and the private registry will be retained.'
  }
  Write-Host 'All per-run Codex proxy/native child descriptors have exited; the private run registry is eligible for cleanup.'
} catch {
  [Console]::Error.WriteLine("FullControl run failed: {0}" -f $_.Exception.Message)
  if ($BridgeProcess) {
    try {
      $BridgeProcess.Refresh()
      if (-not $BridgeProcess.HasExited) {
        [void](Stop-OwnBridge $BridgeProcess $RegistryDir $runId $stopToken)
      }
    } catch { }
  }
  if ($DesktopProcess) {
    try {
      $DesktopProcess.Refresh()
      if (-not $DesktopProcess.HasExited) {
        Write-Warning 'Codex Desktop was left running normally. Close it yourself; the launcher is waiting to remove the private registry after it exits.'
        $DesktopProcess.WaitForExit()
      }
    } catch { }
  }
  exit 2
} finally {
  foreach ($name in $EnvironmentNames) {
    [Environment]::SetEnvironmentVariable($name, $OriginalEnvironment[$name], 'Process')
  }
  if ($RegistryDir -and $RegistryParent -and [IO.Directory]::Exists($RegistryDir)) {
    $bridgeStopped = $null -eq $BridgeProcess
    $desktopStopped = $null -eq $DesktopProcess
    if ($BridgeProcess) { $BridgeProcess.Refresh(); $bridgeStopped = $BridgeProcess.HasExited }
    if ($DesktopProcess) { $DesktopProcess.Refresh(); $desktopStopped = $DesktopProcess.HasExited }
    if (-not $bridgeStopped -or -not $desktopStopped) {
      Write-Warning 'A launched process is still running. The private registry was retained; close Codex Desktop and stop the bridge normally, then remove only this run directory.'
    } else {
      if (-not $nativeProxyExitCheckCompleted) {
        try {
          $nativeProxyExitCheckCompleted = $true
          $nativeProxyExitVerified = Wait-ForCodexNativeChildren $RegistryDir $runId 120
        } catch {
          Write-Warning 'The per-run Codex proxy/native child descriptors could not be verified. The private registry was retained.'
        }
      }
      if (-not $nativeProxyExitVerified) {
        Write-Warning 'A per-run Codex proxy/native child may still be running or its descriptor state could not be verified. The private registry was retained; no native process was stopped.'
      } else {
        $parentFull = [IO.Path]::GetFullPath($RegistryParent).TrimEnd([char]92) + [string][char]92
        $registryFull = [IO.Path]::GetFullPath($RegistryDir)
        $parsedRunId = [Guid]::Empty
        $validRunDirectory = [Guid]::TryParse([IO.Path]::GetFileName($registryFull), [ref]$parsedRunId)
        if ($registryFull.StartsWith($parentFull, [StringComparison]::OrdinalIgnoreCase) -and
            [IO.Path]::GetDirectoryName($registryFull) -ieq [IO.Path]::GetFullPath($RegistryParent) -and
            $validRunDirectory -and (Test-NoReparsePoint $registryFull) -and (Test-NoReparsePoint $RegistryParent)) {
          try { Remove-Item -LiteralPath $registryFull -Recurse -Force -ErrorAction Stop }
          catch { Write-Warning 'The private per-run registry could not be removed automatically. Keep Codex closed and remove only this run directory after reviewing it.' }
        }
      }
    }
  }
}
