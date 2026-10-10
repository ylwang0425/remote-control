# AI Remote — mobile AI workbench

An Android workbench for the Codex Desktop and DSH Desktop chats running on your Windows computer. Continue existing conversations, create chats in registered projects, choose real models and inspect execution status from your phone.

[中文说明](README.zh.md)

## Features

- Chats, tasks and settings; search, tool/project filters, pinned chats and system/light/dark themes.
- Continue the original desktop chat. Create a chat by choosing a tool, an existing project, a model and reasoning effort.
- Choose the model for the next message within a chat, using the desktop's current model catalog.
- Markdown headings, tables, code blocks and copying; folded tool activity with expansion preserved during polling.
- DSH stop and native question answering, including questions nested inside tool execution. Permission controls appear only for actual pending native events.
- Stable drafts, focus and cursor position while polling; mobile layouts keep controls reachable in shorter viewports.

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

Create `%USERPROFILE%\.dsh\ai-remote-desktop.json` locally:

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

Open [the local pairing page](http://127.0.0.1:18989/), generate a one-use pairing code and enter it on the phone. Keep the bridge and desktop AI applications running.

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

- Codex's current app-tools interface supports listing, reading, creating and sending. It exposes no stop, question-answer or permission-approval tool to this bridge, so those controls report the limitation.
- Codex reads the native recent-ten-turn window, with additional protocol message/frame limits; this is not a complete history export.
- DSH model selection also changes its native default for future chats.
- The native permission submission path has automated coverage; a real manual permission approval has not been exercised on this machine's current approval settings.
- Physical Android installation, the real keyboard and device safe areas remain unverified.

Credentials, native tool extracts, logs, deployment records, binaries and signing keys are excluded from this source repository. Bundled browser-library notices are in [mobile/web/vendor](mobile/web/vendor/README.md).
