# CRD 0006 — 跨端扩展接口：models.list + session.create（用户已授权新建与模型选择）

> 撰写：PM（seam owner）｜ 日期：2026-10-08 ｜ 状态：**accepted —— 用户明确授权，协调者给出裁决**
> 权威文档：`docs/design/api/protocol-v1.md` **v4**（架构角色据此更新）。本文件是**过渡期的唯一口径**，
> 三个 owner 在 v4 落地前按本文件实现；v4 落地后以 v4 为准，两者必须逐字一致。

## 谁提出的

**用户**。原契约 §3 硬不变量有一条"手机不能新建会话"，**用户已明确覆盖该限制**。
协调者补充了字段级裁决。

## 用户要什么

1. **Markdown 必须渲染展示**（不能显示原始 Markdown 源文）。
2. **工具调用 / 执行结果折叠**成类似 Codex / DSH 的"活动块"，**默认折叠**。
3. **新建会话**：手机能选**工具（Codex/DSH）**与**真实模型**，并且**必须实际创建到桌面端同一应用里的新会话**，
   **不是**命令行另起 CLI 那种"另建"。
4. 继续完整交付 Android + Windows + server。
5. `flash-only` / **不 commit、不 push、不 publish** 不变。
6. 所有产品代码由**正式 crew_engineer** 实现，**不许 PM 用 shell 绕过**。

## 一、`models.list`

### 字段定稿（**只有这一套，不得出现第二套**）

`result.models[]` 的字段**就是**：`id, label, provider?, isDefault?, reasoningEfforts?, defaultReasoningEffort?`；顶层另有可选 `projects?:[{id,name,cwd}]`。

- **是 `isDefault`，不是 `default`**。
- **没有 `thinking` 这个返回字段**：`thinking` **只是 Codex `create_thread` 的入参名**，在契约里它只作为 `reasoningEffort` 的**映射目标**出现在括号说明里。
- `provider` **仅 DSH 有**；`isDefault` 省略等价于 `false`；`defaultReasoningEffort` 应当是 `reasoningEfforts` 的成员。

**请求**：`POST /api/rpc`，`{"method":"models.list","params":{"tool":"codex"|"dsh"}}`

**结果**（`ok:true`）：
```json
{
  "tool": "codex",
  "models": [
    { "id": "<真实 modelId>", "label": "<人类可读名>",
      "provider": "<DSH providerId，仅 DSH 有>",
      "isDefault": true,
      "reasoningEfforts": ["low","medium","high"],
      "defaultReasoningEffort": "medium" }
  ],
  "projects": [ { "id": "<真实 projectId>", "name": "<名字>", "cwd": "<绝对路径>" } ]
}
```
- `id`、`label` **必填**；`provider` 仅 DSH 必有（providerId 来自本机 DSH 目录）；
- `isDefault`、`reasoningEfforts`、`defaultReasoningEffort` 可选；`projects` 可选数组。
- **catalog 字段的唯一合法来源**：**真实本机 DSH 目录**，或 **Codex 当前 `create_thread` 的真实 schema**。
  **禁止**从网页硬编码、凭记忆、或猜测补一份模型清单。**没有目录就返回空数组**，不许假填。

### 两条现场实证（2026-10-08，root 实测；决定实现方式）

1. **DSH**：`modelCatalog` 是**无参数**方法 —— 调用形状 `args:{}`（**不是** `args.request`/`args._request`）。
   模型选择是 **`provider + model` 联合**；**DSH 的 `create` 本身没有 `model` 参数**，因此实现顺序是
   **`session/create` → `selectModel`（provider+model+reasoningEffort）→ 可选的首条 `prompt`**。
   这正是"部分成功"规则的三个落点：**create 之后的任何一步失败，都必须把已创建的 `sessionId` 交给手机**。
