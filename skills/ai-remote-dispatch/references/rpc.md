# Shared RPC controls

The helper `rpc` command sends `POST /api/fleet/rpc` with the selected computer UUID and this caller's desktop Bearer credential. Every registered user can call every registered computer when `sharedTools:true`. Paired phone cookies are also accepted by the fleet API. Administrator cookies alone do not authenticate fleet calls. `/api/admin/*` remains administrative; the existing `/api/rpc` remains bound to the paired phone's original computer.

Use `node <absolute-skill>/scripts/remote-ai.cjs rpc --computer <UUID> --method <method> --params-file <absolute-JSON>`. Input files hold the **params object only**, not an outer method or clientId envelope. Each request stays with the exact selected computer, even when it disconnects. There is no shell passthrough and no mutation retry.

| Method | Params |
|---|---|
| `sessions.list` | `{}` or `{"tool":"workbuddy"}` |
| `models.list` | `{"tool":"dsh"}` |
| `session.read` | `{"tool":"workbuddy","sessionId":"<native-id>"}` |
| `session.send` | `{"tool":"workbuddy","sessionId":"<native-id>","text":"<brief>"}` |
| `session.stop` | `{"tool":"workbuddy","sessionId":"<native-id>"}` |
| `session.create` | `{"tool":"dsh","model":"<catalog-id>","provider":"<catalog-provider>","projectId":"<catalog-project-id>","text":"<brief>","requestId":"<fresh-uuid-v4>"}` |
| `session.answer` | `{"tool":"workbuddy","sessionId":"<native-id>","callId":"<pending-question-callId>","answers":[{"id":"<question-id>","selected":["<exact-option-label>"]}]}` |
| `session.approve` | `{"tool":"workbuddy","sessionId":"<native-id>","approvalId":"<pending-approval-id>","decision":"allow-once"}` or `"reject"` |

For new chats prefer `ask`, which journals the request before writing. `session.send` may include `model`, `provider` (required when changing DSH model) and `reasoningEffort`, validated against the target's model catalog. Codex/WorkBuddy do not accept provider. Optional create `cwd`, `projectId` and effort must describe the target computer's actual project and model. Never invent options or use the caller's paths blindly.

`session.read` returns messages, status, `canStop`, optional `currentModel`, `activeTurnId`, `historyTruncated`, `pendingQuestions` and `pendingApprovals`. Tool availability does not imply every action is supported: inspect the roster's common method capability and per-tool override (explicit false wins). CLI-created WorkBuddy chats live in the workbench and are not automatically added to the desktop sidebar.

Question answer details come from the live `pendingQuestions` object: each batch has `callId` and `questions`, with native IDs, option labels, `multiSelect` and `allowCustom`. Each answer uses `id` and `selected` (an array of exact option **labels**, not invented option IDs). For free text use `custom` with `selected:[]` if allowed. Answer every question in the batch. Do not answer an approval using the question method or treat a text response as permission.

Approval receipt `state:"submitted"` is weaker than `"confirmed"`. Re-read the target. A disappearing item can mean someone else answered; do not infer which decision won. Rejected/unknown/expired handles and offline tools remain failures; do not fall back to another computer or UI automation.

Audits contain source identity, target computer, method, outcome and timestamp. Chat contents and credential material are not logged by the shared handlers. The relay must be HTTPS with the configured Origin; the helper refuses redirects and does not offer an insecure TLS option.
