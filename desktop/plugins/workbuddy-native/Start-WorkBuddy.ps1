param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('uia', 'standard')]
  [string] $Mode,
  [string] $ExecutablePath
)

$ErrorActionPreference = 'Stop'

try {
  if ([string]::IsNullOrWhiteSpace($ExecutablePath)) {
    $candidates = [Collections.Generic.List[string]]::new()
    if ($env:WORKBUDDY_EXE_PATH) { $candidates.Add($env:WORKBUDDY_EXE_PATH) }
    foreach ($keyPath in @(
      'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\WorkBuddy.exe',
      'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\WorkBuddy.exe',
      'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\WorkBuddy.exe'
    )) {
      try { $value = (Get-Item -LiteralPath $keyPath -ErrorAction Stop).GetValue(''); if ($value) { $candidates.Add([string]$value) } } catch { }
    }
    foreach ($root in @(
      (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
      (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs')
    )) {
      if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
      try {
        $shell = New-Object -ComObject WScript.Shell
        foreach ($link in Get-ChildItem -LiteralPath $root -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue) {
          if ($link.BaseName -notmatch '(?i)workbuddy') { continue }
          $target = $shell.CreateShortcut($link.FullName).TargetPath
          if ($target -and [IO.Path]::GetFileName($target) -ieq 'WorkBuddy.exe') { $candidates.Add($target) }
        }
      } catch { }
    }
    foreach ($candidate in @(
      (Join-Path $env:LOCALAPPDATA 'Programs\WorkBuddy\WorkBuddy.exe'),
      (Join-Path $env:ProgramFiles 'WorkBuddy\WorkBuddy.exe'),
      $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'WorkBuddy\WorkBuddy.exe' }),
      'D:\tools\WorkBuddy\WorkBuddy.exe'
    )) { if ($candidate) { $candidates.Add([string]$candidate) } }
    $found = @($candidates | Where-Object { $_ -match '^(?:[A-Za-z]:[\\/]|\\\\)' -and [IO.Path]::GetFileName($_) -ieq 'WorkBuddy.exe' -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -Unique)
    if ($found.Count -eq 1) { $ExecutablePath = $found[0] }
    elseif ($found.Count -gt 1) { throw 'Multiple WorkBuddy installations were found. Pass -ExecutablePath to select the intended installation.' }
    else { throw 'WorkBuddy.exe was not found. Set WORKBUDDY_EXE_PATH or pass -ExecutablePath to its absolute path.' }
  }
  if ($ExecutablePath -notmatch '^(?:[A-Za-z]:[\\/]|\\\\)' -or [IO.Path]::GetFileName($ExecutablePath) -ine 'WorkBuddy.exe') {
    throw 'ExecutablePath must be an absolute path to WorkBuddy.exe.'
  }
  $resolvedPath = [IO.Path]::GetFullPath($ExecutablePath)
  if (-not (Test-Path -LiteralPath $resolvedPath -PathType Leaf)) {
    throw "WorkBuddy.exe was not found at the selected path."
  }

  $processes = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='WorkBuddy.exe'" -ErrorAction Stop)
  $running = @($processes | Where-Object {
    -not $_.ExecutablePath -or [string]::Equals([IO.Path]::GetFullPath($_.ExecutablePath), $resolvedPath, [StringComparison]::OrdinalIgnoreCase)
  })
  if ($running.Count -gt 0) {
    Write-Host 'A WorkBuddy process for this install is already running. Close WorkBuddy normally, then run this launcher again.' -ForegroundColor Yellow
    exit 3
  }

  if ($Mode -eq 'uia') {
    Write-Host 'This starts WorkBuddy with Chromium complete renderer accessibility and the standard UIA provider feature enabled.'
    Write-Host 'No app files, app settings, security policy, or debugging ports are changed.'
    $process = Start-Process -FilePath $resolvedPath -ArgumentList @('--force-renderer-accessibility=complete', '--enable-features=UiaProvider') -PassThru
    Write-Host "WorkBuddy started with per-process accessibility flags (process $($process.Id))."
  } else {
    Write-Host 'This starts WorkBuddy normally without extra Chromium flags.'
    $process = Start-Process -FilePath $resolvedPath -PassThru
    Write-Host "WorkBuddy started normally (process $($process.Id))."
  }
} catch {
  Write-Error 'WorkBuddy launcher could not verify or start the selected executable.'
  exit 2
}
