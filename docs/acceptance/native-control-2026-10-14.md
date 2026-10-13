# Native control acceptance — 2026-10-14

Desktop bridge 1.1.1 connects the original desktop chats. The relay remains Go/SQLite with a
256 MiB service memory limit; no model or separate database server runs on the relay host.

## Verified against WorkBuddy 5.7.7

The public authenticated relay was used for new-chat creation, existing-chat continuation,
next-message model selection, question answers and Stop. Checks read the app's own local
conversation archive rather than treating a transport acknowledgement as a completed AI result.

| Operation | Native evidence |
| --- | --- |
| New chat from an existing chat | A new native UUID, the exact first user message and `WORKBUDDY-CREATE-FROM-CHAT-OK` were persisted. |
| Continue an existing chat | The original UUID contains the next message and `WORKBUDDY-CONTINUE-OK`. |
| Models | 19 actual UIA options were read. GLM-5.3-Flash and Space-Bunny were selected; Deepseek-V4-Pro required standard ScrollIntoView. |
| Single question | Native AskUserQuestion result records `验收饮料？ → 茶`, followed by `WORKBUDDY-DRINK-OK`. |
| Two pages | Native result records `验收布局？ → 竖屏` and `验收主题？ → 深色`. |
| Custom answer | Native result records `验收备注？ → 手机输入备注`. |
| Stop | Public Stop produced the native `Interrupted by user` record. A later message and its questions continued in the same chat. |

The implementation handles asynchronous tab mounting, sidebar waiting-state labels, offscreen
model options, native cancellation widgets, an open model dropdown before typing, and choices
disabled by an entered custom answer. It preserves unrelated drafts and rechecks the exact app,
window and native conversation before input. Phone aliases are consumed before a decision;
uncertain actions are never automatically replayed.

All acceptance writes used isolated synthetic chats. Existing user chat files and the WorkBuddy
SQLite database were read without modification by the bridge.

## Other features and limits

Codex ordinary history, native model/project catalogs, new chats and continuation use the desktop
app's own app-tools connection. Stop, permissions and structured questions have an opt-in stdio
proxy and dedicated `Start-FullControl.cmd` launcher. The user deferred restarting Codex, so actual
Codex full-control activation and its end-to-end acceptance remain outstanding.

WorkBuddy command approvals offer only Allow once or Reject when a complete native command card
and exact workspace match. Its native Run/Skip/Reject layout and Chinese labels are supported;
Skip and persistent permission choices are not phone actions. The benign print and loopback-read
tests were automatically allowed by the app, so genuine native approval clicks remain unverified.

WorkBuddy's installed New Task accessibility view has no verified workspace picker. New chats use
the desktop-selected workspace. Its genuine existing workspace paths can filter history; project
or cwd overrides fail before text is written. Codex and DSH retain their own project selection.

The public Android shell is version 1.1.0 and loads hosted UI assets at runtime. Browser inspection
and public API checks do not establish physical Android installation or touchscreen acceptance.
Administrator and ordinary paired-user scopes remain distinct, with administration audit records.

Private credentials, desktop chat archives, proprietary application sources and runtime descriptors
are excluded from Git and the Windows ZIP. Release checks compare shipped runtime files against
the reviewed source allowlist and scan for the exact local secret values without printing them.

Windows bridge 1.1.1 is delivered at `/downloads/AI-Remote-Windows-1.1.1.zip` and the canonical
`/downloads/AI-Remote-Windows.zip`. The relay's download whitelist includes only these naming
forms in addition to APKs; unrelated ZIPs, hidden files, symlinks and traversal attempts remain
unavailable. Both platform downloads are checked against their reviewed package sizes and SHA-256.
Validated release downloads have a bounded ten-minute write deadline, independently of the relay's
ordinary 90-second response limit, so slow connections can receive the full Windows package.
