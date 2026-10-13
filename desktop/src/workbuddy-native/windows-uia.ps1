param(
  [string] $RequestJson
)

$ErrorActionPreference = 'Stop'
$utf8Input = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8Input
$utf8Output = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8Output
$OutputEncoding = $utf8Output
$stage = 'request'

function Write-Result($value) {
  $value | ConvertTo-Json -Depth 8 -Compress
}

try {
  $stage = 'request-read-stdin'
  if ([string]::IsNullOrWhiteSpace($RequestJson)) {
    # Action payloads travel through the private helper stdin pipe and never
    # appear in PowerShell command-line arguments or logs.
    $RequestJson = [Console]::In.ReadToEnd()
  }
  $stage = 'request-parse-json'
  $request = $RequestJson | ConvertFrom-Json
  $stage = 'request-budget'
  $helperClock = [Diagnostics.Stopwatch]::StartNew()
  $helperBudgetMs = 15000
  if ($request.operation -in @('semantic-action', 'native-model-catalog', 'navigate-conversation', 'new-task-page', 'composer-input', 'select-native-model', 'native-pending', 'pending-action')) {
    if ($null -ne $request.helperBudgetMs -and
        ([string]$request.helperBudgetMs -notmatch '^\d+$' -or [int64]$request.helperBudgetMs -lt 1 -or [int64]$request.helperBudgetMs -gt 15000)) {
      throw 'invalid helper budget'
    }
    if ($null -ne $request.helperBudgetMs) { $helperBudgetMs = [int]$request.helperBudgetMs }
  }
  function Get-HelperBudgetRemainingMs {
    return [Math]::Max(0, $helperBudgetMs - [int]$helperClock.ElapsedMilliseconds)
  }
  function Assert-HelperBudget {
    if ((Get-HelperBudgetRemainingMs) -le 0) { throw 'native helper budget expired' }
  }
  $stage = 'request-protocol'
  if ($request.protocol -ne 'workbuddy-native-uia-v1' -or @('inspect', 'activate-window', 'activate-inspect', 'semantic-snapshot', 'activate-semantic', 'semantic-action', 'semantic-identity', 'navigate-conversation', 'native-model-catalog', 'discover-main-windows', 'new-task-page', 'composer-input', 'select-native-model', 'native-pending', 'pending-action') -notcontains [string]$request.operation) {
    throw 'unsupported request'
  }
  $stage = 'request-control-bound'
  if ([string]$request.maxControls -notmatch '^\d+$' -or [int64]$request.maxControls -lt 1 -or [int64]$request.maxControls -gt 256) {
    throw 'invalid control bound'
  }

  $stage = 'load-uia'
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public static class WorkBuddyWindowProbe {
  public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError=true)] public static extern bool ShowWindowAsync(IntPtr hwnd, int command);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint desiredAccess);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder info, uint length, out uint needed);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint command);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public sealed class WindowRecord {
    public IntPtr Hwnd { get; set; }
    public int Pid { get; set; }
    public string Owner { get; set; }
    public bool Visible { get; set; }
    public bool Enabled { get; set; }
    public bool Minimized { get; set; }
    public bool Foreground { get; set; }
    public string ForegroundHandle { get; set; }
    public int X { get; set; }
    public int Y { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
    public string ClassName { get; set; }
    public string Title { get; set; }
  }
  public sealed class ChildWindowRecord {
    public IntPtr Hwnd { get; set; }
    public IntPtr ParentHwnd { get; set; }
    public int Pid { get; set; }
    public bool Visible { get; set; }
    public bool Enabled { get; set; }
    public int X { get; set; }
    public int Y { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
    public string ClassName { get; set; }
  }
  public static string InputDesktopKind() {
    IntPtr desktop = OpenInputDesktop(0, false, 0x0001); // DESKTOP_READOBJECTS only
    if (desktop == IntPtr.Zero) return "unavailable";
    try {
      uint needed;
      GetUserObjectInformation(desktop, 2, null, 0, out needed); // UOI_NAME
      if (needed == 0 || needed > 512) return "unavailable";
      var name = new StringBuilder((int)needed);
      if (!GetUserObjectInformation(desktop, 2, name, needed, out needed)) return "unavailable";
      if (String.Equals(name.ToString(), "Default", StringComparison.OrdinalIgnoreCase)) return "default";
      if (String.Equals(name.ToString(), "Winlogon", StringComparison.OrdinalIgnoreCase)) return "secure";
      return "other";
    } finally { CloseDesktop(desktop); }
  }
  public static WindowRecord[] Enumerate() {
    var windows = new List<WindowRecord>();
    var foreground = GetForegroundWindow();
    EnumWindowsProc callback = (hwnd, lParam) => {
      uint pid;
      GetWindowThreadProcessId(hwnd, out pid);
      var rect = new RECT();
      GetWindowRect(hwnd, out rect);
      var title = new StringBuilder(512);
      GetWindowText(hwnd, title, title.Capacity);
      var className = new StringBuilder(256);
      GetClassName(hwnd, className, className.Capacity);
      var owner = GetWindow(hwnd, 4);
      windows.Add(new WindowRecord {
        Hwnd = hwnd, Pid = (int)pid, Owner = owner == IntPtr.Zero ? null : owner.ToInt64().ToString(),
        Visible = IsWindowVisible(hwnd), Enabled = IsWindowEnabled(hwnd), Minimized = IsIconic(hwnd),
        Foreground = hwnd == foreground, ForegroundHandle = foreground == IntPtr.Zero ? null : foreground.ToInt64().ToString(),
        X = rect.Left, Y = rect.Top, Width = Math.Max(0, rect.Right - rect.Left), Height = Math.Max(0, rect.Bottom - rect.Top),
        ClassName = className.ToString(), Title = title.ToString()
      });
      return true;
    };
    EnumWindows(callback, IntPtr.Zero);
    GC.KeepAlive(callback);
    return windows.ToArray();
  }
  public static ChildWindowRecord[] EnumerateChildren(IntPtr parent) {
    var children = new List<ChildWindowRecord>();
    EnumWindowsProc callback = (hwnd, lParam) => {
      uint pid;
      GetWindowThreadProcessId(hwnd, out pid);
      var rect = new RECT();
      GetWindowRect(hwnd, out rect);
      var className = new StringBuilder(256);
      GetClassName(hwnd, className, className.Capacity);
      children.Add(new ChildWindowRecord {
        Hwnd=hwnd, ParentHwnd=GetParent(hwnd), Pid=(int)pid, Visible=IsWindowVisible(hwnd), Enabled=IsWindowEnabled(hwnd),
        X=rect.Left, Y=rect.Top, Width=Math.Max(0,rect.Right-rect.Left), Height=Math.Max(0,rect.Bottom-rect.Top),
        ClassName=className.ToString()
      });
      return children.Count < 2048;
    };
    EnumChildWindows(parent, callback, IntPtr.Zero);
    GC.KeepAlive(callback);
    return children.ToArray();
  }
}
public static class WorkBuddyProcessProbe {
  [StructLayout(LayoutKind.Sequential)] public struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)] public struct TokenMandatoryLabel { public SidAndAttributes Label; }
  public sealed class ProcessContext {
    public int ProcessId { get; set; }
    public bool Is64BitOperatingSystem { get; set; }
    public bool? Is64BitProcess { get; set; }
    public bool? IsWow64Process { get; set; }
    public string IntegrityLevel { get; set; }
    public int? IntegrityRid { get; set; }
    public int QueryHresult { get; set; }
    public string ErrorStage { get; set; }
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsWow64Process(IntPtr process, out bool wow64);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int informationClass,
    IntPtr information, uint informationLength, out uint returnLength);
  static string IntegrityName(int rid) {
    if (rid >= 0x5000) return "protected";
    if (rid >= 0x4000) return "system";
    if (rid >= 0x3000) return "high";
    if (rid >= 0x2100) return "medium-plus";
    if (rid >= 0x2000) return "medium";
    if (rid >= 0x1000) return "low";
    return "untrusted";
  }
  public static ProcessContext Inspect(int processId) {
    var result = new ProcessContext {
      ProcessId = processId,
      Is64BitOperatingSystem = Environment.Is64BitOperatingSystem,
      Is64BitProcess = null,
      IsWow64Process = null,
      IntegrityLevel = null,
      IntegrityRid = null,
      QueryHresult = 0,
      ErrorStage = ""
    };
    IntPtr process = IntPtr.Zero, token = IntPtr.Zero, buffer = IntPtr.Zero;
    try {
      result.ErrorStage = "open-process";
      process = OpenProcess(0x1000, false, processId); // PROCESS_QUERY_LIMITED_INFORMATION
      if (process == IntPtr.Zero) { result.QueryHresult = Marshal.GetHRForLastWin32Error(); return result; }
      result.ErrorStage = "query-bitness";
      bool wow64;
      if (IsWow64Process(process, out wow64)) {
        result.IsWow64Process = wow64;
        result.Is64BitProcess = Environment.Is64BitOperatingSystem && !wow64;
      } else { result.QueryHresult = Marshal.GetHRForLastWin32Error(); }
      result.ErrorStage = "open-token";
      if (!OpenProcessToken(process, 0x0008, out token)) { result.QueryHresult = Marshal.GetHRForLastWin32Error(); return result; }
      result.ErrorStage = "read-integrity-size";
      uint needed;
      GetTokenInformation(token, 25, IntPtr.Zero, 0, out needed); // TokenIntegrityLevel
      if (needed < Marshal.SizeOf(typeof(TokenMandatoryLabel)) || needed > 4096) {
        result.QueryHresult = Marshal.GetHRForLastWin32Error();
        return result;
      }
      buffer = Marshal.AllocHGlobal((int)needed);
      result.ErrorStage = "read-integrity";
      if (!GetTokenInformation(token, 25, buffer, needed, out needed)) {
        result.QueryHresult = Marshal.GetHRForLastWin32Error();
        return result;
      }
      var label = (TokenMandatoryLabel)Marshal.PtrToStructure(buffer, typeof(TokenMandatoryLabel));
      if (label.Label.Sid == IntPtr.Zero) { result.QueryHresult = unchecked((int)0x80004003); return result; }
      int count = Marshal.ReadByte(label.Label.Sid, 1);
      if (count < 1 || count > 15) { result.QueryHresult = unchecked((int)0x80070057); return result; }
      int rid = Marshal.ReadInt32(label.Label.Sid, 8 + (count - 1) * 4);
      result.IntegrityRid = rid;
      result.IntegrityLevel = IntegrityName(rid);
      result.QueryHresult = 0;
      result.ErrorStage = "";
      return result;
    } catch (Exception) {
      result.QueryHresult = unchecked((int)0x80004005);
      if (String.IsNullOrEmpty(result.ErrorStage)) result.ErrorStage = "query-context";
      return result;
    } finally {
      if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
      if (token != IntPtr.Zero) CloseHandle(token);
      if (process != IntPtr.Zero) CloseHandle(process);
    }
  }
}
'@
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $stage = 'load-accessibility-assembly'
  Add-Type -AssemblyName Accessibility
  $stage = 'compile-msaa-probe'
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WorkBuddyMsaaProbe {
  [DllImport("oleacc.dll", PreserveSig=true)]
  public static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint objectId, ref Guid iid,
    [MarshalAs(UnmanagedType.Interface)] out object accessible);
  [DllImport("oleacc.dll", PreserveSig=true)]
  public static extern int AccessibleChildren(
    [MarshalAs(UnmanagedType.Interface)] object container,
    int childStart,
    int childCount,
    [Out, MarshalAs(UnmanagedType.LPArray, ArraySubType=UnmanagedType.Struct, SizeParamIndex=2)] object[] children,
    out int obtained);
  public static int QueryInterfaceResult(object value, Guid iid) {
    if (value == null) return unchecked((int)0x80004003);
    IntPtr unknown = IntPtr.Zero;
    IntPtr result = IntPtr.Zero;
    try {
      unknown = Marshal.GetIUnknownForObject(value);
      return Marshal.QueryInterface(unknown, ref iid, out result);
    } catch (Exception) { return unchecked((int)0x80004002); }
    finally {
      if (result != IntPtr.Zero) Marshal.Release(result);
      if (unknown != IntPtr.Zero) Marshal.Release(unknown);
    }
  }
}
'@
  $stage = 'compile-uia-com-probe'
  Add-Type -Path @(
    (Join-Path $PSScriptRoot 'windows-uia-com.cs'),
    (Join-Path $PSScriptRoot 'windows-uia-pending.cs'),
    (Join-Path $PSScriptRoot 'model-popup.cs'),
    (Join-Path $PSScriptRoot 'pending-actions.cs'),
    (Join-Path $PSScriptRoot 'native-input.cs')
  )

  $stage = 'enumerate-windows'
  $expectedExePath = [string]$request.expectedExePath
  if ($expectedExePath -and ($expectedExePath -notmatch '^(?:[A-Za-z]:[\\/]|\\\\)' -or [IO.Path]::GetFileName($expectedExePath) -ine 'WorkBuddy.exe')) {
    throw 'invalid executable selector'
  }
  $expectedExe = if ($expectedExePath) { [IO.Path]::GetFullPath($expectedExePath) } else { $null }
  $hasExpectedProcessId = $null -ne $request.expectedProcessId
  $hasExpectedHandle = -not [string]::IsNullOrWhiteSpace([string]$request.expectedHandle)
  if ($hasExpectedProcessId -ne $hasExpectedHandle) { throw 'incomplete target window selector' }
  $expectedProcessIdSelector = 0
  $expectedHandleSelector = [string]$request.expectedHandle
  if ($hasExpectedProcessId -and (-not [int]::TryParse([string]$request.expectedProcessId, [ref]$expectedProcessIdSelector) -or
      $expectedProcessIdSelector -lt 1 -or $expectedHandleSelector -notmatch '^\d{1,20}$')) { throw 'invalid target window selector' }
  $maxControls = [int]$request.maxControls
  if ($request.operation -in @('semantic-snapshot', 'activate-semantic', 'semantic-action', 'semantic-identity', 'navigate-conversation', 'native-model-catalog', 'new-task-page', 'composer-input', 'select-native-model', 'native-pending', 'pending-action')) {
    $stage = 'semantic-target-check'
    if (-not $expectedExe) { throw 'semantic snapshot requires the exact WorkBuddy executable path' }
    if ($request.operation -eq 'native-model-catalog' -and -not $hasExpectedProcessId -and -not $hasExpectedHandle) {
      # One helper process resolves one exact native main window, preferring a
      # unique foreground candidate. This avoids a cold discovery subprocess
      # followed by a second cold action subprocess for models.list.
      $mainCandidates = New-Object 'System.Collections.Generic.List[object]'
      $currentSession = [Diagnostics.Process]::GetCurrentProcess().SessionId
      foreach ($candidateProcess in [Diagnostics.Process]::GetProcessesByName('WorkBuddy')) {
        try {
          $candidatePath = [IO.Path]::GetFullPath($candidateProcess.MainModule.FileName)
          $candidateHandle = [string]$candidateProcess.MainWindowHandle.ToInt64()
          if (-not [string]::Equals($candidatePath, $expectedExe, [StringComparison]::OrdinalIgnoreCase) -or
              $candidateProcess.SessionId -ne $currentSession -or $candidateHandle -notmatch '^\d{1,20}$' -or $candidateHandle -eq '0') { continue }
          $candidateWindow = [WorkBuddyWindowProbe]::Enumerate() | Where-Object {
            $_.Pid -eq $candidateProcess.Id -and $_.Hwnd.ToInt64().ToString() -ceq $candidateHandle -and $_.Visible -and $_.Enabled
          } | Select-Object -First 1
          if ($candidateWindow) { $mainCandidates.Add($candidateWindow) }
        } catch { }
        finally { $candidateProcess.Dispose() }
      }
      $selectedCandidate = $null
      if ($mainCandidates.Count -eq 1) { $selectedCandidate = $mainCandidates[0] }
      if (-not $selectedCandidate) { throw 'WorkBuddy has no unique visible native main window for model catalog read' }
      $expectedProcessIdSelector = [int]$selectedCandidate.Pid
      $expectedHandleSelector = [string]$selectedCandidate.Hwnd.ToInt64()
      $hasExpectedProcessId = $true
      $hasExpectedHandle = $true
    }
    if (-not $hasExpectedProcessId -or -not $hasExpectedHandle) { throw 'semantic operation requires exact process id and window handle' }
    if ($hasExpectedProcessId -and $expectedProcessIdSelector -lt 1) { throw 'invalid semantic process id' }
    $targetPid = $expectedProcessIdSelector
    $targetHwnd = [IntPtr]([Int64]$expectedHandleSelector)
    $process = [Diagnostics.Process]::GetProcessById($targetPid)
    $actualPath = [IO.Path]::GetFullPath($process.MainModule.FileName)
    $targetSession = [int]$process.SessionId
    $mainHandle = [string]$process.MainWindowHandle.ToInt64()
    $windowPid = [uint32]0
    [void][WorkBuddyWindowProbe]::GetWindowThreadProcessId($targetHwnd, [ref]$windowPid)
    $windowValid = [WorkBuddyWindowProbe]::IsWindow($targetHwnd) -and $windowPid -eq $targetPid -and
      [string]::Equals($actualPath, $expectedExe, [StringComparison]::OrdinalIgnoreCase) -and $mainHandle -ceq $expectedHandleSelector
    if (-not $windowValid) { throw 'exact WorkBuddy main window identity could not be verified' }
    $inputDesktopKind = [WorkBuddyWindowProbe]::InputDesktopKind()
    $activation = $null
    $restoreAttempted = $false
    if ($request.operation -in @('activate-semantic', 'native-model-catalog', 'new-task-page',
        'navigate-conversation', 'composer-input', 'select-native-model', 'pending-action')) {
      if ($inputDesktopKind -ne 'default') { throw 'input desktop is not available' }
      $before = [WorkBuddyWindowProbe]::Enumerate() | Where-Object { $_.Hwnd -eq $targetHwnd -and $_.Pid -eq $targetPid } | Select-Object -First 1
      if (-not $before) { throw 'exact WorkBuddy window disappeared before activation' }
      if ($before.Minimized) {
        $restoreAttempted = $true
        [void][WorkBuddyWindowProbe]::ShowWindowAsync($targetHwnd, 9)
        # Wait for this single state transition; never repeat the restore.
        $restoreDeadline = [Math]::Min($helperBudgetMs, [int]$helperClock.ElapsedMilliseconds + 1000)
        do {
          $restoredWindow = [WorkBuddyWindowProbe]::Enumerate() | Where-Object { $_.Hwnd -eq $targetHwnd -and $_.Pid -eq $targetPid } | Select-Object -First 1
          if ($restoredWindow -and -not $restoredWindow.Minimized) { break }
          [Threading.Thread]::Sleep(25)
        } while ($helperClock.ElapsedMilliseconds -lt $restoreDeadline)
      }
      if ($request.operation -eq 'activate-semantic') { [void][WorkBuddyWindowProbe]::SetForegroundWindow($targetHwnd) }
      $after = [WorkBuddyWindowProbe]::Enumerate() | Where-Object { $_.Hwnd -eq $targetHwnd -and $_.Pid -eq $targetPid } | Select-Object -First 1
      $confirmed = $after -and $after.Visible -and $after.Enabled -and -not $after.Minimized -and $after.Foreground -and
        ([WorkBuddyWindowProbe]::InputDesktopKind() -eq 'default')
      $activation = [pscustomobject]@{ outcome=if ($confirmed) { 'confirmed' } else { 'submitted' }; reason=if ($confirmed) { $null } else { 'foreground-not-confirmed' } }
    }
    $navigationReceipt = $null
    if ($request.operation -in @('composer-input', 'select-native-model', 'native-pending', 'pending-action')) {
      $stage = 'native-composer-input'
      $text = [string]$request.payload
      $draftFingerprint = [string]$request.expectedDraftFingerprint
      if ($request.operation -eq 'composer-input' -and
          ($text.Length -lt 1 -or $text.Length -gt 65536 -or $draftFingerprint -notmatch '^[a-f0-9]{16}$')) { throw 'invalid composer input' }
      $nullString = [System.Management.Automation.Language.NullString]::Value
      $titleForCom = $nullString
      $candidateIndex = -1
      $candidateList = New-Object 'System.Collections.Generic.List[System.String[]]'
      $knownTitles = $null
      if ($null -ne $request.PSObject.Properties['identityTitle']) {
        $titleForCom = [string]$request.identityTitle
        $candidateIndex = [int]$request.expectedCandidateIndex
        foreach ($candidate in @($request.anchorCandidates)) { $candidateList.Add([string[]]@($candidate | ForEach-Object { [string]$_ })) }
        if ($titleForCom.Length -lt 1 -or $titleForCom.Length -gt 180 -or $candidateList.Count -lt 1 -or $candidateList.Count -gt 64 -or
            $candidateIndex -lt 0 -or $candidateIndex -ge $candidateList.Count) { throw 'invalid composer identity' }
      } else {
        if ($null -eq $request.PSObject.Properties['knownConversationTitles']) { throw 'missing new-task composer guard' }
        $knownTitles = [string[]]@($request.knownConversationTitles | ForEach-Object { [string]$_ })
        if ($knownTitles.Length -gt 200) { throw 'invalid new-task titles' }
      }
      Assert-HelperBudget
      [WorkBuddyWindowsUiaComProbe]::StartHelperBudget([Math]::Max(0, (Get-HelperBudgetRemainingMs) - 600))
      if ($request.operation -eq 'select-native-model') {
        $stage = 'select-native-model'
        $model = [string]$request.model
        if ($model.Length -lt 1 -or $model.Length -gt 180 -or $model -match '[\r\n\x00-\x1f\x7f]') { throw 'invalid model label' }
        $selectionReceipt = [WorkBuddyWindowsUiaComProbe]::SelectNativeModel($targetHwnd, $targetPid, $expectedExe, $model,
          $titleForCom, $candidateList.ToArray(), $candidateIndex, $knownTitles)
        Write-Result ([pscustomobject]@{ protocol='workbuddy-native-uia-v1'; operation='select-native-model'; readOnly=$false
          target=@{ processId=$targetPid; handle=$expectedHandleSelector }; selectionReceipt=$selectionReceipt })
        exit 0
      }
      if ($request.operation -in @('native-pending', 'pending-action')) {
        if ($titleForCom -isnot [string]) { throw 'pending operation requires a native conversation' }
        $stage = 'native-pending'
        if ($request.operation -eq 'native-pending') {
          $pendingSnapshot = [WorkBuddyWindowsUiaComProbe]::InspectSemanticIdentity($targetHwnd, 5000, 3000, $titleForCom, $candidateList.ToArray())
          $questionMetadata = $null
          if ($null -ne $request.PSObject.Properties['questionMetadata']) {
            Add-Type -AssemblyName System.Web.Extensions
            $metaSerializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
            $metaSerializer.MaxJsonLength = 1048576
            $metaRequest = $metaSerializer.DeserializeObject($RequestJson)
            $metadataJson = $metaSerializer.Serialize($metaRequest['questionMetadata'])
            $questionMetadata = $metaSerializer.Deserialize($metadataJson, [WorkBuddyWindowsUiaComProbe+PendingQuestion[][]])
          }
          $forms = [WorkBuddyWindowsUiaComProbe]::InspectPendingForms($pendingSnapshot, $titleForCom, $questionMetadata)
          $stopState = [WorkBuddyWindowsUiaComProbe]::InspectStopState($pendingSnapshot, $titleForCom, $candidateList.Count, $candidateIndex)
          $nativeModel = $null
          if ($pendingSnapshot.status.composerBindingSucceeded -and $pendingSnapshot.identityProof.matchedCandidateIndex -eq $candidateIndex) {
            $selectors = @($pendingSnapshot.controls | Where-Object { $_.safeActionLabel -eq 'model-selector' -and -not $_.offscreen -and -not $_.passwordProtected })
            if ($selectors.Count -eq 1) { $nativeModel = [string]$selectors[0].accessibleName }
          }
          Write-Result ([pscustomobject]@{ protocol='workbuddy-native-uia-v1'; operation='native-pending'; readOnly=$true
            target=@{ processId=$targetPid; handle=$expectedHandleSelector }; identityProof=$pendingSnapshot.identityProof
            pendingForms=$forms; stopState=$stopState; currentModel=$nativeModel
          })
        } else {
          $stage = 'pending-action'
          Add-Type -AssemblyName System.Web.Extensions
          $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
          $serializer.MaxJsonLength = 1048576
          $serializer.RecursionLimit = 24
          $nativePlanJson = $request.nativePlan | ConvertTo-Json -Depth 16 -Compress
          $nativePlan = $serializer.Deserialize($nativePlanJson, [WorkBuddyWindowsUiaComProbe+PendingActionPlan])
          if (-not $nativePlan -or -not [string]::Equals($nativePlan.expectedExePath, $expectedExe, [StringComparison]::OrdinalIgnoreCase)) { throw 'invalid pending target' }
          $actionReceipt = [WorkBuddyWindowsUiaComProbe]::ExecutePendingAction($targetHwnd, $targetPid, $titleForCom,
            $candidateList.ToArray(), $candidateIndex, [Math]::Max(0, (Get-HelperBudgetRemainingMs) - 600), $nativePlan)
          Write-Result ([pscustomobject]@{ protocol='workbuddy-native-uia-v1'; operation='pending-action'; readOnly=$false
            target=@{ processId=$targetPid; handle=$expectedHandleSelector }; actionReceipt=$actionReceipt })
        }
        exit 0
      }
      $inputReceipt = [WorkBuddyWindowsUiaComProbe]::TypeNativeComposer($targetHwnd, $targetPid, $expectedExe, $text,
        $draftFingerprint, $titleForCom, $candidateList.ToArray(), $candidateIndex, $knownTitles)
      Write-Result ([pscustomobject]@{ protocol='workbuddy-native-uia-v1'; operation='composer-input'; readOnly=$false
        target=@{ processId=$targetPid; handle=$expectedHandleSelector }; inputReceipt=$inputReceipt })
      exit 0
    }
    if ($request.operation -eq 'new-task-page') {
      $activation = $null
      $stage = 'new-task-navigation-precondition'
      $knownConversationTitles = @($request.knownConversationTitles | ForEach-Object { [string]$_ })
      if ($null -eq $request.PSObject.Properties['knownConversationTitles'] -or $knownConversationTitles.Count -gt 200 -or
          ($knownConversationTitles | Where-Object { $_.Length -lt 1 -or $_.Length -gt 180 -or $_ -match '[\r\n\x00-\x1f\x7f]' }).Count -gt 0) { throw 'invalid conversation-title guard' }
      if ($targetSession -ne [Diagnostics.Process]::GetCurrentProcess().SessionId -or
          [WorkBuddyWindowProbe]::InputDesktopKind() -ne 'default') { throw 'native target session unavailable' }
      $readyWindow = [WorkBuddyWindowProbe]::Enumerate() | Where-Object { $_.Hwnd -eq $targetHwnd -and $_.Pid -eq $targetPid } | Select-Object -First 1
      if (-not $readyWindow -or -not $readyWindow.Visible -or -not $readyWindow.Enabled -or $readyWindow.Minimized) { throw 'native main window unavailable after restore' }
      Assert-HelperBudget
      [WorkBuddyWindowsUiaComProbe]::StartHelperBudget((Get-HelperBudgetRemainingMs))
      $initial = [WorkBuddyWindowsUiaComProbe]::InspectSemantic($targetHwnd, 5000, 3000)
      $initialProof = [WorkBuddyWindowsUiaComProbe]::AnalyzeNewTaskPage($initial, [string[]]$knownConversationTitles)
      if (-not $initialProof.snapshotComplete) { throw 'new-task navigation snapshot incomplete' }
      $tabs = @($initial.controls | Where-Object { $_.safeActionLabel -eq 'new-task-tab' -and -not $_.offscreen -and -not $_.passwordProtected -and $_.enabled })
      if ($tabs.Count -ne 1) { throw 'new-task navigation tab ambiguous' }
      if (-not $initialProof.verified) {
        $stage = 'new-task-selection'
        $nullString = [System.Management.Automation.Language.NullString]::Value
        $navigationReceipt = [WorkBuddyWindowsUiaComProbe]::ExecuteSemanticAction($targetHwnd, $targetPid, 'select',
          $tabs[0].runtimeIdHash, $tabs[0].regionHash, 'new-task-tab', '', $nullString, $nullString, $null, -1,
          $nullString, $false, [string[]]$knownConversationTitles)
      }
    }
    if ($request.operation -eq 'native-model-catalog') {
      $stage = 'read-native-model-catalog'
      $beforeCatalog = [WorkBuddyWindowProbe]::Enumerate() | Where-Object { $_.Hwnd -eq $targetHwnd -and $_.Pid -eq $targetPid } | Select-Object -First 1
      if (-not $beforeCatalog -or -not $beforeCatalog.Visible -or -not $beforeCatalog.Enabled -or $beforeCatalog.Minimized -or
          [WorkBuddyWindowProbe]::InputDesktopKind() -ne 'default') {
        throw 'exact WorkBuddy target context could not be confirmed before model catalog read'
      }
      Assert-HelperBudget
      [WorkBuddyWindowsUiaComProbe]::StartHelperBudget((Get-HelperBudgetRemainingMs))
      $catalog = [WorkBuddyWindowsUiaComProbe]::ReadNativeModelCatalog($targetHwnd, $targetPid)
      $stage = 'verify-native-model-catalog-target'
      $inputDesktopKind = [WorkBuddyWindowProbe]::InputDesktopKind()
      $finalWindow = [WorkBuddyWindowProbe]::Enumerate() | Where-Object { $_.Hwnd -eq $targetHwnd -and $_.Pid -eq $targetPid } | Select-Object -First 1
      $finalPathVerified = $false
      $finalMainHandleVerified = $false
      try {
        $finalProcess = [Diagnostics.Process]::GetProcessById($targetPid)
        $finalPath = [IO.Path]::GetFullPath($finalProcess.MainModule.FileName)
        $finalPathVerified = [string]::Equals($finalPath, $expectedExe, [StringComparison]::OrdinalIgnoreCase)
        $finalMainHandleVerified = $finalProcess.MainWindowHandle.ToInt64().ToString() -ceq $expectedHandleSelector
      } catch { }
      $targetContext = [WorkBuddyProcessProbe]::Inspect($targetPid)
      $helperContext = [WorkBuddyProcessProbe]::Inspect($PID)
      $targetContextVerified = $finalWindow -and $finalPathVerified -and $finalMainHandleVerified -and $finalWindow.Visible -and
        $finalWindow.Enabled -and -not $finalWindow.Minimized -and $inputDesktopKind -eq 'default'
      $outcome = [string]$catalog.outcome
      $reason = $catalog.reason
      if (-not $targetContextVerified) {
        $outcome = if (@($catalog.patternReceipts | Where-Object { $_.attempted }).Count -gt 0) { 'submitted' } else { 'blocked' }
        $reason = 'final-target-context-not-confirmed'
        $catalog.targetContextVerified = $false
      }
      Write-Result ([pscustomobject]@{
        protocol='workbuddy-native-uia-v1'; operation='native-model-catalog'; readOnly=$false
        outcome=$outcome; reason=$reason; inputDesktopKind=$inputDesktopKind; targetContextVerified=[bool]$targetContextVerified
        target=@{ processId=$targetPid; handle=$expectedHandleSelector; mainWindow=($mainHandle -ceq $expectedHandleSelector)
          visible=[bool]$finalWindow.Visible; enabled=[bool]$finalWindow.Enabled; minimized=[bool]$finalWindow.Minimized
          isForeground=[bool]$finalWindow.Foreground; foregroundHandle=[string]$finalWindow.ForegroundHandle }
        processContext=@{ helper=@{ processId=$PID; windowsSessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId
          is64BitOperatingSystem=$helperContext.Is64BitOperatingSystem; is64BitProcess=$helperContext.Is64BitProcess; isWow64Process=$helperContext.IsWow64Process
          integrityLevel=$helperContext.IntegrityLevel; integrityRid=$helperContext.IntegrityRid; queryHresult=$helperContext.QueryHresult; errorStage=$helperContext.ErrorStage }
          target=@{ processId=$targetPid; windowsSessionId=$targetSession; is64BitOperatingSystem=$targetContext.Is64BitOperatingSystem
            is64BitProcess=$targetContext.Is64BitProcess; isWow64Process=$targetContext.IsWow64Process; integrityLevel=$targetContext.IntegrityLevel
            integrityRid=$targetContext.IntegrityRid; queryHresult=$targetContext.QueryHresult; errorStage=$targetContext.ErrorStage }
          sameWindowsSession=([Diagnostics.Process]::GetCurrentProcess().SessionId -eq $targetSession)
          sameBitness=($helperContext.Is64BitProcess -eq $targetContext.Is64BitProcess)
          sameIntegrityLevel=($helperContext.IntegrityLevel -eq $targetContext.IntegrityLevel) }
        catalog=@{ currentModel=[string]$catalog.currentModel; models=@($catalog.models)
          targetContextVerified=[bool]$catalog.targetContextVerified
          initialDraftFingerprint=[string]$catalog.initialDraftFingerprint; finalDraftFingerprint=[string]$catalog.finalDraftFingerprint
          composerVerified=[bool]$catalog.composerVerified; initiallyExpanded=[bool]$catalog.initiallyExpanded
          finallyExpanded=[bool]$catalog.finallyExpanded
          modelMenu=@{ association=[string]$catalog.modelMenu.association
            newVisiblePopupRootCount=[int]$catalog.modelMenu.newVisiblePopupRootCount
            selectedCurrentModelCount=[int]$catalog.modelMenu.selectedCurrentModelCount
            controls=@($catalog.modelMenu.controls | ForEach-Object { @{ depthWithinPopup=[int]$_.depthWithinPopup
              controlType=[string]$_.controlType; controlTypeId=[int]$_.controlTypeId
              accessibleName=[string]$_.accessibleName; enabled=[bool]$_.enabled; offscreen=[bool]$_.offscreen
              selected=[bool]$_.selected; passwordProtected=[bool]$_.passwordProtected; patterns=@($_.patterns)
              pathHash=[string]$_.pathHash; runtimeIdHash=[string]$_.runtimeIdHash; regionHash=[string]$_.regionHash } }) }
          patternReceipts=@($catalog.patternReceipts) }
      })
      exit 0
    }
    if ($request.operation -eq 'navigate-conversation') {
      $stage = 'validate-native-conversation-route'
      $sessionId = [string]$request.sessionId
      $identityTitle = [string]$request.identityTitle
      $expectedCandidateIndex = -1
      if (-not [int]::TryParse([string]$request.expectedCandidateIndex, [ref]$expectedCandidateIndex) -or
          $expectedCandidateIndex -lt 0) { throw 'invalid native session candidate index' }
      $anchorCandidateList = New-Object 'System.Collections.Generic.List[System.String[]]'
      foreach ($candidate in @($request.anchorCandidates)) {
        $candidateAnchors = @($candidate | ForEach-Object { [string]$_ })
        if ($candidateAnchors.Count -gt 3 -or
            ($candidateAnchors | Where-Object { $_.Length -lt 2 -or $_.Length -gt 120 }).Count -gt 0) {
          throw 'invalid native conversation anchor candidates'
        }
        $anchorCandidateList.Add([string[]]$candidateAnchors)
      }
      $anchorCandidates = $anchorCandidateList.ToArray()
      $parsedSessionId = [Guid]::Empty
      if (-not [Guid]::TryParseExact($sessionId, 'D', [ref]$parsedSessionId) -or
          [string]::IsNullOrWhiteSpace($identityTitle) -or $identityTitle.Length -gt 180 -or
          $anchorCandidates.Length -lt 1 -or $anchorCandidates.Length -gt 64 -or
          $expectedCandidateIndex -ge $anchorCandidates.Length) { throw 'invalid native conversation route request' }
      if ($inputDesktopKind -ne 'default') { throw 'input desktop is not available for native conversation navigation' }
      $before = [WorkBuddyWindowProbe]::Enumerate() | Where-Object { $_.Hwnd -eq $targetHwnd -and $_.Pid -eq $targetPid } | Select-Object -First 1
      if (-not $before -or -not $before.Visible -or -not $before.Enabled -or $before.Minimized) { throw 'exact WorkBuddy target context is unavailable before native navigation' }
      $stage = 'native-navigation-precondition'
      Assert-HelperBudget
      [WorkBuddyWindowsUiaComProbe]::StartHelperBudget((Get-HelperBudgetRemainingMs))
      $beforeIdentity = [WorkBuddyWindowsUiaComProbe]::InspectSemanticIdentity($targetHwnd, 5000, 3000, $identityTitle, $anchorCandidates)
      if (-not $beforeIdentity -or -not $beforeIdentity.status -or $beforeIdentity.status.traversalTruncated -or
          $null -ne $beforeIdentity.status.errorType -or -not [string]::IsNullOrEmpty([string]$beforeIdentity.status.errorStage) -or
          -not $beforeIdentity.identityProof -or -not $beforeIdentity.status.composerBindingSucceeded) {
        throw 'native conversation page or empty composer could not be verified before navigation'
      }
      $beforeComposers = @($beforeIdentity.controls | Where-Object { $_.safeActionLabel -eq 'composer' -and -not $_.offscreen -and -not $_.passwordProtected })
      if ($beforeComposers.Count -ne 1 -or $beforeComposers[0].draftState -ne 'empty') {
        throw 'WorkBuddy navigation was refused because a user draft is present or the composer is ambiguous'
      }
      $alreadySelected = $beforeIdentity.identityProof.conversationHeaderMatches -eq 1 -and
        $beforeIdentity.identityProof.matchedCandidateIndex -eq $expectedCandidateIndex
      $beforeTargetContextVerified = $true
      try {
        $beforeProcess = [Diagnostics.Process]::GetProcessById($targetPid)
        $beforePath = [IO.Path]::GetFullPath($beforeProcess.MainModule.FileName)
        $beforeTargetContextVerified = [bool]([string]::Equals($beforePath, $expectedExe, [StringComparison]::OrdinalIgnoreCase) -and
          $beforeProcess.MainWindowHandle.ToInt64().ToString() -ceq $expectedHandleSelector -and
          [WorkBuddyWindowProbe]::InputDesktopKind() -eq 'default')
      } catch { $beforeTargetContextVerified = $false }
      if (-not $beforeTargetContextVerified) { throw 'exact WorkBuddy target context could not be revalidated before native navigation' }
      $routeSubmitted = $false
      $rowNavigation = $null
      if (-not $alreadySelected -and $anchorCandidates.Length -eq 1) {
        $rowNavigation = [WorkBuddyWindowsUiaComProbe]::NavigateUniqueSidebarConversation(
          $targetHwnd, $targetPid, $expectedExe, $identityTitle, $anchorCandidates, $expectedCandidateIndex)
        $routeSubmitted = [bool]$rowNavigation.attempted
      }
      if (-not $alreadySelected -and -not $routeSubmitted) {
        Assert-HelperBudget
        $stage = 'verify-workbuddy-public-protocol-registration'
        $classKey = [Microsoft.Win32.Registry]::ClassesRoot.OpenSubKey('workbuddy\shell\open\command')
        if (-not $classKey) { throw 'the WorkBuddy public conversation protocol is not registered' }
        try { $registeredCommand = [string]$classKey.GetValue('') } finally { $classKey.Dispose() }
        $handlerMatch = [regex]::Match($registeredCommand, '^\s*(?:"(?<path>[^"]+)"|(?<path>\S+))')
        if (-not $handlerMatch.Success -or -not [string]::Equals([IO.Path]::GetFullPath($handlerMatch.Groups['path'].Value), $expectedExe, [StringComparison]::OrdinalIgnoreCase)) {
          throw 'the registered WorkBuddy conversation protocol does not target this exact installation'
        }
        $stage = 'submit-workbuddy-public-conversation-uri'
        Assert-HelperBudget
        $uri = 'workbuddy://chat/' + $parsedSessionId.ToString('D').ToLowerInvariant()
        $startInfo = New-Object Diagnostics.ProcessStartInfo
        $startInfo.FileName = $uri
        $startInfo.UseShellExecute = $true
        $routeProcess = [Diagnostics.Process]::Start($startInfo)
        if (-not $routeProcess) { throw 'WorkBuddy did not accept its public conversation URI' }
        $routeProcess.Dispose()
        $routeSubmitted = $true
        Start-Sleep -Milliseconds 450
      }
      $stage = 'verify-native-conversation-after-route'
      Assert-HelperBudget
      [WorkBuddyWindowsUiaComProbe]::StartHelperBudget((Get-HelperBudgetRemainingMs))
      $afterIdentity = if ($alreadySelected) { $beforeIdentity } else {
        [WorkBuddyWindowsUiaComProbe]::InspectSemanticIdentity($targetHwnd, 5000, 3000, $identityTitle, $anchorCandidates)
      }
      $routeReadClock = [Diagnostics.Stopwatch]::StartNew()
      while ($routeSubmitted -and $afterIdentity.identityProof.matchedCandidateIndex -ne $expectedCandidateIndex -and
          $routeReadClock.ElapsedMilliseconds -lt 2000 -and (Get-HelperBudgetRemainingMs) -gt 1100) {
        Start-Sleep -Milliseconds 150
        $afterIdentity = [WorkBuddyWindowsUiaComProbe]::InspectSemanticIdentity($targetHwnd, 5000,
          [Math]::Min(1800, (Get-HelperBudgetRemainingMs) - 600), $identityTitle, $anchorCandidates)
      }
      $window = [WorkBuddyWindowProbe]::Enumerate() | Where-Object { $_.Hwnd -eq $targetHwnd -and $_.Pid -eq $targetPid } | Select-Object -First 1
      $finalPathVerified = $false
      $finalMainHandleVerified = $false
      try {
        $finalProcess = [Diagnostics.Process]::GetProcessById($targetPid)
        $finalPath = [IO.Path]::GetFullPath($finalProcess.MainModule.FileName)
        $finalPathVerified = [string]::Equals($finalPath, $expectedExe, [StringComparison]::OrdinalIgnoreCase)
        $finalMainHandleVerified = $finalProcess.MainWindowHandle.ToInt64().ToString() -ceq $expectedHandleSelector
      } catch { }
      $targetContextVerified = [bool]($window -and $finalPathVerified -and $finalMainHandleVerified -and $window.Visible -and
        $window.Enabled -and -not $window.Minimized -and [WorkBuddyWindowProbe]::InputDesktopKind() -eq 'default')
      $composerFinal = @($afterIdentity.controls | Where-Object { $_.safeActionLabel -eq 'composer' -and -not $_.offscreen -and -not $_.passwordProtected })
      $afterSnapshotComplete = $afterIdentity -and $afterIdentity.status -and -not $afterIdentity.status.traversalTruncated -and
        $null -eq $afterIdentity.status.errorType -and [string]::IsNullOrEmpty([string]$afterIdentity.status.errorStage)
      $pageConfirmed = $afterSnapshotComplete -and $afterIdentity.identityProof -and
        $afterIdentity.identityProof.conversationHeaderMatches -eq 1 -and
        $afterIdentity.identityProof.candidateCount -eq $anchorCandidates.Length -and
        $afterIdentity.identityProof.matchedCandidateIndex -eq $expectedCandidateIndex -and
        $composerFinal.Count -eq 1 -and $composerFinal[0].draftState -eq 'empty' -and $targetContextVerified
      $targetContext = [WorkBuddyProcessProbe]::Inspect($targetPid)
      $helperContext = [WorkBuddyProcessProbe]::Inspect($PID)
      Write-Result ([pscustomobject]@{
        protocol='workbuddy-native-uia-v1'; operation='navigate-conversation'; readOnly=$false
        inputDesktopKind=[WorkBuddyWindowProbe]::InputDesktopKind()
        outcome=if ($pageConfirmed) { 'confirmed' } elseif ($routeSubmitted) { 'submitted' } else { 'blocked' }
        reason=if ($pageConfirmed) { $null } elseif ($routeSubmitted) { 'native-page-not-confirmed' } else { 'identity-mismatch' }
        routeSubmitted=[bool]$routeSubmitted
        targetContextVerified=$targetContextVerified
        target=@{ processId=$targetPid; handle=$expectedHandleSelector; mainWindow=($mainHandle -ceq $expectedHandleSelector)
          visible=[bool]$window.Visible; enabled=[bool]$window.Enabled; minimized=[bool]$window.Minimized
          isForeground=[bool]$window.Foreground; foregroundHandle=[string]$window.ForegroundHandle }
        processContext=@{ sameWindowsSession=([Diagnostics.Process]::GetCurrentProcess().SessionId -eq $targetSession)
          sameBitness=($helperContext.Is64BitProcess -eq $targetContext.Is64BitProcess)
          sameIntegrityLevel=($helperContext.IntegrityLevel -eq $targetContext.IntegrityLevel) }
        identityProof=$afterIdentity.identityProof
      })
      exit 0
    }
    if ($request.operation -eq 'semantic-identity') {
      $stage = 'validate-conversation-identity'
      $identityTitle = [string]$request.identityTitle
      $anchorCandidateList = New-Object 'System.Collections.Generic.List[System.String[]]'
      foreach ($candidate in @($request.anchorCandidates)) {
        $candidateAnchors = @($candidate | ForEach-Object { [string]$_ })
        if ($candidateAnchors.Count -gt 3 -or
            ($candidateAnchors | Where-Object { $_.Length -lt 2 -or $_.Length -gt 120 }).Count -gt 0) {
          throw 'invalid native conversation anchor candidates'
        }
        $anchorCandidateList.Add([string[]]$candidateAnchors)
      }
      $anchorCandidates = $anchorCandidateList.ToArray()
      if ([string]::IsNullOrWhiteSpace($identityTitle) -or $identityTitle.Length -gt 180 -or
          $anchorCandidates.Length -lt 1 -or $anchorCandidates.Length -gt 64) {
        throw 'invalid native conversation identity probe'
      }
      if ($inputDesktopKind -ne 'default') { throw 'input desktop is not available for native conversation identity' }
      $before = [WorkBuddyWindowProbe]::Enumerate() | Where-Object { $_.Hwnd -eq $targetHwnd -and $_.Pid -eq $targetPid } | Select-Object -First 1
      if (-not $before -or -not $before.Visible -or -not $before.Enabled -or $before.Minimized) { throw 'exact WorkBuddy target context is unavailable before identity check' }
      $stage = 'read-native-conversation-identity'
      $identity = [WorkBuddyWindowsUiaComProbe]::InspectSemanticIdentity($targetHwnd, 5000, 3000, $identityTitle, $anchorCandidates)
      if (-not $identity -or -not $identity.status -or $identity.status.traversalTruncated -or
          $null -ne $identity.status.errorType -or -not [string]::IsNullOrEmpty([string]$identity.status.errorStage) -or
          -not $identity.identityProof) {
        throw 'native conversation identity could not be read completely'
      }
      $window = [WorkBuddyWindowProbe]::Enumerate() | Where-Object { $_.Hwnd -eq $targetHwnd -and $_.Pid -eq $targetPid } | Select-Object -First 1
      $finalPathVerified = $false
      $finalMainHandleVerified = $false
      try {
        $finalProcess = [Diagnostics.Process]::GetProcessById($targetPid)
        $finalPath = [IO.Path]::GetFullPath($finalProcess.MainModule.FileName)
        $finalPathVerified = [string]::Equals($finalPath, $expectedExe, [StringComparison]::OrdinalIgnoreCase)
        $finalMainHandleVerified = $finalProcess.MainWindowHandle.ToInt64().ToString() -ceq $expectedHandleSelector
      } catch { }
      $targetContextVerified = [bool]($window -and $finalPathVerified -and $finalMainHandleVerified -and $window.Visible -and
        $window.Enabled -and -not $window.Minimized -and [WorkBuddyWindowProbe]::InputDesktopKind() -eq 'default')
      $targetContext = [WorkBuddyProcessProbe]::Inspect($targetPid)
      $helperContext = [WorkBuddyProcessProbe]::Inspect($PID)
      Write-Result ([pscustomobject]@{
        protocol='workbuddy-native-uia-v1'; operation='semantic-identity'; readOnly=$false
        inputDesktopKind=[WorkBuddyWindowProbe]::InputDesktopKind()
        targetContextVerified=$targetContextVerified
        activation=@{ outcome=if ($targetContextVerified) { 'confirmed' } else { 'blocked' }; reason=if ($targetContextVerified) { $null } else { 'exact-main-window-mismatch' } }
        target=@{ processId=$targetPid; handle=$expectedHandleSelector; mainWindow=($mainHandle -ceq $expectedHandleSelector)
          visible=[bool]$window.Visible; enabled=[bool]$window.Enabled; minimized=[bool]$window.Minimized
          isForeground=[bool]$window.Foreground; foregroundHandle=[string]$window.ForegroundHandle }
        processContext=@{ sameWindowsSession=([Diagnostics.Process]::GetCurrentProcess().SessionId -eq $targetSession)
          sameBitness=($helperContext.Is64BitProcess -eq $targetContext.Is64BitProcess)
          sameIntegrityLevel=($helperContext.IntegrityLevel -eq $targetContext.IntegrityLevel) }
        identityProof=$identity.identityProof
      })
      exit 0
    }
    if ($request.operation -eq 'semantic-action') {
      $stage = 'validate-semantic-action'
      $actionOperation = [string]$request.action
      $runtimeIdHash = [string]$request.runtimeIdHash
      $regionHash = [string]$request.regionHash
      $safeActionLabel = [string]$request.safeActionLabel
      $expectedDraftFingerprint = [string]$request.expectedDraftFingerprint
      $payload = if ($null -eq $request.payload) { $null } else { [string]$request.payload }
      $identityTitle = if ($null -eq $request.identityTitle) { $null } else { [string]$request.identityTitle }
      $requireNewTaskIntent = $request.requireNewTaskIntent -eq $true
      $knownConversationTitles = @($request.knownConversationTitles | ForEach-Object { [string]$_ })
      if ($knownConversationTitles.Count -gt 200 -or
          ($knownConversationTitles | Where-Object { $_.Length -lt 1 -or $_.Length -gt 180 -or $_ -match '[\r\n\x00-\x1f\x7f]' }).Count -gt 0) {
        throw 'invalid new-task conversation-title guard'
      }
      $expectedCandidateIndex = -1
      if ($null -ne $request.expectedCandidateIndex -and
          -not [int]::TryParse([string]$request.expectedCandidateIndex, [ref]$expectedCandidateIndex)) { throw 'invalid candidate index' }
      $anchorCandidateList = New-Object 'System.Collections.Generic.List[System.String[]]'
      foreach ($candidate in @($request.anchorCandidates)) {
        $candidateAnchors = @($candidate | ForEach-Object { [string]$_ })
        if ($candidateAnchors.Count -gt 3 -or
            ($candidateAnchors | Where-Object { $_.Length -lt 2 -or $_.Length -gt 120 }).Count -gt 0) {
          throw 'invalid native conversation anchor candidates'
        }
        $anchorCandidateList.Add([string[]]$candidateAnchors)
      }
      $anchorCandidates = $anchorCandidateList.ToArray()
      if ($null -ne $request.PSObject.Properties['requireNewTaskIntent'] -and $request.requireNewTaskIntent -isnot [bool]) { throw 'invalid new-task intent selector' }
      $identityRequired = @('composer', 'send-label', 'stop-label', 'answer-label', 'allow-once-label', 'reject-label', 'model-option', 'workspace-option') -contains $safeActionLabel
      if ($requireNewTaskIntent -and -not (($actionOperation -eq 'set-value' -and $safeActionLabel -eq 'composer') -or
          ($actionOperation -eq 'invoke' -and $safeActionLabel -eq 'send-label'))) { throw 'invalid new-task intent action' }
      if ($requireNewTaskIntent -and ($null -ne $identityTitle -or $anchorCandidateList.Count -gt 0)) { throw 'new-task intent cannot carry a conversation identity' }
      if ($requireNewTaskIntent) { $identityRequired = $false }
      elseif ($knownConversationTitles.Count -gt 0 -and -not ($actionOperation -eq 'select' -and $safeActionLabel -eq 'new-task-tab')) {
        throw 'conversation titles are only valid for new-task intent or New Task navigation'
      }
      if ($identityRequired -and ([string]::IsNullOrWhiteSpace($identityTitle) -or $anchorCandidates.Length -lt 1 -or
          $anchorCandidates.Length -gt 64 -or $expectedCandidateIndex -lt 0 -or $expectedCandidateIndex -ge $anchorCandidates.Length)) {
        throw 'native conversation identity proof is required for this action'
      }
      if (-not $identityRequired -and $anchorCandidates.Length -gt 0) { throw 'unexpected conversation identity proof for this action' }
      if (@('set-value', 'invoke', 'expand', 'collapse', 'select') -notcontains $actionOperation -or
          $runtimeIdHash -notmatch '^[a-f0-9]{16}$' -or $regionHash -notmatch '^[a-f0-9]{16}$' -or
          $safeActionLabel.Length -gt 64 -or ($null -ne $payload -and $payload.Length -gt 65536) -or
          (($actionOperation -eq 'set-value' -or ($actionOperation -eq 'invoke' -and $safeActionLabel -eq 'send-label')) -and
            $expectedDraftFingerprint -notmatch '^[a-f0-9]{16}$') -or
          ($actionOperation -eq 'set-value' -and $null -eq $payload) -or
          ($actionOperation -ne 'set-value' -and $null -ne $payload)) { throw 'invalid semantic action request' }
      if ($inputDesktopKind -ne 'default') { throw 'input desktop is not available for UI Automation input' }
      $before = [WorkBuddyWindowProbe]::Enumerate() | Where-Object { $_.Hwnd -eq $targetHwnd -and $_.Pid -eq $targetPid } | Select-Object -First 1
      if (-not $before -or -not $before.Visible -or -not $before.Enabled -or $before.Minimized -or
          [WorkBuddyWindowProbe]::InputDesktopKind() -ne 'default') { throw 'exact WorkBuddy target context is unavailable before action' }
      $stage = 'semantic-action-fresh-observation'
      Assert-HelperBudget
      [WorkBuddyWindowsUiaComProbe]::StartHelperBudget((Get-HelperBudgetRemainingMs))
      $pre = [WorkBuddyWindowsUiaComProbe]::InspectSemantic($targetHwnd, 5000, 3000)
      if (-not $pre -or -not $pre.status -or $pre.status.traversalTruncated -or $null -ne $pre.status.errorType -or
          -not [string]::IsNullOrEmpty([string]$pre.status.errorStage)) { throw 'fresh UI Automation observation was incomplete' }
      $stage = 'semantic-action-single-pattern'
      # PowerShell 5.1 coerces a normal $null to String.Empty for string
      # parameters. Preserve true CLR nulls for optional C# strings so a
      # no-session New Task navigation/intent stays distinct from empty text.
      $nullString = [System.Management.Automation.Language.NullString]::Value
      $payloadForCom = $payload
      if ($null -eq $payloadForCom) { $payloadForCom = $nullString }
      $identityTitleForCom = $identityTitle
      if ($null -eq $identityTitleForCom) { $identityTitleForCom = $nullString }
      $expectedControlNameForCom = $nullString
      $actionResult = [WorkBuddyWindowsUiaComProbe]::ExecuteSemanticAction($targetHwnd, $targetPid, $actionOperation, $runtimeIdHash, $regionHash,
        $safeActionLabel, $expectedDraftFingerprint, $payloadForCom, $identityTitleForCom, $anchorCandidates, $expectedCandidateIndex,
        $expectedControlNameForCom, $requireNewTaskIntent, [string[]]$knownConversationTitles)
      $stage = 'semantic-action-post-observation'
      $raw = [WorkBuddyWindowsUiaComProbe]::InspectSemantic($targetHwnd, 5000, 3000)
      if (-not $raw -or -not $raw.status -or $raw.status.traversalTruncated -or $null -ne $raw.status.errorType -or
          -not [string]::IsNullOrEmpty([string]$raw.status.errorStage)) { throw 'post-action UI Automation observation was incomplete' }
      $window = [WorkBuddyWindowProbe]::Enumerate() | Where-Object { $_.Hwnd -eq $targetHwnd -and $_.Pid -eq $targetPid } | Select-Object -First 1
      if (-not $window -or -not $window.Visible -or -not $window.Enabled -or $window.Minimized -or
          [WorkBuddyWindowProbe]::InputDesktopKind() -ne 'default') { throw 'WorkBuddy target changed during action verification' }
      $controls = @($raw.controls | ForEach-Object {
        [pscustomobject]@{
          controlType=$_.controlType; safeActionLabel=$_.safeActionLabel; selectedItemLabel=if ($_.selected -and @('ControlType.TabItem','ControlType.ListItem') -contains $_.controlType) { $_.accessibleName } else { '' }
          accessibleName=$_.accessibleName; enabled=[bool]$_.enabled; selected=[bool]$_.selected; offscreen=[bool]$_.offscreen
          focusable=[bool]$_.focusable; runtimeIdHash=$_.runtimeIdHash; structuralPathHash=$_.pathHash; regionHash=$_.regionHash
          passwordProtected=[bool]$_.passwordProtected; rect=@{ x=$_.x; y=$_.y; width=$_.width; height=$_.height }
          draftState=$_.draftState; draftFingerprint=$_.draftFingerprint; patterns=@($_.patterns)
        }
      })
      $targetContext = [WorkBuddyProcessProbe]::Inspect($targetPid)
      $helperContext = [WorkBuddyProcessProbe]::Inspect($PID)
      $finalPathVerified = $false
      $finalMainHandleVerified = $false
      try {
        $finalProcess = [Diagnostics.Process]::GetProcessById($targetPid)
        $finalPath = [IO.Path]::GetFullPath($finalProcess.MainModule.FileName)
        $finalPathVerified = [string]::Equals($finalPath, $expectedExe, [StringComparison]::OrdinalIgnoreCase)
        $finalMainHandleVerified = $finalProcess.MainWindowHandle.ToInt64().ToString() -ceq $expectedHandleSelector
      } catch { }
      $targetContextVerified = [bool]($finalPathVerified -and $finalMainHandleVerified -and $window.Visible -and $window.Enabled -and
        -not $window.Minimized -and [WorkBuddyWindowProbe]::InputDesktopKind() -eq 'default')
      if (-not $targetContextVerified) { $actionResult.targetContextVerified = $false }
      Write-Result ([pscustomobject]@{
        protocol='workbuddy-native-uia-v1'; operation='semantic-action'; readOnly=$false; inputDesktopKind='default'
        targetContextVerified=$targetContextVerified
        target=@{ processId=$targetPid; handle=$expectedHandleSelector; windowsSessionId=$targetSession; visible=[bool]$window.Visible
          enabled=[bool]$window.Enabled; minimized=[bool]$window.Minimized; isForeground=[bool]$window.Foreground
          foregroundHandle=[string]$window.ForegroundHandle; mainWindow=($mainHandle -ceq $expectedHandleSelector) }
        processContext=@{ helper=@{ processId=$PID; windowsSessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId
          is64BitOperatingSystem=$helperContext.Is64BitOperatingSystem; is64BitProcess=$helperContext.Is64BitProcess; isWow64Process=$helperContext.IsWow64Process
          integrityLevel=$helperContext.IntegrityLevel; integrityRid=$helperContext.IntegrityRid; queryHresult=$helperContext.QueryHresult; errorStage=$helperContext.ErrorStage }
          target=@{ processId=$targetPid; windowsSessionId=$targetSession; is64BitOperatingSystem=$targetContext.Is64BitOperatingSystem
            is64BitProcess=$targetContext.Is64BitProcess; isWow64Process=$targetContext.IsWow64Process
            integrityLevel=$targetContext.IntegrityLevel; integrityRid=$targetContext.IntegrityRid; queryHresult=$targetContext.QueryHresult; errorStage=$targetContext.ErrorStage }
          sameWindowsSession=([Diagnostics.Process]::GetCurrentProcess().SessionId -eq $targetSession)
          sameBitness=($helperContext.Is64BitProcess -eq $targetContext.Is64BitProcess)
          sameIntegrityLevel=($helperContext.IntegrityLevel -eq $targetContext.IntegrityLevel) }
        actionResult=$actionResult; uiaCom=$raw.status; controls=$controls
      })
      exit 0
    }

    $stage = 'semantic-snapshot'
    $inputDesktopKind = [WorkBuddyWindowProbe]::InputDesktopKind()
    $window = [WorkBuddyWindowProbe]::Enumerate() | Where-Object { $_.Hwnd -eq $targetHwnd -and $_.Pid -eq $targetPid } | Select-Object -First 1
    if (-not $window) { throw 'exact WorkBuddy main window disappeared during semantic snapshot' }
    $allowContext = $window.Visible -and $window.Enabled
    $newTaskPageProof = $null
    if ($null -ne $request.PSObject.Properties['knownConversationTitles']) {
      $knownConversationTitles = @($request.knownConversationTitles | ForEach-Object { [string]$_ })
      if ($knownConversationTitles.Count -gt 200 -or
          ($knownConversationTitles | Where-Object { $_.Length -lt 1 -or $_.Length -gt 180 -or $_ -match '[\r\n\x00-\x1f\x7f]' }).Count -gt 0) {
        throw 'invalid new-task conversation-title guard'
      }
    }
    $raw = [WorkBuddyWindowsUiaComProbe]::InspectSemantic($targetHwnd, 5000, 3000)
    if (-not $raw -or -not $raw.status -or $raw.status.traversalTruncated -or $null -ne $raw.status.errorType -or
        -not [string]::IsNullOrEmpty([string]$raw.status.errorStage)) { throw 'semantic UI Automation observation was incomplete' }
    if ($null -ne $request.PSObject.Properties['knownConversationTitles']) {
      $newTaskPageProof = [WorkBuddyWindowsUiaComProbe]::AnalyzeNewTaskPage($raw, [string[]]$knownConversationTitles)
    }
    # Selecting New Task acknowledges the tab before its empty editor mounts.
    # Observe that one transition; never repeat the selection or type early.
    if ($request.operation -eq 'new-task-page' -and $navigationReceipt -and $navigationReceipt.submitted) {
      $navigationReadClock = [Diagnostics.Stopwatch]::StartNew()
      while (-not $newTaskPageProof.verified -and $navigationReadClock.ElapsedMilliseconds -lt 2500 -and
          (Get-HelperBudgetRemainingMs) -gt 900) {
        Start-Sleep -Milliseconds 150
        Assert-HelperBudget
        $raw = [WorkBuddyWindowsUiaComProbe]::InspectSemantic($targetHwnd, 5000, [Math]::Min(1500, (Get-HelperBudgetRemainingMs) - 600))
        $newTaskPageProof = [WorkBuddyWindowsUiaComProbe]::AnalyzeNewTaskPage($raw, [string[]]$knownConversationTitles)
      }
    }
    $controls = @($raw.controls | ForEach-Object {
      [pscustomobject]@{
        controlType=$_.controlType; safeActionLabel=$_.safeActionLabel; selectedItemLabel=if ($_.selected -and @('ControlType.TabItem','ControlType.ListItem') -contains $_.controlType) { $_.accessibleName } else { '' }
        accessibleName=$_.accessibleName; enabled=[bool]$_.enabled; selected=[bool]$_.selected; offscreen=[bool]$_.offscreen
        focusable=[bool]$_.focusable; runtimeIdHash=$_.runtimeIdHash; structuralPathHash=$_.pathHash; regionHash=$_.regionHash
        passwordProtected=[bool]$_.passwordProtected; rect=@{ x=$_.x; y=$_.y; width=$_.width; height=$_.height }
        draftState=$_.draftState; draftFingerprint=$_.draftFingerprint; patterns=@($_.patterns)
        expandCollapseState=[int]$_.expandCollapseState
      }
    })
    $targetContext = [WorkBuddyProcessProbe]::Inspect($targetPid)
    $helperContext = [WorkBuddyProcessProbe]::Inspect($PID)
    Write-Result ([pscustomobject]@{
      protocol='workbuddy-native-uia-v1'; operation='semantic-snapshot'; readOnly=($request.operation -eq 'semantic-snapshot')
      activation=$activation; inputDesktopKind=$inputDesktopKind
      target=@{ processId=$targetPid; handle=$expectedHandleSelector; windowsSessionId=$targetSession; visible=[bool]$window.Visible
        enabled=[bool]$window.Enabled; minimized=[bool]$window.Minimized; isForeground=[bool]$window.Foreground
        foregroundHandle=[string]$window.ForegroundHandle; mainWindow=($mainHandle -ceq $expectedHandleSelector) }
      processContext=@{ helper=@{ processId=$PID; windowsSessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId
        is64BitOperatingSystem=$helperContext.Is64BitOperatingSystem; is64BitProcess=$helperContext.Is64BitProcess; isWow64Process=$helperContext.IsWow64Process
        integrityLevel=$helperContext.IntegrityLevel; integrityRid=$helperContext.IntegrityRid; queryHresult=$helperContext.QueryHresult; errorStage=$helperContext.ErrorStage }
        target=@{ processId=$targetPid; windowsSessionId=$targetSession; is64BitOperatingSystem=$targetContext.Is64BitOperatingSystem
          is64BitProcess=$targetContext.Is64BitProcess; isWow64Process=$targetContext.IsWow64Process
          integrityLevel=$targetContext.IntegrityLevel; integrityRid=$targetContext.IntegrityRid; queryHresult=$targetContext.QueryHresult; errorStage=$targetContext.ErrorStage }
        sameWindowsSession=([Diagnostics.Process]::GetCurrentProcess().SessionId -eq $targetSession)
        sameBitness=($helperContext.Is64BitProcess -eq $targetContext.Is64BitProcess)
        sameIntegrityLevel=($helperContext.IntegrityLevel -eq $targetContext.IntegrityLevel) }
      uiaCom=$raw.status; controls=$controls; newTaskPageProof=$newTaskPageProof
      navigationReceipt=$navigationReceipt; restoreAttempted=$restoreAttempted
    })
    exit 0
  }
  $stage = 'read-processes'
  $candidatePids = @{}
  foreach ($process in [Diagnostics.Process]::GetProcessesByName('WorkBuddy')) {
    try {
      $path = $process.MainModule.FileName
      if (-not $expectedExe -or [string]::Equals([IO.Path]::GetFullPath($path), $expectedExe, [StringComparison]::OrdinalIgnoreCase)) {
        $candidatePids[[string]$process.Id] = [pscustomobject]@{
          id = $process.Id
          mainHandle = [string]$process.MainWindowHandle.ToInt64()
          windowsSessionId = [int]$process.SessionId
          path = $path
        }
      }
    } catch {
      # An inaccessible or exited process is omitted. We never broaden the selector.
    }
  }

  # Keep diagnostics to process metadata only: no command line, token handle,
  # profile path or account data leaves this helper.
  $helperProcessContextRaw = [WorkBuddyProcessProbe]::Inspect($PID)
  $helperProcessContext = [pscustomobject]@{
    processId=[int]$helperProcessContextRaw.ProcessId
    windowsSessionId=[int]([Diagnostics.Process]::GetProcessById($PID).SessionId)
    is64BitOperatingSystem=[bool]$helperProcessContextRaw.Is64BitOperatingSystem
    is64BitProcess=$helperProcessContextRaw.Is64BitProcess
    isWow64Process=$helperProcessContextRaw.IsWow64Process
    integrityLevel=$helperProcessContextRaw.IntegrityLevel
    integrityRid=$helperProcessContextRaw.IntegrityRid
    queryHresult=[int]$helperProcessContextRaw.QueryHresult
    errorStage=[string]$helperProcessContextRaw.ErrorStage
  }
  $targetProcessContexts = @()
  foreach ($candidatePid in @($candidatePids.Keys | Sort-Object)) {
    $context = [WorkBuddyProcessProbe]::Inspect([int]$candidatePid)
    $targetProcessContexts += [pscustomobject]@{
      processId=[int]$context.ProcessId
      windowsSessionId=[int]$candidatePids[[string]$candidatePid].windowsSessionId
      is64BitOperatingSystem=[bool]$context.Is64BitOperatingSystem
      is64BitProcess=$context.Is64BitProcess
      isWow64Process=$context.IsWow64Process
      integrityLevel=$context.IntegrityLevel
      integrityRid=$context.IntegrityRid
      queryHresult=[int]$context.QueryHresult
      errorStage=[string]$context.ErrorStage
    }
  }

  $inputDesktopKind = [WorkBuddyWindowProbe]::InputDesktopKind()
  $rendererAccessibilityByPid = @{}
  $uiaProviderByPid = @{}
  try {
    foreach ($nativeProcess in Get-CimInstance -ClassName Win32_Process -Filter "Name='WorkBuddy.exe'" -ErrorAction Stop) {
      if ($null -ne $nativeProcess.CommandLine) {
        $commandLine = [string]$nativeProcess.CommandLine
        $rendererAccessibilityByPid[[string]$nativeProcess.ProcessId] = ($commandLine -match '(?i)(?:^|\s)--force-renderer-accessibility(?:=complete)?(?:\s|$)')
        $featureMatch = [regex]::Match($commandLine, '(?i)(?:^|\s)--enable-features=([^\s]+)')
        $uiaProviderByPid[[string]$nativeProcess.ProcessId] = ($featureMatch.Success -and @($featureMatch.Groups[1].Value.Split(',')) -contains 'UiaProvider')
      }
    }
  } catch {
    # Command-line visibility is optional; never print raw command lines.
  }

  $stage = 'enum-windows'
  $handles = [Collections.Generic.List[object]]::new()
  foreach ($window in [WorkBuddyWindowProbe]::Enumerate()) {
    $process = $candidatePids[[string]$window.Pid]
    if (-not $process) { continue }
    $handles.Add([pscustomobject]@{
      hwnd = $window.Hwnd
      pid = $window.Pid
      visible = $window.Visible
      enabled = $window.Enabled
      minimized = $window.Minimized
      foreground = $window.Foreground
      foregroundHandle = $window.ForegroundHandle
      owner = $window.Owner
      rect = @{ x = $window.X; y = $window.Y; width = $window.Width; height = $window.Height }
      className = $window.ClassName
      titleCategory = if ($window.Title -ceq 'WorkBuddy') { 'workbuddy' } elseif ($window.Title.Length -eq 0) { 'empty' } else { 'other' }
      titleMatchesApp = ($window.Title -ceq 'WorkBuddy')
    })
  }

  if ($request.operation -eq 'discover-main-windows') {
    if (-not $expectedExe) { throw 'target discovery requires the exact WorkBuddy executable path' }
    $mainWindows = @($handles | Where-Object {
      $candidate = $candidatePids[[string]$_.pid]
      $candidate -and $candidate.mainHandle -ceq ([IntPtr]$_.hwnd).ToInt64().ToString()
    } | ForEach-Object {
      [pscustomobject]@{ processId=[int]$_.pid; handle=[string]$_.hwnd.ToInt64(); visible=[bool]$_.visible
        enabled=[bool]$_.enabled; minimized=[bool]$_.minimized; isForeground=[bool]$_.foreground
        foregroundHandle=if ($_.foregroundHandle -eq '0') { $null } else { [string]$_.foregroundHandle }; mainWindow=$true }
    } | Select-Object -First 32)
    Write-Result ([pscustomobject]@{ protocol='workbuddy-native-uia-v1'; operation='discover-main-windows'; readOnly=$true
      inputDesktopKind=$inputDesktopKind; windows=$mainWindows })
    exit 0
  }

  $activation = $null
  if ($request.operation -in @('activate-window', 'activate-inspect')) {
    $stage = 'validate-activation-target'
    $targetHandle = [string]$request.expectedHandle
    $targetPid = 0
    if (-not [int]::TryParse([string]$request.expectedProcessId, [ref]$targetPid) -or $targetHandle -notmatch '^\d{1,20}$' -or $targetPid -lt 1) {
      throw 'invalid activation target'
    }
    if ($inputDesktopKind -ne 'default') {
      $activation = [pscustomobject]@{ outcome='blocked'; reason='input-desktop-not-default' }
      if ($request.operation -eq 'activate-window') {
        Write-Result ([pscustomobject]@{ protocol='workbuddy-native-uia-v1'; operation='activate-window'; outcome=$activation.outcome; reason=$activation.reason })
        exit 0
      }
    }
    $matches = @($handles | Where-Object { [string]$_.hwnd.ToInt64() -ceq $targetHandle -and $_.pid -eq $targetPid })
    $selectedProcess = $candidatePids[[string]$targetPid]
    if ($activation -or $matches.Count -ne 1 -or -not $matches[0].visible -or -not $matches[0].enabled -or
        -not $selectedProcess -or $selectedProcess.mainHandle -cne $targetHandle -or
        -not [WorkBuddyWindowProbe]::IsWindow([IntPtr]::new([Int64]$targetHandle))) {
      if (-not $activation) { $activation = [pscustomobject]@{ outcome='blocked'; reason='exact-main-window-mismatch' } }
      if ($request.operation -eq 'activate-window') {
        Write-Result ([pscustomobject]@{ protocol='workbuddy-native-uia-v1'; operation='activate-window'; outcome=$activation.outcome; reason=$activation.reason })
        exit 0
      }
      $handles.Clear()
    } elseif ($request.operation -eq 'activate-window') {
      $stage = 'activate-window'
      $hwnd = [IntPtr]::new([Int64]$targetHandle)
      $restoreRequested = [WorkBuddyWindowProbe]::IsIconic($hwnd)
      if ($restoreRequested) { [void][WorkBuddyWindowProbe]::ShowWindowAsync($hwnd, 9) } # SW_RESTORE; return value is previous visibility, not success
      $foregroundAccepted = [WorkBuddyWindowProbe]::SetForegroundWindow($hwnd)
      $stage = 'verify-activation'
      Start-Sleep -Milliseconds 150
      $fresh = @([WorkBuddyWindowProbe]::Enumerate() | Where-Object { $_.Hwnd.ToInt64().ToString() -ceq $targetHandle -and $_.Pid -eq $targetPid })
      $confirmed = $fresh.Count -eq 1 -and -not $fresh[0].Minimized -and $fresh[0].Foreground -and $inputDesktopKind -eq 'default'
      Write-Result ([pscustomobject]@{
        protocol='workbuddy-native-uia-v1'; operation='activate-window'
        outcome=if ($confirmed) { 'confirmed' } elseif ($restoreRequested -or $foregroundAccepted) { 'submitted' } else { 'blocked' }
        reason=if ($confirmed) { $null } elseif ($fresh.Count -ne 1) { 'window-disappeared' } elseif ($fresh[0].Minimized) { 'restore-not-confirmed' } else { 'foreground-not-confirmed' }
        expectedHandle=$targetHandle; expectedProcessId=$targetPid
      })
      exit 0
    } else {
      $stage = 'activate-inspect-window'
      $hwnd = [IntPtr]::new([Int64]$targetHandle)
      $restoreRequested = [WorkBuddyWindowProbe]::IsIconic($hwnd)
      if ($restoreRequested) { [void][WorkBuddyWindowProbe]::ShowWindowAsync($hwnd, 9) } # SW_RESTORE; return value is previous visibility, not success
      $foregroundAccepted = [WorkBuddyWindowProbe]::SetForegroundWindow($hwnd)
      Start-Sleep -Milliseconds 150
      $fresh = @([WorkBuddyWindowProbe]::Enumerate() | Where-Object { $_.Hwnd.ToInt64().ToString() -ceq $targetHandle -and $_.Pid -eq $targetPid })
      $confirmed = $fresh.Count -eq 1 -and -not $fresh[0].Minimized -and $fresh[0].Foreground -and $inputDesktopKind -eq 'default'
      $activation = [pscustomobject]@{
        outcome=if ($confirmed) { 'confirmed' } elseif ($restoreRequested -or $foregroundAccepted) { 'submitted' } else { 'blocked' }
        reason=if ($confirmed) { $null } elseif ($fresh.Count -ne 1) { 'window-disappeared' } elseif ($fresh[0].Minimized) { 'restore-not-confirmed' } else { 'foreground-not-confirmed' }
      }
      if ($fresh.Count -eq 1) {
        $record = $fresh[0]
        $target = $matches[0]
        $target.visible=[bool]$record.Visible; $target.enabled=[bool]$record.Enabled; $target.minimized=[bool]$record.Minimized
        $target.foreground=[bool]$record.Foreground; $target.foregroundHandle=$record.ForegroundHandle
        $target.rect=@{ x=$record.X; y=$record.Y; width=$record.Width; height=$record.Height }
        $handles.Clear(); $handles.Add($target)
      } else {
        $handles.Clear()
      }
    }
  }

  function Get-ControlSummary($element, $depth, $index, $maxDepth, [bool]$allowContext) {
    $current = $element.Current
    $type = $current.ControlType.ProgrammaticName
    $isPassword = [bool]$current.IsPassword
    $automationId = [string]$current.AutomationId
    if ($automationId -notmatch '^[A-Za-z0-9_.:-]{1,80}$') { $automationId = '' }
    $className = [string]$current.ClassName
    if ($className.Length -gt 80 -or $className -notmatch '^[A-Za-z0-9_.:-]*$') { $className = '' }
    $rect = $current.BoundingRectangle
    $isOffscreen = [bool]$element.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::IsOffscreenProperty, $true)
    $isSelected = $false
    try { $isSelected = [bool]$element.GetCurrentPropertyValue([System.Windows.Automation.SelectionItemPattern]::IsSelectedProperty, $true) } catch { }
    $name = ''
    $action = ''
    $draftState = 'unavailable'
    $draftFingerprint = ''
    $runtimeHash = ''
    try {
      $runtime = [int[]]$element.GetRuntimeId()
      if ($runtime -and $runtime.Length -le 16) {
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $runtimeHash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($runtime -join ',')))).Replace('-', '').Substring(0, 16).ToLowerInvariant() }
        finally { $sha.Dispose() }
      }
    } catch { }
    if ($type -eq 'ControlType.ListItem' -and $isSelected -and $allowContext) {
      # Selected chat title is useful to match against local native history.
      # No message body, prompt, editor value, or unselected row label is read.
      $name = [string]$current.Name
      $name = $name -replace '(?i)\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*', '$1[REDACTED]'
      $name = $name -replace '(?i)\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret)(["''`]?\s*[:=]\s*["''`]?)[^\s"''``,;]+', '$1$2[REDACTED]'
      $name = $name -replace '[\r\n\p{Cc}]', ' '
      if ($name.Length -gt 200) { $name = '' }
    } elseif ($type -eq 'ControlType.Button' -and $allowContext) {
      $buttonName = ([string]$current.Name).Trim().ToLowerInvariant()
      if ($buttonName -match '^(send|\u53D1\u9001)$') { $action = 'send-label'; $name = [string]$current.Name }
      elseif ($buttonName -match '^(stop|\u505C\u6B62|interrupt|\u4E2D\u65AD)$') { $action = 'stop-label'; $name = [string]$current.Name }
      elseif ($buttonName -match '^(new chat|new conversation|\u65B0\u5EFA\u4F1A\u8BDD|\u5F00\u59CB\u65B0\u7684\u5BF9\u8BDD)$') { $action = 'new-chat-label'; $name = [string]$current.Name }
      elseif ($buttonName -match '^(new task|\u65B0\u5EFA\u4EFB\u52A1|\u65B0\u4EFB\u52A1)$') { $action = 'new-task-label'; $name = [string]$current.Name }
      elseif ($buttonName -match '^(allow once|allow this time|\u4EC5\u6B64\u4E00\u6B21\u5141\u8BB8|\u4EC5\u672C\u6B21\u5141\u8BB8)$') { $action = 'allow-once-label' }
      elseif ($buttonName -match '^(reject|deny|\u62D2\u7EDD)$') { $action = 'reject-label' }
      elseif ($buttonName -match '^(answer|submit|continue|\u56DE\u7B54|\u63D0\u4EA4|\u7EE7\u7EED)$') { $action = 'answer-label' }
    } elseif ($type -in @('ControlType.ComboBox','ControlType.TabItem') -and $allowContext) {
      $name = [string]$current.Name
    } elseif ($type -eq 'ControlType.Edit' -and $allowContext -and -not $isPassword) {
      $name = [string]$current.Name
    }
    if ($type -eq 'ControlType.TabItem' -and $allowContext -and $name -notmatch '^(项目|projects|新建任务|新任务|new task)$' -and -not $isSelected) {
      $name = ''
    }
    if ($type -eq 'ControlType.Edit' -and $allowContext -and -not $isPassword -and $name -match '今天帮你做些什么|What can I help you with') {
      # Inspect only the active WorkBuddy composer to guard against replacing
      # a PC-side draft. Its value is never serialized or logged.
      $valuePattern = $null
      $draftValue = $null
      if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
        $draftValue = [string]$valuePattern.Current.Value
      } else {
        $textPattern = $null
        if ($element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$textPattern)) {
          $draftValue = [string]$textPattern.DocumentRange.GetText(32768)
        }
      }
      if ($null -ne $draftValue) {
        $normalizedDraft = ($draftValue -replace '^\uFEFF', '').Trim()
        if ($normalizedDraft -ceq '' -or ($name -and $normalizedDraft -ceq $name.Trim())) {
          $draftState = 'empty'
          $normalizedDraft = ''
        } else {
          $draftState = 'non-empty'
        }
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $draftFingerprint = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($normalizedDraft))).Replace('-', '').Substring(0, 16).ToLowerInvariant() }
        finally { $sha.Dispose() }
      }
      $name = $name -replace '(?i)\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*', '$1[REDACTED]'
      $name = $name -replace '(?i)\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret)(["''`]?\s*[:=]\s*["''`]?)\S+', '$1$2[REDACTED]'
      $name = $name -replace '[\r\n\p{Cc}]', ' '
      if ($name.Length -gt 200) { $name = '' }
    }
    $patterns = [Collections.Generic.List[string]]::new()
    foreach ($entry in @(
      @{ Name='invoke'; Id=[System.Windows.Automation.InvokePattern]::Pattern },
      @{ Name='selectionItem'; Id=[System.Windows.Automation.SelectionItemPattern]::Pattern },
      @{ Name='value'; Id=[System.Windows.Automation.ValuePattern]::Pattern },
      @{ Name='text'; Id=[System.Windows.Automation.TextPattern]::Pattern },
      @{ Name='expandCollapse'; Id=[System.Windows.Automation.ExpandCollapsePattern]::Pattern },
      @{ Name='toggle'; Id=[System.Windows.Automation.TogglePattern]::Pattern }
    )) {
      $pattern = $null
      if ($element.TryGetCurrentPattern($entry.Id, [ref]$pattern)) { $patterns.Add($entry.Name) }
    }
    return [pscustomobject]@{
      depth = $depth
      index = $index
      runtimeIdHash = $runtimeHash
      controlType = $type
      automationId = $automationId
      className = $className
      enabled = [bool]$current.IsEnabled
      offscreen = $isOffscreen
      selected = $isSelected
      focusable = [bool]$current.IsKeyboardFocusable
      rect = @{ x = [int]$rect.X; y = [int]$rect.Y; width = [int]$rect.Width; height = [int]$rect.Height }
      selectedItemLabel = $name
      safeActionLabel = $action
      accessibleName = $name
      draftState = $draftState
      draftFingerprint = $draftFingerprint
      patterns = @($patterns.ToArray())
    }
  }

  function Get-DotNetUiaTreeStats([IntPtr]$hwnd, [int]$maxNodes = 2000, [int]$timeBudgetMs = 750) {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $counts = @{}
    $rootType = 0
    $traversed = 0
    $truncated = $false
    $hr = 0
    $errorType = $null
    try {
      $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
      if ($null -eq $root) { throw 'UIA returned no root element' }
      $rootType = [int]$root.Current.ControlType.Id
      $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
      $queue = [Collections.Generic.Queue[object]]::new()
      $queue.Enqueue([pscustomobject]@{ element=$root; depth=0 })
      while ($queue.Count -gt 0 -and $traversed -lt $maxNodes -and $clock.ElapsedMilliseconds -lt $timeBudgetMs) {
        $item = $queue.Dequeue()
        $typeId = [int]$item.element.Current.ControlType.Id
        $key = [string]$typeId
        if (-not $counts.ContainsKey($key)) { $counts[$key] = 0 }
        $counts[$key]++
        $traversed++
        if ($item.depth -ge 32) { continue }
        $child = $walker.GetFirstChild($item.element)
        $index = 0
        while ($null -ne $child -and $queue.Count -lt $maxNodes -and $clock.ElapsedMilliseconds -lt $timeBudgetMs) {
          $queue.Enqueue([pscustomobject]@{ element=$child; depth=$item.depth+1 })
          $child = $walker.GetNextSibling($child)
          $index++
        }
      }
      $truncated = ($queue.Count -gt 0 -or $traversed -ge $maxNodes -or $clock.ElapsedMilliseconds -ge $timeBudgetMs)
    } catch {
      $hr = [Runtime.InteropServices.Marshal]::GetHRForException($_.Exception)
      $errorType = $_.Exception.GetType().Name
    } finally {
      $clock.Stop()
    }
    $histogram = @($counts.GetEnumerator() | Sort-Object { [int]$_.Key } | ForEach-Object { '{0}:{1}' -f [int]$_.Key,[int]$_.Value })
    return [pscustomobject]@{
      rootRetrieved=($rootType -ne 0); hresult=$hr; rootControlTypeId=$rootType
      traversedNodes=$traversed; traversalTruncated=$truncated; elapsedMs=[int]$clock.ElapsedMilliseconds
      typeHistogram=@($histogram); errorType=$errorType
    }
  }

  function Test-UiaStructureSubscription([IntPtr]$hwnd) {
    $result = [pscustomobject]@{ attempted=$true; registered=$false; removed=$false; scope='subtree'; hresult=0; errorType=$null }
    $root = $null
    $handler = $null
    try {
      $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
      if ($null -eq $root) { throw 'no-automation-root' }
      # The callback intentionally ignores sender/event details. This is a
      # target-scoped provider lifecycle probe; no event text or element data
      # is observed or retained.
      $handler = [System.Windows.Automation.StructureChangedEventHandler]{ param($sender, $eventArgs) }
      [System.Windows.Automation.Automation]::AddStructureChangedEventHandler(
        $root, [System.Windows.Automation.TreeScope]::Subtree, $handler)
      $result.registered = $true
      Start-Sleep -Milliseconds 75
    } catch {
      $result.hresult = [Runtime.InteropServices.Marshal]::GetHRForException($_.Exception)
      $result.errorType = $_.Exception.GetType().Name
    } finally {
      if ($result.registered -and $null -ne $handler -and $null -ne $root) {
        try {
          [System.Windows.Automation.Automation]::RemoveStructureChangedEventHandler($root, $handler)
          $result.removed = $true
        } catch {
          $result.hresult = [Runtime.InteropServices.Marshal]::GetHRForException($_.Exception)
          $result.errorType = $_.Exception.GetType().Name
        }
      }
    }
    return $result
  }

  function Protect-Label([string]$value, [int]$limit = 200) {
    if ($null -eq $value) { return '' }
    $safe = $value -replace '(?i)\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*', '$1[REDACTED]'
    $safe = $safe -replace '(?i)\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret)(["''`]?\s*[:=]\s*["''`]?)\S+', '$1$2[REDACTED]'
    $safe = $safe -replace '[\r\n\p{Cc}]', ' '
    if ($safe.Length -gt $limit) { return '' }
    return $safe.Trim()
  }

  function Get-MsaaControlSummary($accessible, $childId, $depth, $pathHash, $index, $knownRoleCode = $null, [bool]$allowContext = $false) {
    $script:WorkBuddyMsaaStage = 'control-read-role'
    $roleCode = -1
    $stateCode = 0
    if ($null -ne $knownRoleCode) { $roleCode = [int]$knownRoleCode }
    else { try { $roleCode = [int]$accessible.accRole($childId) } catch { return $null } }
    $script:WorkBuddyMsaaStage = 'control-read-state'
    try { $stateCode = [int]$accessible.accState($childId) } catch { }
    $script:WorkBuddyMsaaStage = 'control-map-role'
    $role = switch ($roleCode) {
      43 { 'ControlType.Button' }
      34 { 'ControlType.ListItem' }
      37 { 'ControlType.TabItem' }
      42 { 'ControlType.Edit' }
      46 { 'ControlType.ComboBox' }
      15 { 'ControlType.Document' }
      default { '' }
    }
    if (-not $role) { return $null }
    $selected = (($stateCode -band 0x2) -ne 0)
    $enabled = (($stateCode -band 0x1) -eq 0)
    $offscreen = (($stateCode -band 0x10000) -ne 0)
    $rawName = ''
    $isProtected = (($stateCode -band 0x20000000) -ne 0) # STATE_SYSTEM_PROTECTED
    if (($allowContext -and $role -eq 'ControlType.ListItem' -and $selected) -or
        ($allowContext -and $role -in @('ControlType.Button','ControlType.TabItem','ControlType.ComboBox')) -or
        ($allowContext -and $role -eq 'ControlType.Edit' -and -not $isProtected)) {
      $script:WorkBuddyMsaaStage = 'control-read-name'
      try { $rawName = [string]$accessible.accName($childId) } catch { }
    }
    $name = Protect-Label $rawName
    $action = ''
    if ($role -eq 'ControlType.Button' -and $allowContext) {
      $script:WorkBuddyMsaaStage = 'control-action-normalize'
      $buttonName = ([string]$name).Trim().ToLowerInvariant()
      $script:WorkBuddyMsaaStage = 'control-action-match'
      if ($buttonName -match '^(send|\u53D1\u9001)$') { $action='send-label' }
      elseif ($buttonName -match '^(stop|\u505C\u6B62|interrupt|\u4E2D\u65AD)$') { $action='stop-label' }
      elseif ($buttonName -match '^(new chat|new conversation|\u65B0\u5EFA\u4F1A\u8BDD|\u5F00\u59CB\u65B0\u7684\u5BF9\u8BDD)$') { $action='new-chat-label' }
      elseif ($buttonName -match '^(new task|\u65B0\u5EFA\u4EFB\u52A1|\u65B0\u4EFB\u52A1)$') { $action='new-task-label' }
      elseif ($buttonName -match '^(allow once|allow this time|\u4EC5\u6B64\u4E00\u6B21\u5141\u8BB8|\u4EC5\u672C\u6B21\u5141\u8BB8)$') { $action='allow-once-label'; $name='' }
      elseif ($buttonName -match '^(reject|deny|\u62D2\u7EDD)$') { $action='reject-label'; $name='' }
      elseif ($buttonName -match '^(answer|submit|continue|\u56DE\u7B54|\u63D0\u4EA4|\u7EE7\u7EED)$') { $action='answer-label' }
      else { $name='' }
    }
    $draftState = 'unavailable'
    $draftFingerprint = ''
    if ($role -eq 'ControlType.Edit' -and $allowContext -and -not $isProtected -and $name -match '今天帮你做些什么|What can I help you with') {
      $script:WorkBuddyMsaaStage = 'control-read-draft'
      $draftValue = $null
      try { $draftValue = [string]$accessible.accValue($childId) } catch { }
      if ($null -ne $draftValue) {
        $normalized = ($draftValue -replace '^\uFEFF', '').Trim()
        if ($normalized -ceq '' -or ($name -and $normalized -ceq $name.Trim())) { $draftState='empty'; $normalized='' }
        else { $draftState='non-empty' }
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $draftFingerprint = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($normalized))).Replace('-', '').Substring(0, 16).ToLowerInvariant() }
        finally { $sha.Dispose() }
      }
    }
    $patterns = @()
    $script:WorkBuddyMsaaStage = 'control-read-default-action'
    try { if ([string]$accessible.accDefaultAction($childId)) { $patterns += 'defaultAction' } } catch { }
    if ($role -eq 'ControlType.Edit') { $patterns += 'value' }
    return [pscustomobject]@{
      depth=$depth; index=$index; runtimeIdHash=''; structuralPathHash=$pathHash; controlType=$role
      automationId=''; className=''; enabled=$enabled; offscreen=$offscreen
      selected=$selected; focusable=(($stateCode -band 0x00100000) -ne 0)
      rect=@{ x=0; y=0; width=0; height=0 }
      selectedItemLabel=if ($allowContext -and $role -eq 'ControlType.ListItem' -and $selected) { $name } else { '' }
      safeActionLabel=$action; accessibleName=$name
      draftState=$draftState; draftFingerprint=$draftFingerprint
      patterns=@($patterns)
      nativePath=$pathHash
    }
  }

  function Get-ComIdentityKey($value) {
    if ($null -eq $value -or -not [Runtime.InteropServices.Marshal]::IsComObject($value)) { return $null }
    $unknown = [IntPtr]::Zero
    try {
      $unknown = [Runtime.InteropServices.Marshal]::GetIUnknownForObject($value)
      return $unknown.ToInt64().ToString('x')
    } catch { return $null }
    finally { if ($unknown -ne [IntPtr]::Zero) { [void][Runtime.InteropServices.Marshal]::Release($unknown) } }
  }

  function Read-MsaaTree($hwnd, [int]$maxControls, [uint32]$objectId, [bool]$allowContext = $false) {
    $script:WorkBuddyMsaaStage = 'acquire-accessible'
    $controls = [Collections.Generic.List[object]]::new()
    $status = [pscustomobject]@{ objectId=$objectId; accessible=$false; childCount=0; rootRole=-1; hresult=0; ia2Hresult=$null; ia2Stage='not-attempted'; ia2Accessible=$false; rootType=''; stage='acquire-accessible'; traversalNodes=0; traversalTruncated=$false; elapsedMs=0; childError=''; trace=@() }
    $guid = [Guid]'618736e0-3c3d-11cf-810c-00aa00389b71'
    $root = $null
    $hr = [WorkBuddyMsaaProbe]::AccessibleObjectFromWindow($hwnd, $objectId, [ref]$guid, [ref]$root)
    $status.hresult = $hr
    if ($hr -ne 0 -or $null -eq $root) { return [pscustomobject]@{ status=$status; controls=@() } }
    $script:WorkBuddyMsaaStage = 'read-root-properties'
    $status.accessible = $true
    $status.rootType = $root.GetType().FullName
    $ia2Guid = [Guid]'E89F726E-C4F4-4c19-BB19-B647D7FA8478'
    $status.ia2Hresult = [WorkBuddyMsaaProbe]::QueryInterfaceResult($root, $ia2Guid)
    $status.ia2Stage = 'query-interface'
    $status.ia2Accessible = ($status.ia2Hresult -eq 0)
    $status.stage = 'read-root-properties'
    try { $status.childCount = [int]$root.accChildCount } catch { }
    try { $status.rootRole = [int]$root.accRole([object]0) } catch { }
    $script:WorkBuddyMsaaStage = 'walk-accessible-tree'
    $status.stage = 'walk-accessible-tree'
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $queue = [Collections.Generic.Queue[object]]::new()
    $rootIdentity = Get-ComIdentityKey $root
    $queue.Enqueue([pscustomobject]@{ accessible=$root; childId=0; depth=0; path='root'; index=0; identity=($rootIdentity + ':0'); expand=$true; childCount=$status.childCount })
    $visited = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $trace = [Collections.Generic.List[object]]::new()
    $traversed = 0
    while ($queue.Count -gt 0 -and $traversed -lt 2000 -and $clock.ElapsedMilliseconds -lt 1500) {
      $item = $queue.Dequeue()
      if (-not $visited.Add([string]$item.identity)) { continue }
      $traversed++
      $nodeRole = -1
      if ($item.depth -eq 0) { $nodeRole = $status.rootRole }
      else { try { $nodeRole = [int]$item.accessible.accRole([object]$item.childId) } catch { } }
      $traceEntry = $null
      if ($trace.Count -lt 32) {
        $traceEntry = [pscustomobject]@{ depth=$item.depth; childId=$item.childId; role=$nodeRole; childCount=0; objectType=$item.accessible.GetType().FullName }
        $trace.Add($traceEntry)
      }
      if ($item.depth -gt 0) {
        $script:WorkBuddyMsaaStage = 'read-accessible-control'
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($item.path))).Replace('-', '').Substring(0,16).ToLowerInvariant() }
        finally { $sha.Dispose() }
        $summary = Get-MsaaControlSummary $item.accessible $item.childId $item.depth $hash $item.index $nodeRole $allowContext
        if ($null -ne $summary -and $controls.Count -lt $maxControls) { $controls.Add($summary) }
      }
      if (-not $item.expand -or $item.depth -ge 32) { continue }
      $current = $item.accessible
      if ($item.childId -ne 0) {
        $script:WorkBuddyMsaaStage = 'resolve-accessible-child'
        try {
          $childObject = $item.accessible.accChild([object]$item.childId)
          if ($null -eq $childObject -or -not [Runtime.InteropServices.Marshal]::IsComObject($childObject)) { continue }
          $current = $childObject
        } catch { continue }
      }
      $childCount = [int]$item.childCount
      if ($item.childId -ne 0 -or $item.depth -gt 0) {
        $script:WorkBuddyMsaaStage = 'read-accessible-child-count'
        try { $childCount = [int]$current.accChildCount } catch { $childCount=0 }
      }
      if ($null -ne $traceEntry) { $traceEntry.childCount = $childCount }
      if ($childCount -le 0) { continue }
      if ($childCount -gt 2000) { $childCount=2000 }
      $batchSize = [Math]::Min(64, $childCount)
      for ($start = $childCount - $batchSize; $start -ge 0; $start -= $batchSize) {
        if ($traversed -ge 2000 -or $clock.ElapsedMilliseconds -ge 1500) { break }
        $count = [Math]::Min($batchSize, $childCount - $start)
        $children = [object[]]::new($count)
        $obtained = 0
        $script:WorkBuddyMsaaStage = 'accessible-children'
        $childrenHr = [WorkBuddyMsaaProbe]::AccessibleChildren($current, $start, $count, $children, [ref]$obtained)
        if ($childrenHr -lt 0) { $status.childError = ('HRESULT:{0:X8}' -f $childrenHr); continue }
        if ($obtained -lt 0 -or $obtained -gt $count) { $status.childError='invalid-child-count'; continue }
        # AccessibleChildren returns either a VT_I4 child ID or an actual
        # IAccessible object. Preserve that distinction: integer IDs are
        # queried against their parent; object variants are queried as self
        # using CHILDID_SELF (0).
        for ($offset = 0; $offset -lt $obtained; $offset++) {
          $child = $children[$offset]
          $position = $start + $offset
          if ($child -is [int] -or $child -is [long] -or $child -is [int16]) {
            $childId = [int]$child
            if ($childId -le 0) { continue }
            $parentIdentity = Get-ComIdentityKey $current
            $identity = $parentIdentity + ':' + $childId
            if ($queue.Count -lt 2000) { $queue.Enqueue([pscustomobject]@{ accessible=$current; childId=$childId; depth=$item.depth+1; path=($item.path+'/'+$position); index=$position; identity=$identity; expand=$true; childCount=0 }) }
          } elseif ($null -ne $child -and [Runtime.InteropServices.Marshal]::IsComObject($child)) {
            $objectIdentity = Get-ComIdentityKey $child
            if (-not $objectIdentity) { continue }
            if ($queue.Count -lt 2000) { $queue.Enqueue([pscustomobject]@{ accessible=$child; childId=0; depth=$item.depth+1; path=($item.path+'/'+$position); index=$position; identity=($objectIdentity+':0'); expand=$true; childCount=0 }) }
          }
          if ($queue.Count -ge 2000) { break }
        }
      }
    }
    $clock.Stop()
    $status.traversalNodes = $traversed
    $status.traversalTruncated = ($queue.Count -gt 0 -or $traversed -ge 2000 -or $clock.ElapsedMilliseconds -ge 1500)
    $status.elapsedMs = [int]$clock.ElapsedMilliseconds
    $status.trace = @($trace.ToArray())
    $status.stage = 'complete'
    # Project controls after traversal is complete; traversal is not capped
    # by the number of semantic controls returned to the caller.
    return [pscustomobject]@{ status=$status; controls=@($controls.ToArray()) }
  }

  $stage = 'project-windows'
  $windows = @()
  $rendererUiaProbeBudget = 16
  foreach ($window in $handles) {
    $process = $candidatePids[[string]$window.pid]
    $isMain = $process.mainHandle -eq [string]$window.hwnd.ToInt64()
    $isExactTarget = $hasExpectedProcessId -and $window.pid -eq $expectedProcessIdSelector -and
      [string]$window.hwnd.ToInt64() -ceq $expectedHandleSelector
    $controls = [Collections.Generic.List[object]]::new()
    $uiaError = $null
    $msaaStatus = $null
    $msaaErrorType = $null
    $uiaCom = $null
    $uiaStructureSubscription = [pscustomobject]@{ attempted=$false; registered=$false; removed=$false; scope='not-selected'; hresult=0; errorType=$null }
    $childWindows = @()
    $msaaRendererProbes = @()
    $rendererUiaProbes = @()
    if ($window.visible -and $window.enabled -and $inputDesktopKind -eq 'default') {
      $stage = 'read-uia-tree'
      # Reading a small allowlist of visible controls does not send input, so
      # it remains available for the explicitly selected exact HWND when a
      # separate app temporarily owns foreground. Foreground remains a hard
      # gate for any future UI action path.
      $allowContext = ($isExactTarget -and $window.visible -and $window.enabled)
      if ($isExactTarget) { $uiaStructureSubscription = Test-UiaStructureSubscription ([IntPtr]$window.hwnd) }
      try {
        $uiaComRaw = [WorkBuddyWindowsUiaComProbe]::Inspect([IntPtr]$window.hwnd, $maxControls, $allowContext, 5000, 1500)
        $uiaComControls = [Collections.Generic.List[object]]::new()
        foreach ($nativeControl in $uiaComRaw.controls) {
          $nativeName = [string]$nativeControl.accessibleName
          $uiaComControls.Add([pscustomobject]@{
            depth=$nativeControl.depth; index=$nativeControl.index; runtimeIdHash=$nativeControl.runtimeIdHash; structuralPathHash=$nativeControl.pathHash
            controlType=$nativeControl.controlType; automationId=''; className=''
            enabled=[bool]$nativeControl.enabled; offscreen=[bool]$nativeControl.offscreen
            selected=[bool]$nativeControl.selected; focusable=[bool]$nativeControl.focusable
            rect=@{ x=$nativeControl.x; y=$nativeControl.y; width=$nativeControl.width; height=$nativeControl.height }
            regionHash=[string]$nativeControl.regionHash; passwordProtected=[bool]$nativeControl.passwordProtected
            selectedItemLabel=if ($nativeControl.controlType -in @('ControlType.ListItem','ControlType.TabItem') -and $nativeControl.selected) { $nativeName } else { '' }
            safeActionLabel=[string]$nativeControl.safeActionLabel; accessibleName=$nativeName
            draftState=[string]$nativeControl.draftState; draftFingerprint=[string]$nativeControl.draftFingerprint
            patterns=@($nativeControl.patterns)
          })
        }
        $uiaCom = [pscustomobject]@{ status=$uiaComRaw.status; controls=@($uiaComControls.ToArray()) }
        foreach ($node in $uiaComControls) { $controls.Add($node) }
      } catch {
        $uiaCom = [pscustomobject]@{ status=$null; controls=@(); errorType=$_.Exception.GetType().Name }
      }
      $msaaClient = $null
      $msaaAssistive = $null
      try {
        $msaaClient = Read-MsaaTree ([IntPtr]$window.hwnd) $maxControls ([uint32]4294967292) $allowContext # OBJID_CLIENT
        $msaaStatus = [pscustomobject]@{ client=$msaaClient.status; assistive=$null }
        foreach ($node in $msaaClient.controls) { $controls.Add($node) }
      } catch { $msaaErrorType = "$($script:WorkBuddyMsaaStage):$($_.Exception.GetType().Name)" }
      # Chromium/Electron may host accessibility on a child renderer HWND.
      # Enumerate only descendants of this exact, PID/path-validated WorkBuddy
      # top-level HWND. MainWindowHandle is recorded as a hint, not used to
      # suppress inspection of visible same-install secondary windows.
      $rawChildren = @([WorkBuddyWindowProbe]::EnumerateChildren([IntPtr]$window.hwnd))
      $childWindows = @($rawChildren | Select-Object -First 256 | ForEach-Object {
        [pscustomobject]@{
          handle=[string]$_.Hwnd.ToInt64(); processId=$_.Pid; visible=[bool]$_.Visible; enabled=[bool]$_.Enabled
          parentHandle=[string]$_.ParentHwnd.ToInt64(); sourceWindowHandle=[string]$window.hwnd.ToInt64()
          rect=@{ x=$_.X; y=$_.Y; width=$_.Width; height=$_.Height }; className=$_.ClassName
        }
      })
      $rendererWindowCandidates = @($rawChildren | Where-Object {
        $_.ClassName -match '(?i)Chrome_RenderWidgetHostHWND|Chrome_WidgetWin_[0-9]+' -and
        $candidatePids.ContainsKey([string]$_.Pid)
      } | Select-Object -First 16)
      foreach ($rendererWindow in $rendererWindowCandidates) {
        if ($rendererUiaProbes.Count -ge 16) { break }
        $rendererProbe = [pscustomobject]@{
          handle=[string]$rendererWindow.Hwnd.ToInt64(); sourceWindowHandle=[string]$window.hwnd.ToInt64()
          parentHandle=[string]$rendererWindow.ParentHwnd.ToInt64()
          processId=$rendererWindow.Pid; className=$rendererWindow.ClassName
          visible=[bool]$rendererWindow.Visible; enabled=[bool]$rendererWindow.Enabled
          probed=$false; skipReason=$null; dotNet=$null; com=$null
        }
        if (-not $rendererWindow.Visible -or -not $rendererWindow.Enabled -or $rendererWindow.Width -le 0 -or $rendererWindow.Height -le 0) {
          $rendererProbe.skipReason = 'renderer-not-visible-enabled'
        } elseif ($rendererUiaProbeBudget -le 0) {
          $rendererProbe.skipReason = 'probe-budget-exhausted'
        } else {
          $rendererUiaProbeBudget--
          $rendererProbe.probed = $true
          $rendererProbe.dotNet = Get-DotNetUiaTreeStats ([IntPtr]$rendererWindow.Hwnd) 2000 750
          try { $rendererProbe.com = [WorkBuddyWindowsUiaComProbe]::InspectStatistics([IntPtr]$rendererWindow.Hwnd, 2000, 750) }
          catch { $rendererProbe.com = $null }
        }
        $rendererUiaProbes += $rendererProbe
      }
      $rendererCandidates = @($rendererWindowCandidates | Where-Object {
        $_.Visible -and $_.Enabled -and $_.Width -gt 0 -and $_.Height -gt 0
      } | Select-Object -First 16)
      foreach ($renderer in $rendererCandidates) {
        $probe = [pscustomobject]@{ handle=[string]$renderer.Hwnd.ToInt64(); sourceWindowHandle=[string]$window.hwnd.ToInt64(); parentHandle=[string]$renderer.ParentHwnd.ToInt64(); processId=$renderer.Pid; className=$renderer.ClassName; client=$null; assistiveObject=$null; controls=@() }
        try {
          $client = Read-MsaaTree ([IntPtr]$renderer.Hwnd) $maxControls ([uint32]4294967292) ($allowContext -and $renderer.Visible -and $renderer.Enabled) # OBJID_CLIENT
          $probe.client = $client.status
          $rendererControls = @($client.controls)
          $probe.controls = $rendererControls
          foreach ($node in $rendererControls) {
            $node | Add-Member -NotePropertyName sourceWindowHandle -NotePropertyValue $probe.handle -Force
            $controls.Add($node)
          }
        } catch {
          $probe.client = [pscustomobject]@{
            objectId=4294967292; accessible=$false; childCount=0; rootRole=-1; hresult=-2147467259
            ia2Hresult=$null; ia2Stage='not-attempted'; ia2Accessible=$false; rootType=''; stage='acquire-accessible'; traversalNodes=0; traversalTruncated=$false; elapsedMs=0
            childError=$_.Exception.GetType().Name; trace=@()
          }
        }
        $msaaRendererProbes += $probe
      }
      try {
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($window.hwnd)
        $nodes = [Collections.Generic.List[object]]::new()
        # Electron/Chromium often exposes renderer children only in the raw UIA
        # tree. We still serialize only a small allowlist of semantic controls.
        $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
        $stack = [Collections.Generic.Stack[object]]::new()
        $stack.Push([pscustomobject]@{ element = $root; depth = 0; index = 0 })
        $visited = 0
        while ($stack.Count -gt 0 -and $nodes.Count -lt $maxControls -and $visited -lt 5000) {
          $item = $stack.Pop()
          $visited++
          if ($item.depth -gt 0) {
            $summary = Get-ControlSummary $item.element $item.depth $item.index 8 $allowContext
            if ($summary.controlType -in @('ControlType.Button','ControlType.ListItem','ControlType.ComboBox','ControlType.Edit','ControlType.Document','ControlType.TabItem')) { $nodes.Add($summary) }
          }
          if ($item.depth -ge 12) { continue }
          $children = [Collections.Generic.List[object]]::new()
          $child = $walker.GetFirstChild($item.element)
          $siblingIndex = 0
          while ($null -ne $child -and $children.Count -lt $maxControls) {
            $children.Add([pscustomobject]@{ element = $child; depth = $item.depth + 1; index = $siblingIndex })
            $child = $walker.GetNextSibling($child)
            $siblingIndex++
          }
          for ($i = $children.Count - 1; $i -ge 0; $i--) { $stack.Push($children[$i]) }
        }
        if ($controls.Count -eq 0) { foreach ($node in $nodes) { $controls.Add($node) } }
      } catch {
        $uiaError = 'unavailable'
      }
    }
    $windows += [pscustomobject]@{
      handle = [string]$window.hwnd.ToInt64()
      ownerHandle = $window.owner
      processId = $window.pid
      windowsSessionId = $process.windowsSessionId
      processName = 'WorkBuddy'
      executableName = [IO.Path]::GetFileName($process.path)
      visible = [bool]$window.visible
      enabled = [bool]$window.enabled
      minimized = [bool]$window.minimized
      isForeground = [bool]$window.foreground
      foregroundHandle = $window.foregroundHandle
      mainWindow = [bool]$isMain
      rendererAccessibilityFlag = if ($rendererAccessibilityByPid.ContainsKey([string]$window.pid)) { [bool]$rendererAccessibilityByPid[[string]$window.pid] } else { $null }
      titleCategory = $window.titleCategory
      titleMatchesApp = [bool]$window.titleMatchesApp
      windowClass = $window.className
      rect = $window.rect
      controls = @($controls.ToArray())
      childWindows = @($childWindows)
      childWindowsTruncated = ($childWindows.Count -ge 256)
      rendererMsaaProbes = @($msaaRendererProbes)
      rendererUiaProbes = @($rendererUiaProbes)
      msaa = $msaaStatus
      msaaErrorType = $msaaErrorType
      uiaCom = $uiaCom
      uiaStructureSubscription = $uiaStructureSubscription
      uiaProviderFlag = if ($uiaProviderByPid.ContainsKey([string]$window.pid)) { [bool]$uiaProviderByPid[[string]$window.pid] } else { $null }
      uiaError = if ($inputDesktopKind -ne 'default') { 'input-desktop-not-default' } else { $uiaError }
    }
  }

  if ($request.operation -eq 'activate-inspect' -and $activation -and $activation.outcome -eq 'confirmed') {
    $stage = 'verify-semantic-snapshot-target'
    $inputDesktopKind = [WorkBuddyWindowProbe]::InputDesktopKind()
    $targetHandle = [string]$request.expectedHandle
    $targetPid = [int]$request.expectedProcessId
    $finalWindows = @([WorkBuddyWindowProbe]::Enumerate() | Where-Object { $_.Hwnd.ToInt64().ToString() -ceq $targetHandle -and $_.Pid -eq $targetPid })
    $pathVerified = $false
    $mainHandleVerified = $false
    try {
      $finalProcess = [Diagnostics.Process]::GetProcessById($targetPid)
      $finalPath = [IO.Path]::GetFullPath($finalProcess.MainModule.FileName)
      $pathVerified = [string]::Equals($finalPath, $expectedExe, [StringComparison]::OrdinalIgnoreCase)
      $mainHandleVerified = $finalProcess.MainWindowHandle.ToInt64().ToString() -ceq $targetHandle
    } catch { }
    if ($finalWindows.Count -ne 1 -or -not $pathVerified -or -not $mainHandleVerified) {
      $activation.outcome = 'submitted'
      $activation.reason = if ($finalWindows.Count -ne 1) { 'window-disappeared' } else { 'exact-main-window-mismatch' }
    } elseif ($inputDesktopKind -ne 'default') {
      $activation.outcome = 'blocked'
      $activation.reason = 'input-desktop-not-default'
    } else {
      $final = $finalWindows[0]
      $snapshotWindow = @($windows | Where-Object { $_.handle -ceq $targetHandle -and $_.processId -eq $targetPid })
      if ($snapshotWindow.Count -eq 1) {
        $snapshotWindow[0].isForeground = [bool]$final.Foreground
        $snapshotWindow[0].foregroundHandle = if ($final.ForegroundHandle -eq '0') { $null } else { $final.ForegroundHandle }
        $snapshotWindow[0].minimized = [bool]$final.Minimized
        $snapshotWindow[0].visible = [bool]$final.Visible
        $snapshotWindow[0].enabled = [bool]$final.Enabled
      }
      if (-not $final.Foreground -or $final.Minimized -or -not $final.Visible -or -not $final.Enabled) {
        $activation.outcome = 'submitted'
        $activation.reason = if ($final.Minimized) { 'restore-not-confirmed' } else { 'foreground-not-confirmed' }
      }
    }
  }

  Write-Result ([pscustomobject]@{
    protocol = 'workbuddy-native-uia-v1'
    operation = 'inspect'
    readOnly = $true
    activation = $activation
    inputDesktopKind = $inputDesktopKind
    inputDesktopAccessible = ($inputDesktopKind -eq 'default')
    helperProcessContext = $helperProcessContext
    targetProcessContexts = @($targetProcessContexts)
    actionCapabilities = @{ send = $false; create = $false; stop = $false; answer = $false; approve = $false }
    windows = @($windows)
  })
} catch {
  Write-Result ([pscustomobject]@{
    protocol = 'workbuddy-native-uia-v1'
    error = 'inspection_failed'
    stage = $stage
    failureType = $_.Exception.GetType().Name
  })
  exit 2
}