2. **Codex**：`tools/list` 里 `create_thread` 的 **`inputSchema.properties.model.description`** 实际**带着本机支持的 modelIDs 与 reasoning efforts**（现场 **7 项**，形如 `gpt-6.1-sol` / `gpt-6-astra`）。
   因此 **Codex 的 catalog 应当从这份实时 schema 派生**，`reasoningEfforts` / `defaultReasoningEffort` 同样来自它；创建时 `create_thread` 带 `model` + `thinking`（由 `reasoningEffort` 映射）。
3. **`create_thread` 的禁令已按用户明确授权解除**：它**只允许在"新建会话入口"这一条路径上调用**；
   **fork / worktree 仍不在需求内，继续禁止**。


**工具不可用**（应用没开/适配器未连）：**不是错误**，返回
```json
200 {"ok":true,"result":{"tool":"codex","models":[],"reason":"<安全文本>"}}
```
（沿用 §9.5 判例：表现为"连上了但没有模型"，而不是"连不上"。）

## 二、`session.create`

**请求**：
```json
{"method":"session.create","params":{
   "tool":"codex"|"dsh", "model":"<来自 models.list 的 id>",
   "provider":"<DSH 必需：providerId>",
   "reasoningEffort":"<可选，取自 reasoningEfforts>",
   "cwd":"<可选，绝对路径>", "projectId":"<可选>",
   "text":"<可选，首条消息>",
   "requestId":"<UUID v4，去重用>"
}}
```

**结果**（`ok:true`）：
```json
{ "sessionId": "<新会话真实 id>", "tool": "codex", "title": "<可选>",
  "model": "<回显>", "provider": "<可选>", "reasoningEffort": "<可选>" }
```

### 铁律（逐条，实现必须遵守）

0. **`params` 就是这八个字段**：`{tool, model, provider?, reasoningEffort?, cwd?, projectId?, text?, requestId}`。
   - **`requestId`（小写 UUID v4）必填**，是**创建去重键**。
   - **`provider` 对 `tool:"dsh"` 必填、对 `tool:"codex"` 不得出现** —— 同**一个 `model` id 在 DSH 上可能同时存在于多个 provider**（实测同一 ID 有 3 个 provider），**不传 `provider` 就丢路由、落到不确定的那个**。它**不是**可选的展示字段。
   - **`reasoningEffort` 允许提交**（**不是**只读展示字段）：取值必须是该模型 `reasoningEfforts` 的成员，**电脑侧必须对真实 catalog 校验**，不在集合里 → `invalid_params`。
     **映射（写死）**：Codex → `create_thread` 的 **`thinking`**；DSH → **`selectModel` 的 reasoningEffort**。

1. **必须落在"电脑上那个桌面应用"里** —— **不得**在命令行另起 CLI/appserver 充当新会话。
   - Codex：用 app-tools 的 **`create_thread`**（真实桌面线程，支持 `model` / `thinking`）。
   - DSH：用正式 **`session/create`**。
2. **Codex 项目只选真实 `local/list_projects` 的 ID**；**禁止** worktree、**禁止** cloud。
3. **DSH 创建后要 `selectModel` 再 `prompt` 一次**。
4. **已创建但后续步骤失败**（例如 selectModel/prompt 失败）：**必须报告已创建出来的 `sessionId`**，
   **禁止**盲目重试（用户要知道"已经建了一个"）。
5. **`requestId` 用于 create 去重**：desktop **至少要持久记录**它；做不到持久就**明确返回"结果未知"**，
   并且**不自动重建**。
6. **闭环**：创建成功后该会话必须能被 `sessions.list` 看到、能被 `session.read` 读到，
   `sessionId` 与 `sessions.list` **同一 id 空间**。
7. **首条消息 `text` 只发一次**，失败不自动重发。
8. **默认模型项**：只有当**本机原生默认已被确认**时才允许使用默认项；否则必须显式 `unsupported`。
   **不支持 / 无目录 → 明确 `unsupported`，不许假填。**

### 错误码（新增三个，HTTP **200**，与 `unknown_method` 同列）| 码 | 触发 |
| --- | --- |
| `tool_unavailable` | `tool` 当前不可用（应用没开/适配器未连） |
| `model_not_available` | `model` 不在该工具 `models.list` 的 `id` 集合里（含 DSH 缺 `provider` 的情况） |
| `session_create_failed` | 上游创建/配置失败，`message` 为安全文本 |

