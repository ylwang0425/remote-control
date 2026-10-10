# build-apk.ps1 — build and sign the release APK with the official command line
# toolchain only (aapt2 + javac + d8 + zipalign + apksigner). No Gradle, no
# Android Studio, nothing installed outside mobile/.tools/.
#
# Why not sdkmanager: the 2026 command-line tools replaced the Java SDK manager
# with `android.exe`, which is a bootstrap stub that downloads the real CLI on
# first run and cannot complete on Windows PowerShell. The needed SDK packages
# (platforms;android-35, build-tools;35.0.0) are fetched straight from Google's
# own repository index with size and SHA1 verified before extraction.
#
# Usage:  pwsh -File mobile/android/build-apk.ps1
#
# Secrets: the keystore password is read from mobile/.private/keystore.pass and
# is handed to the tools with -storepass:file / --ks-pass file:, so it never
# appears on a command line, in a log, or in this script.

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Mobile   = Join-Path $RepoRoot 'mobile'
$Android  = Join-Path $Mobile 'android'
$Build    = Join-Path $Mobile 'build'
$Dist     = Join-Path $Mobile 'dist'
$Tools    = Join-Path $Mobile '.tools'
$Sdk      = Join-Path $Tools 'sdk'
$Private  = Join-Path $Mobile '.private'

$Jdk      = 'D:\env\jdk17'
$BuildTools = Join-Path $Sdk 'build-tools\35.0.0'
$Platform   = Join-Path $Sdk 'platforms\android-35\android.jar'
$Keystore   = Join-Path $Private 'release.keystore'
$PassFile   = Join-Path $Private 'keystore.pass'

$env:JAVA_HOME = $Jdk
$env:PATH = "$Jdk\bin;$BuildTools;$env:PATH"

function Step($name) { Write-Host "`n=== $name ===" }

function Assert-Exists($path, $what) {
    if (-not (Test-Path $path)) { throw "$what not found at $path" }
}

Assert-Exists (Join-Path $BuildTools 'aapt2.exe') 'aapt2.exe'
Assert-Exists (Join-Path $BuildTools 'd8.bat') 'd8.bat'
Assert-Exists (Join-Path $BuildTools 'zipalign.exe') 'zipalign.exe'
Assert-Exists (Join-Path $BuildTools 'apksigner.bat') 'apksigner.bat'
Assert-Exists $Platform 'android.jar'
Assert-Exists $Keystore 'release.keystore'
Assert-Exists $PassFile 'keystore.pass'

Remove-Item -Recurse -Force $Build -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $Build, (Join-Path $Build 'gen'), (Join-Path $Build 'classes'), (Join-Path $Build 'dex'), $Dist | Out-Null

$Compiled  = Join-Path $Build 'compiled.zip'
$Linked    = Join-Path $Build 'base-unsigned.apk'
$WithDex   = Join-Path $Build 'with-dex.apk'
$Aligned   = Join-Path $Build 'aligned.apk'
$Final     = Join-Path $Dist 'AI-Remote-Android.apk'

# --- 1. resources -> flat files -------------------------------------------
Step '1/6 aapt2 compile (resources)'
& (Join-Path $BuildTools 'aapt2.exe') compile --dir (Join-Path $Android 'res') -o $Compiled
Write-Host "aapt2 compile exit=$LASTEXITCODE"; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# --- 2. resources -> APK with the binary manifest -------------------------
Step '2/6 aapt2 link (manifest + resources)'
& (Join-Path $BuildTools 'aapt2.exe') link `
    -o $Linked `
    -I $Platform `
    --manifest (Join-Path $Android 'AndroidManifest.xml') `
    -R $Compiled `
    --java (Join-Path $Build 'gen') `
    --min-sdk-version 26 `
    --target-sdk-version 35 `
    --auto-add-overlay `
    --no-version-vectors
Write-Host "aapt2 link exit=$LASTEXITCODE"; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# --- 3. java -> classes ---------------------------------------------------
Step '3/6 javac'
$Sources = @(Get-ChildItem -Recurse -File -Filter *.java (Join-Path $Android 'java') | ForEach-Object { $_.FullName })
$Sources += @(Get-ChildItem -Recurse -File -Filter *.java (Join-Path $Build 'gen') | ForEach-Object { $_.FullName })
Write-Host "compiling $($Sources.Count) source file(s)"
# -source/-target 8 is what lets -bootclasspath point javac at android.jar, so
# the compile can only see the Android API and not the desktop JDK's own.
& "$Jdk\bin\javac.exe" `
    -source 8 -target 8 -bootclasspath $Platform -classpath $Platform `
    -encoding UTF-8 -nowarn `
    -d (Join-Path $Build 'classes') `
    $Sources 2>&1 | Where-Object { $_ -notmatch 'bootstrap class path|source value 8|target value 8|警告|warning' }
Write-Host "javac exit=$LASTEXITCODE"; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# --- 4. classes -> dex ----------------------------------------------------
Step '4/6 d8 (classes.dex)'
$Classes = @(Get-ChildItem -Recurse -File -Filter *.class (Join-Path $Build 'classes') | ForEach-Object { $_.FullName })
& (Join-Path $BuildTools 'd8.bat') --lib $Platform --min-api 26 --output (Join-Path $Build 'dex') $Classes
Write-Host "d8 exit=$LASTEXITCODE"; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# --- 5. put classes.dex into the APK, then align --------------------------
Step '5/6 add classes.dex + zipalign'
Copy-Item $Linked $WithDex -Force
Push-Location (Join-Path $Build 'dex')
try {
    & "$Jdk\bin\jar.exe" uf $WithDex classes.dex
    Write-Host "jar update exit=$LASTEXITCODE"; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally { Pop-Location }

& (Join-Path $BuildTools 'zipalign.exe') -f -p 4 $WithDex $Aligned
Write-Host "zipalign exit=$LASTEXITCODE"; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# --- 6. sign --------------------------------------------------------------
Step '6/6 apksigner (release key from mobile/.private/)'
Remove-Item $Final -Force -ErrorAction SilentlyContinue
& (Join-Path $BuildTools 'apksigner.bat') sign `
    --ks $Keystore `
    --ks-key-alias airemote `
    --ks-pass "file:$PassFile" `
    --key-pass "file:$PassFile" `
    --v1-signing-enabled true `
    --v2-signing-enabled true `
    --out $Final `
    $Aligned
Write-Host "apksigner sign exit=$LASTEXITCODE"; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$Apk = Get-Item $Final
Write-Host "`nBUILD OK -> $($Apk.FullName)"
Write-Host "bytes: $($Apk.Length)"
Write-Host "sha256: $((Get-FileHash $Final -Algorithm SHA256).Hash.ToLower())"
