# Completed background acceptance — Windows bridge 1.1.6

## 1.1.6 native workspace discovery

The previous project catalog inferred directories from chat records and missed the desktop-selected
`lifebot` workspace, which had no local conversation. That selection is stored separately in
`storage/device/scoped/<scope>/newTaskWorkspace.json`, under the current account's home key.
The native `workspaces` table also retains recent workspace paths without requiring a chat.

The catalog now merges those read-only sources with existing chat directories, canonicalizes existing
folders, deduplicates them, and retains stable project IDs. Home keys from other accounts or unsupported
organization scopes are excluded. Malformed, oversized or linked metadata is not followed. Newer workspace
schemas with an account column are filtered by the current account.

After restarting the actual bridge, the public administrator API returned nine projects including
`lifebot` with its real folder path. All 519 desktop tests and 196 mobile tests passed. The regression
checks cover selecting a folder without any conversation, owner isolation, corrupt metadata, and
refreshing WorkBuddy projects when reopening the creation panel.

## 1.1.5 startup regression

The live administrator's `models.list` request failed because the installed WorkBuddy distribution contains
`codebuddy-lite-wb.mjs`, while the bridge did not select the vendor's dedicated lite bundle. The bootstrap
fell through to an absent general-purpose bundle and exited before returning any protocol frames.
The resulting process failure was also incorrectly labeled `session_gone`.

The bridge now sets `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1` on its owned child processes and uses `bridge_error`
for a closed CLI channel. After restarting the actual local bridge, the public administrator API returned
18 authenticated models and eight existing projects. All 514 desktop tests passed, including regressions
for model discovery with a lite-only distribution and an early process exit that must not mark the chat ended.

Page acceptance also found that a paired user's background list poll could close the administrator login
form. Polling now pauses while that form is open, and an already-running list response is ignored there.
All 195 mobile tests passed, including delayed-response and typed-password preservation regressions.

## Background operation acceptance

The final path uses WorkBuddy 5.7.7's bundled CLI 2.156.0, the official SDK `external` login, and
the same desktop account. SDK credentials stay in a restricted local file. No desktop credential
decryption, process-memory extraction, private gateway ticket, remote debug port, or permission bypass
is used. The earlier compatibility findings below are retained as history and superseded by this result.

Real acceptance through the public authenticated relay confirmed:

- 18 authenticated model options and seven existing local projects.
- Background creation in a selected existing project, with the exact first message and actual AI reply.
- Resumption after a fresh CLI process, correct recall of the previous test number, and an actual model
  change from `glm-5.1` to `glm-5.3-flash`.
- Continuation of original desktop UUID `9e59e62e-0d77-4652-bf52-b40746ba76da`; the original archive
  contained both the new user message and the actual AI response.
- A real `AskUserQuestion` request, the phone API answer, exact AI reply `已选择：蓝色`, and rejection
  of the stale question handle.
- Stop of an owned active generation, return to idle, and retirement of pending controls.
- Real PowerShell permission requests: Allow once wrote precisely the approved temporary test file;
  Reject left the other target absent and produced `APPROVAL-REJECTED`. No persistent permission
  suggestion was applied. WorkBuddy's independent Bash-to-PowerShell security rejection was preserved;
  the correct native PowerShell tool was used instead.

These background operations completed without starting a WorkBuddy desktop GUI. The desktop main
window was absent throughout the captured checks; its absence was preserved before and after public
creation, reading, and original-chat continuation. This is distinct from verifying a minimized open window.

The user approved background CLI creation managed by the phone workbench. CLI-created chats use the
canonical local archive and a separate workbench index; they do not automatically appear in the WorkBuddy
desktop sidebar. `workbuddy.db` remains read-only. Existing desktop chats retain their original UUID.
The project selector accepts only projects from this account's actual local catalog. The bridge permits
one active task per project and at most four active background tasks.

The native UIA path remains optional for tasks already owned by the desktop app. Background Stop,
questions and approvals apply to the bridge's own CLI tasks; finish a desktop turn before continuing
that same chat. New chats and subsequent turns from this workbench use background CLI when enabled.
Unsupported or incomplete permission contexts are denied. Supported contexts cover Bash, PowerShell,
Write, Edit, MultiEdit and WebFetch. Physical Android installation was not repeated in this acceptance;
the existing Android shell loads the hosted workbench.

Private acceptance records are excluded from source and delivery archives. Public source tests cover
account mismatch, original UUID checks, stale/cancelled handles, exact question choices, scoped
single-use decisions, project writer locks, local CSRF/origin checks, and UTF-8 stream boundaries.

## Earlier investigation history

# WorkBuddy background operations — 2026-10-14

Desktop bridge 1.1.2 moves verified read operations away from desktop input. Native writes retain
the existing UI Automation route until the CLI can prove that it continues the same desktop chat.

## Delivered changes

- Phone history polling does not restore minimized windows or navigate the desktop sidebar.
  The original native archive remains readable while the desktop shows another chat. Pending
  controls are advertised only when a passive observation verifies the exact visible conversation.
- Model listing reads the selected WorkBuddy data root's own product cache. It returns the configured
  CLI agent's model names, merges native aliases, and does not claim to observe the current selection.
  It rejects other products, malformed references, unsafe names, oversized files and caches over
  24 hours old. A background request with no valid cache performs no native window operation.
- An explicit new-chat request can still obtain the live model catalog through UIA when its local
  cache is unavailable. Send, answer, Allow once, Reject and Stop retain fresh native identity checks.

## Live acceptance

The public authenticated relay returned 19 model options matching this computer's local product cache
and 25 messages from an existing native chat. WorkBuddy remained minimized and outside the foreground
before and after both reads. The original JSONL archive's SHA-256 was unchanged.

Desktop regression coverage passes 494 tests, including minimized-window history reads, avoiding
sidebar navigation, explicit action activation, cache bounds and deadlines, native alias handling,
and exclusion of unrelated model definitions and credentials from catalog responses.

## CLI compatibility findings

The installed application is WorkBuddy 5.7.7. Its bundled CodeBuddy CLI reports version 2.156.0 and
supports `--resume`, stream JSON, SDK control requests and a local HTTP service. The mechanics are
documented in the official [CLI reference](https://www.codebuddy.ai/docs/cli/cli-reference) and
[HTTP API reference](https://www.codebuddy.ai/docs/cli/http-api).

The standalone CLI initialized but reported no authenticated account. An actual model request returned
authentication required; the installed `workbuddy-desktop` authentication method did not establish
a login. Initializing a transport or listing models did not count as a successful model execution.

The exact desktop-owned CLI worker was independently matched to its native session descriptor,
process ancestry, executable, start time and loopback listener. Its HTTP service returned 401 to
an unauthenticated read. The desktop generates its gateway secret in memory; it does not publish
an external attachment credential in that session descriptor. Gateway authentication was retained.

The isolated desktop sample also encountered a native sensitive-content approval timeout. A reported
desktop reply could not be confirmed in its original archive, so neither context reuse nor a background
write to that same native ID has passed acceptance. No background create/send/Stop/approval capability
was enabled on the strength of this probe. No native application files, permissions, login state or
conversation database were edited to get around these checks.

## Delivery scope

Windows 1.1.2 contains these read improvements and the existing native helpers. Android 1.1.0 remains
the lightweight shell for the hosted workbench. Physical Android acceptance and the deferred Codex
full-control restart remain outside this verification. Go/SQLite/Caddy and account/admin scopes are
unchanged. Native transcripts, credentials, proprietary application code and diagnostics stay outside
the source repository and Windows package.
