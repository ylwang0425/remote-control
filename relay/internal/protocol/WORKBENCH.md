# The mobile workbench surface, as the relay sees it

This file is the relay's own record of the additive wire contract it now
enforces. It is written for whoever next has to change one side of the seam, so
it states what the relay **checks**, what it merely **forwards**, and what it is
deliberately **not** allowed to decide.

The protocol version stays `version: 1`. Two new methods, new optional fields,
new optional `capabilities` keys and three new error codes are additive: an
older desktop is not shut out and an older phone keeps working.

## 1. What is new

| Thing | Kind |
| --- | --- |
| `session.answer` | new method |
| `session.approve` | new method |
| `sessions.list` → `sessions[].needsInput` | new optional boolean |
| `session.read` → `pendingQuestions` | new optional array |
| `session.read` → `pendingApprovals` | new optional array |
| `capabilities["session.send:model:<tool>"]` | new optional boolean |
| `capabilities["session.answer:<tool>"]` | new optional boolean |
| `capabilities["session.approve:<tool>"]` | new optional boolean |
| `answer_not_open`, `approval_unknown`, `project_conflict` | new error codes |

Everything that existed before keeps its name, shape and meaning. The four
original methods are untouched; `session.send`'s three optional model fields and
`session.read`'s `currentModel`, `historyTruncated` and `sessions.list`'s
`capabilities` passthrough behaviour are unchanged.

## 2. `session.answer`

```
params  {tool, sessionId, callId, answers:[{id, selected:[string], custom?}]}
result  {accepted:true, sessionId, callId}
timeout 30000
```

Rules the relay enforces:

- `tool` is required and is `codex` or `dsh`; `sessionId` matches the §4.1
  session id shape; `callId` is a required bounded string.
- At most **8** answers; each needs a non-blank `id` of at most 128 characters,
  and an `id` may appear **once**. A duplicate id would either answer one
  question twice or silently drop one of the two.
- `selected` is a required array of at most **12** labels, each non-blank, at
  most 500 characters, and **unique within its own answer**. A repeated label is
  a client bug, not a multi-select answer.
- `custom` is optional, at most 1000 characters, and must be printable.
- An answer with an empty `selected` **and** no `custom` is refused. So is an
  empty batch: "answer nothing" is not an answer.
- The whole batch is bounded as well as each member; an oversized batch is
  `too_long`/`invalid_params` rather than a partial submission.

The relay does **not** know which questions are genuinely open. That map lives
on the computer. What the relay guarantees is that a malformed, duplicated,
oversized or unrepresentable batch never reaches the desktop, so a live form
cannot be half-answered through this seam.

## 3. `session.approve`

```
params  {tool, sessionId, approvalId, decision:"allow-once"|"reject"}
result  {accepted:true, sessionId, approvalId, state:"submitted"|"confirmed"}
timeout 30000
```

- `approvalId` must have the canonical UUID shape. It is checked
  **version-agnostically**: it is minted by the desktop's own gateway, so
  forcing v4 would reject a genuine event id from a host that mints another
  version.
- **Known seam divergence.** The desktop's own validator
  (`desktop/src/protocol.js`, `UUID_V4`) requires a lower-case **v4**
  specifically, which is stricter than this relay's check. The desktop's check
  is therefore the binding one and it runs first, so the relay's looseness
  cannot admit anything the desktop would have taken. The reverse direction is
  the one to watch: if the real gateway ever mints a non-v4 event id, the
  desktop will refuse its own genuine request. That is a desktop-side assumption
  to verify against the real gateway, not something the relay may paper over. If
  it turns out to hold, the desktop's check should be relaxed, not this one
  tightened.
- `decision` is a closed two-value set. There is deliberately **no**
  `allow-always`, no policy edit and no blanket approval. An unrecognised
  decision is refused rather than rounded to the one that grants access.
- The relay never validates that the id is *currently pending*. It cannot — the
  live map of event ids belongs to the desktop — so a stale, cancelled or
  already-answered request is the desktop's refusal to make, and it makes it
  explicitly with `approval_unknown`.

### `submitted` is a transport receipt, never a grant

`state:"submitted"` means the desktop accepted responsibility for handing the
decision to its gateway. It is **not** proof that the submission won, and it is
**not** proof that permission was granted: another client — the person at the
computer — may have answered first, and the gateway still returns success to the
loser.

Consequences the relay enforces:

- `confirmed` is passed through **only** when the desktop itself sends it, which
  means the desktop read a real native audit of the outcome. No layer of the
  relay promotes `submitted` to `confirmed`.
- Any third state value is `bridge_bad_response`. `null`, absent and empty are
  all refused, because "unknown" must not be displayable as either state.
- The relay never retries an approval. Exactly one frame per explicit human
  click reaches the desktop.

## 4. `session.read` projections

### `pendingQuestions`

```
[{callId, state:"open"|"continued",
  questions:[{id, question, header?, detail?,
              options?:[{label, description?}], multiSelect?:boolean}]}]
```

