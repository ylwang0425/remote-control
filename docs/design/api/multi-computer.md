# Multiple computers and administrator access

This extends the version 1 wire protocol. The desktop, relay and mobile workers
implement separate file territories; root owns this contract and integration.

## Identity and enrollment

- `clientId` is a persistent canonical UUID identifying one installed computer.
- `ownerName` is a trimmed, control-free display name of 1–64 characters. It is
  a label; it never authenticates a user or grants administrator access.
- `clientName` is the computer label. Repeated names remain distinct computers.
- The private desktop configuration contains the persistent UUID, display name
  and desktop credential. No credential is sent to the local page or Git.
- Existing `bridgeToken` authentication is restricted to one durably pinned
  bootstrap computer. Subsequent enrolled computers receive independent random
  tokens. A valid token cannot claim another computer's UUID.

An authenticated administrator creates an invitation using
`POST /api/admin/enrollment-codes {}`. Its successful result contains `code`
and `expiresAt`. The secure code is single use and expires after ten minutes.

The trusted local desktop page collects name, server address and invitation.
The native bridge submits `POST /api/desktop/enroll` with:

```json
{"code":"<one-use invitation>","clientId":"<UUID>","ownerName":"<name>","clientName":"<computer>"}
```

This native endpoint requires absence of a browser Origin, bounded bodies and
rate limiting. Success uses the existing envelope with result
`{"clientId":"<UUID>","bridgeToken":"<new private credential>"}`. The bridge
stores the credential privately and connects by authenticated WSS.

Desktop hello adds optional `clientId` and `ownerName`. Old bootstrap clients
without them can use the pinned bootstrap identity. New enrollment requires a
valid nonblank name. The configured tool IDs are `codex`, `dsh`, `workbuddy`.

## Pairing and routing

Pairing codes and phone sessions persist the originating `clientId`. User
`POST /api/rpc {method,params}` always uses the authenticated phone's binding.
It cannot choose another computer. Older sessions migrate only to the pinned
bootstrap computer; new unbound sessions cannot invoke global load balancing.

Administrator `POST /api/admin/rpc {clientId,method,params}` uses exactly that
target. Offline and busy targets fail explicitly, with no rerouting to another
computer. Inbound bridge responses must match both request ID and originating
connection. A reply from computer B cannot resolve computer A's pending call.

## Administrator authentication and roster

The administrator uses an independent username and salted password hash. The
password KDF uses at least 210,000 PBKDF2-HMAC-SHA256 iterations or a reviewed
equivalent. Login is rate limited before expensive verification. Administrator
sessions use a hashed server-side token and `rc_admin`, an HttpOnly, Secure,
SameSite=Strict cookie with an eight-hour lifetime. Login and mutations retain
the existing exact-Origin policy. Username/name alone never grants this role.

| Endpoint | Input or successful result |
| --- | --- |
| `POST /api/admin/login` | `{username,password}`; establishes admin cookie |
| `POST /api/admin/logout` | `{}`; invalidates admin session and cookie |
| `POST /api/me {}` | `{role:"user"|"admin",clientId?,ownerName?,clientName?,online?}` |
| `POST /api/admin/computers {}` | `{computers:[{clientId,ownerName,clientName,online,lastSeen,capabilities,tools}]}` |
| `POST /api/admin/rpc` | `{clientId,method,params}`; existing RPC result envelope |

Each `tools` item is `{id,available,reason?}`. The optional hello capability
`toolStatus` maps at most the three known IDs to `{available,reason?}` with a
safe reason of at most 500 characters. Explicit status takes precedence over
legacy membership in `capabilities.tools`. Installed software with no native
control API is visible as unavailable with its explanation.

These two read endpoints accept strict empty-object POST requests so browsers
send their own Origin header. Both require the same exact-Origin policy as
mutations. GET remains available for native clients supplying an Origin; a
missing or foreign Origin is refused. There is no client-supplied Origin bypass.

An administrator sees persisted offline computers as well as online ones.
Ordinary phones see only their paired computer. SQLite migrations preserve
existing pairings and audit data. Audit records include actor, target, method
and outcome metadata; they never include chats, passwords or tokens.

## Phone state and native decisions

Phone caches, drafts, model/project catalogs, expanded tools and pending native
decisions are scoped by computer ID. Switching targets invalidates old requests
and discards late replies. Identical session/project/model IDs on two computers
must not mix state or send a decision to the wrong native request.

`session.answer` and `session.approve` retain their existing shapes. Approval
decisions remain `allow-once` or `reject`, with honest `submitted`/`confirmed`
receipts and no automatic retries. Every displayed question/approval must come
from an actual native event. Unsupported tools advertise false capability bits.
No CLI session is substituted for an already-open desktop conversation.