`cwd` / `projectId` 格式或安全性问题 → 既有 `invalid_params`；上游拒绝该目录 → `session_create_failed`。

### 兼容性

- **原四个 RPC 保持向后兼容**，语义一字不改：`sessions.list` / `session.read` / `session.send` / `session.stop`。
- `capabilities` 新增**可选布尔**：`models.list`、`session.create`（沿用既有命名风格，可带 `:<tool>` 细分）。
- **wire version 维持 `1`**：这两个是**新增的可选能力**，不是破坏性变更。

## 三、服务端（relay）要做的

- method 白名单 **4 → 6**，并为两个新方法**校验新结果形状**。
- 两个新方法同样走 `request`/`response` 转发、同样有 `timeoutMs`、同样受待决上限与限速约束。
- **服务器不得**因此获得任何"执行任意 shell"通道；**不得**有 `callerSource` 之类的绕过口。
- `capabilities` 原样透传（不做合并、不做推断，沿用既有规则）。

## 四、Markdown 与工具折叠（只改 mobile 的 web 层）

- Markdown **离线渲染**（**不得**加载远程 CDN），必须有**可靠成熟的 renderer + sanitize**，
  **禁止**把未过滤的内容直接 `innerHTML`。
- 工具调用/结果**折叠成活动块**，**默认折叠**；**跨 2 秒轮询保留展开状态与阅读位置**。
- **必要**的活动元数据可在活动对象上加**可选字段**（由 mobile 与 desktop owner 协商）；
  **不加**也不得破坏既有渲染。
- **不解析、不显示隐藏 reasoning**；**不显示工具里的任何认证秘密**。

## 五、它触及什么

| 文档 / 模块 | 改动 |
| --- | --- |
| `docs/design/api/protocol-v1.md` | 由**架构角色**更新到 **v4**（§3 硬不变量、§6.2 三个新码、§7.3 校验表、§9 两个新 result、§9.5 capabilities、§13 契约测试、§16 变更记录） |
| `docs/tasks/T-relay.md` | PM 追加 R20 起的 DoD（白名单、结果校验、透传） |
| `docs/tasks/T-desktop.md` | PM 追加 D11 起的 DoD（真实模型目录、落到桌面应用、去重、错误路径） |
| `docs/tasks/T-mobile.md` | PM 追加 M11 起的 DoD（Markdown、折叠、新建面板、轮询保持状态） |
| `relay/**`、`desktop/**`、`mobile/**` | 各自 owner 实现，**领地不交叉** |

## 成本与顺序

- **本轮优先交付可用功能与真测试**；**报告措辞最后再改**。
- 上一轮文档评审的 blocking（措辞/数字/方括号摘要等）**不得阻塞本轮已授权的开发**；
  其中唯一需要改代码的一条（`desktop/src/adapters/codex.js:498-502` 注释指认了不存在的取证）
  **与本轮功能改动合并成一次 repack**，不要为它单独打包。
- **root** 会创建一个**专用验收新会话**来验证"所选的真实模型"确实生效；
  在 server / bridge / web 三端升级完成前，root 的节点（仅 4 旧方法）**无法**验收新功能。

## 决定

**accepted** —— 由**用户**授权、**协调者**裁决字段；PM 记录并分派。

## 新增的 DoD 条目

- `T-desktop.md`：D11–D17（**7 条**）
- `T-relay.md`：R20–R23（**4 条**）
- `T-mobile.md`：M11–M16（**6 条**）

## Applied

| 文档 | 新版本 |
| --- | --- |
| `docs/decisions/crd/0006-cross-endpoint-create-and-models.md` | v1（本文件） |
| `docs/design/api/protocol-v1.md` | v4（架构角色执行中） |
| `docs/tasks/T-relay.md` / `T-desktop.md` / `T-mobile.md` | v+1（PM 追加 DoD） |
