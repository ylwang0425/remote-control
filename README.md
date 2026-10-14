# AI Remote — mobile AI workbench

An Android workbench for the Codex Desktop and DSH Desktop chats running on your Windows computer, with native WorkBuddy control in the same viewer. Continue existing conversations, create chats in registered projects, choose real models and inspect execution status from your phone.

[中文说明](README.zh.md)

## Features

- Chats, tasks and settings; search, tool/project filters, pinned chats and system/light/dark themes.
- Continue the original desktop chat. Create a chat by choosing a tool, an existing project, a model and reasoning effort.
- Choose the model for the next message within a chat, using the desktop's current model catalog.
- Markdown headings, tables, code blocks and copying; folded tool activity with expansion preserved during polling.
- DSH stop and native question answering, including questions nested inside tool execution. Permission controls appear only for actual pending native events.
- Stable drafts, focus and cursor position while polling; mobile layouts keep controls reachable in shorter viewports.
- Named computers with persistent IDs and independent, one-use desktop enrollment invitations.
- Separate administrator login and a roster of online/offline computers and their available tools. Administrators explicitly select a target; ordinary phones remain bound to their paired computer.
- WorkBuddy local conversations and messages share the same workbench viewer, including Markdown and folded tool activity. History reads preserve the desktop's current chat and minimized state. Its own local product cache supplies model options without opening the desktop selector. Optional native Windows UI Automation supports creation, continuation, model selection, questions and Stop.

## Architecture

```text
Android WebView / mobile browser
            | HTTPS
Go relay + SQLite + Caddy (public server)
            | outbound WSS initiated by the computer
Windows Node.js bridge
            | local named pipe / loopback HTTP
Codex Desktop / DSH Desktop
```

The AI tools execute on the computer. The relay forwards a fixed RPC allowlist and stores device authentication hashes and audit metadata; it does not persist chat transcripts. The computer needs no inbound public port.

| Directory | Contents |
| --- | --- |
| `mobile/web` | Canonical mobile HTML, CSS, JavaScript and bundled Markdown libraries |
| `mobile/android` | Java Android WebView shell and APK build script |
| `desktop` | Node.js bridge, local pairing page, adapters, tests and portable ZIP builder |
| `relay` | Go relay, SQLite storage, protocol validation and Linux deployment scripts |
| `qa` | Independent relay acceptance tests |
| `docs` | Original protocol and design decisions |

`relay/web` is the deployment copy of `mobile/web`. Keep both byte-for-byte identical when changing the UI.

## Run the Windows bridge

Prerequisites: Node.js 22 or later, and the relevant desktop tool already running and signed in. No npm dependencies are needed.

