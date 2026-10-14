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