Bounds: at most **4** batches, **8** questions each, **12** options each;
`question` ≤ 1000, `header` ≤ 200, `detail`/`description` ≤ 1000, `label` ≤ 500
characters. Every question needs a non-blank `id` and `question`; every option a
non-blank `label`. `state` must be one of the two the relay can present as
answerable. `null` is refused — an absent projection means "nothing to offer",
`[]` means "I looked and there is nothing pending", and `null` must not be
readable as either.

### `pendingApprovals`

```
[{id, toolName, callId?, reason?}]
```

Bounds: at most **8**; `id` is a canonical UUID, `toolName` ≤ 128 and
non-blank, `callId` ≤ 128, `reason` ≤ 4000 characters. `toolName` is what the
person is being asked to permit, so a request whose tool name cannot be shown is
refused rather than turned into a button.

The two projections are **separate on purpose**. A security permission approval
and an AI's ordinary clarifying question are different native events with
different transports and very different consequences. Rendering one as the other
is how a phone ends up telling someone they answered a permission prompt when
they merely chose a chat option. `session.approve` never answers a question and
`session.answer` never answers an approval.

Both projections are scanned for native transport names (`clientId`,
`connectionId`, `host`, `home`, `token`, `secret`, `cookie`, `authorization`,
`request`, `raw`, `args`, `envelope`), compared case-insensitively at any depth.
An object carrying an unknown field is otherwise passed through untouched — that
is the additive rule everywhere else — so the one thing that must not pass
through is a field that leaks native machinery to a phone.

### `needsInput`

An optional boolean on each session summary. `null` is refused, because accepting
it would turn "the desktop cannot tell" into "nothing is pending" — the one
reading that silently hides a question waiting for the user. The relay neither
infers nor defaults it; the phone's badge derives from this field alone, and a
desktop that cannot tell simply omits it, which the phone renders as no badge.

## 5. Capabilities

`capabilities` is still passed through **verbatim** — never merged, never
inferred, never defaulted, never given a bit the desktop did not send. The relay
does not consult these keys to gate anything: the desktop owns that, and the
phone renders from the desktop's own declaration.

- `session.send:model:codex` / `:dsh` — a model choice can ride a send.
- `session.answer:codex` / `:dsh` — a real pending question can be answered.
  DSH has a native answer call; Codex has none, so a capable desktop declares
  `:dsh` only.
- `session.approve:codex` / `:dsh` — a genuine native permission request can be
  answered. Same split.

When a capability is false or absent, the phone shows the **actual** pending
information plus a clear instruction to act at the computer. It does not show a
button, and it does not pretend.

## 6. The doors that do not exist

Neither new method accepts any field outside the two listed above. There is no
`method`, no `rpc`, no `command`, no `argv`, no `shell`, no `outcome` envelope,
no `clientId`/`eventId` passthrough, no `policy` and no `callerSource`. An extra
field is `invalid_params`, and the request never reaches the desktop.

That is the whole point: `session.answer` and `session.approve` each name
**one** operation the desktop chose to support. Neither is a generic transport
onto the desktop's native RPC surface, and there is no shell or command
execution surface anywhere in the relay.

## 7. What the relay cannot and does not verify

Recorded so nobody mistakes a green relay test for a working feature:

- which projects are genuine (the native project list lives on the computer);
- whether a chosen model/provider/effort pair really exists in the native
  catalogue (the relay checks shape and combination rules only);
- whether a question is genuinely open, or a permission request genuinely
  pending (the live maps live on the computer);
- whether an approval submission won its race, or whether permission was really
  granted (`submitted` is a receipt; `confirmed` requires the desktop's own
  native audit);
- whether a `currentModel` report matches what the session will really use next
  (the desktop reports its native state or omits the field).

A `session.create` may carry both `projectId` and `cwd`. The relay deliberately
does not compare them: it has never seen the project catalogue, so a comparison
here would be a guess, and refusing a legitimate create would be worse than
forwarding it. The desktop owns that check — it validates the selected
`projectId` against its fresh native list and refuses a `cwd` that contradicts
that project's own cwd **before** anything native is created, then sends the
native create request with `workspaceId` only.

## 8. Test scope and its limits

`internal/protocol/sessionflow_test.go` and `sessionresult_test.go` check the
rules and bounds. `internal/server/workbench_test.go` drives real HTTP into the
relay, real WebSocket frames out to a real bridge connection, and the real
answer back: model-carrying sends, pending projections, the answer round trip,
the approval receipt, stale-refusal paths, and the proof that nothing is retried.

These tests can and do prove that the relay forwards exactly what it was given,
refuses what it cannot represent, and makes no claim it is not entitled to.
They **cannot** prove that a real native chat answered a real question or
granted a real permission. That is verified against live native chats and the
shipped DOM, by whoever owns that seam.

The suite has not been run under `-race`: this Windows toolchain has no cgo C
compiler, so `go test -race` cannot build here. The bridge-side recorder in
`workbench_test.go` is nonetheless mutex-guarded, and exactly one goroutine ever
reads a bridge WebSocket connection (`coder/websocket` forbids concurrent
reads).
