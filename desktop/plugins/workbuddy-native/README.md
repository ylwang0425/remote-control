# WorkBuddy UI Automation opt-in

This directory contains an explicit, per-launch WorkBuddy accessibility startup option. It does not install a
WorkBuddy plugin, modify application files or saved preferences, change permission policy, or open a debug port.
The UI Automation setting is local to this computer. Saving it only updates this bridge's configuration and
reopens its WorkBuddy adapter; it does not start, stop, or reconfigure WorkBuddy by itself.

## Background CLI mode (1.1.4)

The local settings page offers **Official login and enable** and **Enable existing CLI login**.
Fill in the installed `WorkBuddy.exe` path if it is not already configured, and use the same account as
the desktop application. The bridge uses WorkBuddy's installed CLI in a hidden process with default
permissions. It never opens a desktop debug port or decrypts the desktop account store. SDK credentials
are saved only in this Windows user's private configuration, with a user-and-SYSTEM file ACL. They are
not uploaded to the relay or included in the Windows package.

Background mode supports new chats, existing projects, continuation of original desktop UUIDs,
per-message model selection, native questions, single-use Allow once/Reject, and Stop of its owned tasks.
CLI-created chats are saved in WorkBuddy's canonical local archive and indexed by this workbench;
WorkBuddy's desktop sidebar does not automatically list them. The bridge never writes `workbuddy.db`.
Ordinary reads and all operations on these background tasks do not require an unlocked desktop or UIA.
One task per project may run at a time, with at most four active tasks on this computer.

Real public-relay acceptance verified context recall, a model change, the actual AI question answer,
Stop, and native PowerShell Allow once/Reject. Allow once wrote exactly one test file; Reject left the
other file absent. Bash cannot invoke PowerShell under WorkBuddy's own security policy; the bridge
supports the native PowerShell tool instead. Supported permission contexts are Bash, PowerShell,
Write, Edit, MultiEdit and WebFetch. A request without a complete supported context is denied.

The interface automation described below remains an optional path for desktop-owned operations.
Permissions or Stop for a task already running inside the desktop app need that original UIA path;
the background bridge only controls its own CLI processes. Finish a desktop turn before continuing
that same chat from the phone. See `docs/acceptance/workbuddy-background-2026-10-14.md`.

## Start in accessibility mode

1. Exit WorkBuddy normally from its own menu or tray. The launcher refuses to start when the selected
   installation is already running; it never terminates a WorkBuddy process.
2. Double-click `Start-WorkBuddy-UIA.cmd` from the unpacked Windows bundle. From a source checkout, the same
   entry point is `desktop/plugins/workbuddy-native/Start-WorkBuddy-UIA.cmd`.
3. The launcher resolves an installation from `WORKBUDDY_EXE_PATH`, the Windows App Paths registry, a Start
   menu shortcut, common install locations, and previously observed locations. If several installations are
   present, choose one explicitly with the PowerShell entry point. From the bundle directory:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\plugins\workbuddy-native\Start-WorkBuddy.ps1 -Mode uia -ExecutablePath 'C:\path\WorkBuddy.exe'
   ```

   From the repository root, use `-File .\desktop\plugins\workbuddy-native\Start-WorkBuddy.ps1` instead.

The UIA launcher passes `--force-renderer-accessibility=complete` and `--enable-features=UiaProvider` only to
that process. It does not rewrite the app installation or enable remote debugging. UI Automation requires the
default unlocked Windows desktop; the target window must be available and foreground for each native action.
Status-page snapshots describe the last observation only. Every action must freshly check the exact process,
window, input desktop, and focus.

## Verified status and operation limits

WorkBuddy 5.7.7 has been exercised against the actual running Windows app through the public relay.
Native new-chat creation, continuation of the same local chat, model selection for the next message,
single-question answers, two-page answers, custom-text answers and Stop have been confirmed in its own saved messages.
The model catalog contains the 19 actual native options, including options that require ScrollIntoView.
A submission receipt is not a final AI result; the bridge continues to read the original native archive.

Phone history polling never restores a minimized WorkBuddy window or navigates its sidebar. A visible matching
chat can still provide passive pending-control observations; otherwise the bridge returns that chat's actual local
archive without claiming fresh native permissions or questions. Explicit answer, approval and Stop requests
retain their exact conversation checks and may restore/navigate the window when necessary.

Model listing first reads the current Windows user's `cache/acc-product-config-v3.json` under the selected
WorkBuddy data root. Only this WorkBuddy product's configured CLI model subset is returned, with native aliases
merged by display name. The cache is bounded to 1 MiB and 24 hours; it does not establish the current selected
model. Every native model change still selects and verifies the actual desktop option. A missing or invalid cache
never causes an ordinary background model read to restore a minimized window or switch to a New Task page.

Background mode uses a separate official SDK login for the same desktop account. It does not attach
to the desktop-owned HTTP worker or copy its gateway secret. The current authenticated CLI catalog
was 18 models during acceptance; the optional UIA cache and desktop picker remain separate sources.

Message typing uses standard focused Windows keyboard input so WorkBuddy's React/Slate editor receives
its normal input events. It preserves unrelated drafts, checks the selected conversation before input,
and sends only after the exact intended draft and enabled native Send control are observed. The exact
window can be restored from minimization; keyboard input requires foreground focus and an unlocked desktop.

Only a complete current native command card with its exact command and workspace can offer Allow once
or Reject. Skip and persistent approval choices are never phone actions. The local benign command tests
were automatically allowed by WorkBuddy and therefore did not verify real approval clicks. These paths
have protocol and C# fixture coverage but still need a genuine native approval card for real-app acceptance.

This installed version does not expose a verified workspace picker in its New Task accessibility view.
UIA new chats use the workspace selected by the desktop app. Background mode can select existing native projects. Existing native workspace
paths remain available for history filtering, and unsupported project IDs fail before a message is written.
The integration never falls back to a different AI tool.

## Return to ordinary startup

Exit WorkBuddy normally, then run `Start-WorkBuddy-Standard.cmd` from this directory. From a source checkout,
use `desktop/plugins/workbuddy-native/Start-WorkBuddy-Standard.cmd`. It starts the same program without the two
Chromium accessibility arguments. There is no persistent app setting to remove.

## Source-only developer inspector

`desktop/src/workbuddy-native/inspect.js` is a bounded, read-only diagnostic utility for developers working
from this repository. It is intentionally excluded from the Windows package and is not part of the user startup
flow. From the repository root, an engineer may run:

```powershell
node .\desktop\src\workbuddy-native\inspect.js --exe 'D:\tools\WorkBuddy\WorkBuddy.exe' --pid <PID> --handle <MainWindowHandle>
```

Use the exact executable path, PID, and main-window handle from the same running process. The inspector reports
bounded window/control metadata and labels; it does not read or print chat transcripts, and it performs no native
actions. These diagnostics do not replace acceptance of any remote operation.