For normal enrollment, start the bridge and open [its local page](http://127.0.0.1:18989/). Enter your name, relay address and the administrator's one-use invitation. The bridge stores its independent credential in `%USERPROFILE%\.dsh\ai-remote-desktop.json`; the page never receives it.

The first bootstrap computer may instead use the relay's initial private credential:

```json
{
  "relayUrl": "wss://101.43.98.18/bridge",
  "bridgeToken": "<token generated on your relay server>",
  "tools": ["codex", "dsh"]
}
```

Never commit the populated configuration. `AI_REMOTE_CONFIG` can select another file; `AI_REMOTE_BRIDGE_TOKEN` and `AI_REMOTE_RELAY_URL` override its corresponding values.

```powershell
node desktop/src/index.js --self-check
node desktop/src/index.js
```

Save the computer name, enroll it, generate a one-use pairing code and enter it on the phone. Keep the bridge and desktop AI applications running. The bootstrap credential is durably pinned to one computer; additional computers enroll with independent credentials.

A bridge started from Explorer can discover its calling context from the current user's local Codex metadata index in read-only mode. It selects an existing desktop user thread without creating a chat or reading transcript content; explicit configuration keeps precedence. Discovery requires Node 22.13+, included in the portable package. Unsupported indexes or missing local chats produce a setup explanation.

## Administrator and multiple computers

Initialize the first administrator on the server with `ai-remote-relay --init-admin --config /etc/ai-remote-relay/relay.json --admin-username admin`, providing an independent password on stdin. The command refuses to overwrite an existing administrator and stores only a salted PBKDF2-SHA256 verifier (310,000 iterations); passwords are not command-line arguments.

Choose administrator login on the mobile login screen. The roster groups computers by display name, shows online/offline status and tool availability, and creates one-use desktop enrollment codes that expire after ten minutes. Names are labels; persistent IDs distinguish computers with the same name.

Phone pairing binds to the originating computer. Administrator RPCs require the exact target ID and fail when it is offline. Chat state, drafts, model catalogs, questions and approvals are isolated by computer. Audits record actor, target, method and outcome without transcript content. See [the protocol extension](docs/design/api/multi-computer.md).

## Tests

From the repository root, with Node.js 22+ and Go 1.27:

```powershell
node --test desktop/test
node --test "mobile/tests/*.test.js"
Push-Location relay
go test ./... -count=1
Pop-Location
```

Without local Android signing material, the release-secret leakage check explicitly skips. All source guards still run. Once a signing password exists in `mobile/.private/keystore.pass`, that check reads it locally and enforces its full leakage assertions.

The `qa/T-relay` acceptance suite needs a relay binary built for the test host. It also needs a locally built Android APK at `mobile/dist/AI-Remote-Android.apk` for the download-whitelist case. On Windows:

```powershell
Push-Location relay
go build -o dist/ai-remote-relay-windows-amd64.exe ./cmd/ai-remote-relay
Pop-Location
Push-Location qa/T-relay
go test ./... -count=1
Pop-Location
```

## Build and deploy

Build a portable Windows ZIP using an official Windows Node.js runtime:

```powershell
node desktop/scripts/pack.mjs --node C:/path/to/node.exe
```

The result is `desktop/dist/AI-Remote-Windows.zip`, with a runtime and `Start-AI-Remote.cmd`; packaging uses a file allowlist.

Build the Linux relay on Windows:

```powershell
$env:GOOS = 'linux'
$env:GOARCH = 'amd64'
$env:CGO_ENABLED = '0'
Push-Location relay
go build -trimpath -o dist/ai-remote-relay-linux-amd64 ./cmd/ai-remote-relay
Pop-Location
Remove-Item Env:GOOS,Env:GOARCH,Env:CGO_ENABLED
```

See [install-centos.sh](relay/deploy/install-centos.sh) for deployment parameters and [relay.json.template](relay/config/relay.json.template) for configuration. Generate the real server configuration with `--init`; never publish its token. Caddy terminates TLS, and the relay listens on loopback. The supplied deployment targets `101.43.98.18` and uses automatic renewal for its IP certificate. Adapt the address and origin consistently when deploying elsewhere.

To rebuild Android, provide JDK 17 (the script currently uses `D:/env/jdk17`), Android platform 35 and Build Tools 35.0.0 under `mobile/.tools/sdk`, plus your own signing key and password under `mobile/.private`. Then run `pwsh -File mobile/android/build-apk.ps1`. Signing material and SDK downloads are deliberately absent from Git. A newly generated signing key cannot update an APK signed by another key.

## Current verification and limits

The delivered workbench was checked against real desktop chats: Codex project creation and a next-message model change, DSH cancellation of a running turn, and answering a real nested DSH question. Layout checks used 360/390/430-pixel browser frames and shorter viewport simulations.

- Codex's app-tools connection supports listing, reading, project creation and sending. Native Stop, structured questions and approvals use the opt-in `Start-FullControl.cmd` launcher. The user deferred restarting Codex; real full-control activation remains unverified.
- Codex reads the native recent-ten-turn window, with additional protocol message/frame limits; this is not a complete history export.
- DSH model selection also changes its native default for future chats.
- The native permission submission path has automated coverage; a real manual permission approval has not been exercised on this machine's current approval settings.
- WorkBuddy reads the current Windows user's `.workbuddy/workbuddy.db` local session metadata and project JSONL transcripts. `WORKBUDDY_CONFIG_DIR` or private `workbuddy.configDir` can select the operator's data root. The native database is never modified; cloud records and unknown account runtime buckets are not substituted. Byte, message and frame limits report truncation honestly.
- WorkBuddy 5.7.7 native creation, continuation, next-message model selection, single/two-page/custom-text answers and Stop have been verified against its own saved messages through the public relay. Its actual model catalog contains 19 options. The opt-in launcher uses standard Windows accessibility and keyboard input, preserving unrelated drafts and checking the exact native chat before each action.
- WorkBuddy native command cards support Allow once and Reject; benign tests were auto-allowed by the app, so real approval clicks are still unverified. Its installed New Task view exposes no verified workspace picker; new chats use the desktop-selected workspace. Existing native directories remain available for filtering.
- Desktop bridge 1.1.4 adds WorkBuddy background CLI creation, continuation of original desktop chats, existing-project selection, per-message models, questions, one-time approvals and Stop. Enable it with the official login on the computer's local settings page. CLI-created chats are managed in the mobile workbench and saved locally; the WorkBuddy desktop sidebar does not automatically list them. Android shell 1.1.0 loads the hosted UI independently. See the [background acceptance record](docs/acceptance/workbuddy-background-2026-10-14.md).
- Desktop bridge 1.1.5 selects WorkBuddy's dedicated lite CLI bundle before the vendor's fallback bundles. A CLI startup failure is reported as a bridge failure, without claiming that the native conversation has ended.
- Desktop bridge 1.1.6 reads WorkBuddy's native recent-workspace table and the current account's selected new-task workspace, including folders with no chat yet. Opening the WorkBuddy creation panel refreshes these projects instead of reusing an old project list.
- Physical Android installation, the real keyboard and device safe areas remain unverified.

Credentials, native tool extracts, logs, deployment records, binaries and signing keys are excluded from this source repository. Bundled browser-library notices are in [mobile/web/vendor](mobile/web/vendor/README.md).
