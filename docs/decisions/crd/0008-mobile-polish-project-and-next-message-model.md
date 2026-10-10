# CRD 0008 — 手机端美化 + 新建会话选真实项目 + 消息页选「下条消息模型」

> 撰写：PM（seam owner）｜ 日期：2026-10-09 ｜ 状态：**accepted —— 用户明确要求（原始需求原话见下），root 已复核并给出实证**
> 权威接缝：本文件 §「接缝契约 v1」是三个 owner 实现期间的**唯一逐字口径**；`docs/design/api/protocol-v1.md` 仍是总契约，
> 本文件只做**加法**，不改动任何已有 method 的名字、`params`、`result` 与语义。**wire `version` 仍是 `1`。**

## 谁提出的

**用户**。原始原话：「接着改吧，我需要你把手机前端再美化一下，然后最好新建会话的时候能选择已有的项目，
在消息列表的时候我能选择模型」。root 在 2026-10-09 用真实本机接口复核后给出实现口径与实证。

## 用户要什么

1. 手机前端（中文）**再美化**：排版/间距/层级更精致，浅色与深色都平衡，简洁中性主题 + 一个强调色，
   顶栏紧凑，Markdown/代码可读，工具调用折叠，列表卡片精致（工具/状态/项目线索），
   输入区吸底且操作 ≥44px、键盘友好。
2. **新建会话**时能选**电脑上真实已有**的项目（Codex 与 DSH 都要），显示可读名字 + 路径。
3. **已有会话的详情页**能选**模型**与**推理强度**，作用于**下一条要发的消息**，并且背后是**真实原生 API**。

## 不变量（本轮不得破坏）

- Markdown 渲染、工具折叠、配对与鉴权、**发送不自动重试**、接管既有会话、未知创建的安全处理，全部保持。
- 手机端不得**暴露实现细节**在用户流程里；不得引入新的大型框架 / 新 CDN / 新依赖。
- 详情页与新建页在轮询失败时**不得丢草稿、不得丢工具展开状态、不得丢失当前视图**。

## 接缝契约 v1（PM 撰写，逐字生效；三个 owner 必须照此实现）

### 1. `models.list`（params 仍是 `{tool}`，**不新增 RPC**）

- `result.projects[]` 现在必须填**两个工具的、真实的**已有项目：`{id, name, cwd}`。
  - **Codex**：来自真实 `codex_app.list_projects`。
  - **DSH**：来自本机**已注册**的 workspace 目录；`workspace/list` **不存在**（返回非 JSON），
    权威持久目录是 `C:\Users\Hi\.dsh\storages\workspace.json`，
    形状 `{unit,global,tables:{workspaces:{[workspaceId]:{path,title,sessionIds,createdAt,updatedAt}}}}`（本机 6 条）。
    该文件**只读**，**绝不允许写入/迁移**；必须尊重 `DSH_HOME` 与自定义路径配置；读取要有界、要校验形状；
    读不到/损坏就**如实报告**（空数组 + reason），**不得假填**。
- `{id,name,cwd}` 的映射：Codex `id = projectId`、`name = label`、`cwd = path`；
  DSH `id = workspaceId`、`name = title`（无 title 时用 path 末段）、`cwd = path`。
- **Codex 项目字段实测（2026-10-09，root 实证，真实形状优先）**：
  `list_projects` 原始返回 `{schemaVersion:2, projects:[{projectId, projectKind:'local', label, path, hostId:'local', isGitRepository}...]}`。
  现有 `desktop/src/adapters/codex.js` 的 `localProjects()` **只读 id/name/kind/cwd**，因此**静默丢掉了本机 5 个真实项目**。
  必须**优先支持真实字段**、并保留**兼容旧字段**的兜底；**显式拒绝** remote / ChatGPT / 非 `hostId:'local'` 的条目。
  **不得硬编码**任何具体项目 id 或名字。
- `params.cwd`（`session.create` 的可选自由目录兜底）若**与所选 `projectId` 冲突** → **拒绝**（`invalid_params`），
  **不得**二选一、**不得**忽略其中一个。`session.create` **不得**静默创建/注册新项目。

### 2. `session.send`（**只**新增三个可选字段）

- `params` 白名单从 `{tool, sessionId, text}` 扩为 **`{tool, sessionId, text, model?, provider?, reasoningEffort?}`**。
- **三个都省略 = 现有行为一字不变**（旧客户端、旧手机照常可用）。
- 规则：
  - 有 `model` 时：`tool:"dsh"` **必须**带 `provider`；`tool:"codex"` **禁止**带 `provider`。
  - **有 `provider` 或 `reasoningEffort` 但没 `model`** → `invalid_params`。
  - 发送**之前**必须用**新鲜的本机目录**校验 `model` / `provider` / `reasoningEffort`，
    并且**按 `provider+model` 精确匹配同一身份**（同一个 model id 在本机 DSH 上有 3 个 provider，仅比 id 会串路由）。
- **Codex**：`send_message_to_thread` **只调用一次**，参数 `{threadId, prompt, model, thinking}`；
  `reasoningEffort` → `thinking`（映射与 `create_thread` 相同）。
- **DSH**：**先** `session/selectModel`，**再** `session/prompt`，`session/prompt` **只调用一次**；
  **`selectModel` 失败则不发送消息**（不得"模型换不上但还是把消息发了"）。
- **DSH 可继续的子会话（subagent）**：真实原生 override API 未经验证，
  模型覆盖必须 **`not_capable` 拒绝**；**绝不**去切换别的父会话。
- 会话**正在工作时**改模型**可以**被拒绝，但必须是**明确的安全错误**（不得偷偷 cancel 再重发、不得后台重试）。
- 普通发送的排队语义**不变**；响应仍是 `{accepted:true, sessionId}`（兼容）。

### 3. 能力位（诚实上报，不夸张）

- 每个工具**独立**上报：`session.send:model:codex` / `session.send:model:dsh`（可选再加全局 `session.send:model`）。
  只有该工具**真的**支持"发送时指定模型"才置 `true`。
- 手机端：能力位缺失/为 `false` → **禁用**该工具的模型覆盖，但**普通发送必须照常可用**。
- **旧 bridge（无新能力位）必须继续可用**：手机不得因为读不到新位就禁用发送或崩掉。

### 4. `session.read`（可选 `currentModel`）

- `result.currentModel?: {model, provider?, reasoningEffort?}`，**只能来自真实原生状态**。
  - **DSH**：`session/projections` 的 `values.modelSelection`（`modelSelectionOf()` 已暴露 `next` / `lastUsed` 投影）；
    优先 `next`，否则 `lastUsed`。
  - **Codex**：`read_thread` **不暴露**当前所选模型 → **省略 `currentModel`**，**不得**编造。
- UI 必须**明确措辞**：默认显示「**沿用当前模型**」；选过之后显示「**下条消息模型**」，
  并且**不得**把"下条消息模型"与"原生当前模型"混为一谈。
- 允许一个**每会话的浏览器本地草稿偏好**，但必须与原生当前模型**清晰分开**；
  **迟到响应或切换会话/导航时**，**不得**把别的工具/别的会话的所选值发出去。

### 5. relay（服务器）要做的

- 只做**加法**：`session.send` 的 params 白名单加 `model`/`provider`/`reasoningEffort`（附上面的组合校验）；
  `session.read` 的 result 允许可选 `currentModel` 并校验其形状；
  `capabilities` **原样透传**（不合并、不推断）。
- **必须保留**：Origin 精确校验、鉴权、限速、预算/上限、错误脱敏、**旧客户端互操作**。
- **不得**削弱任何既有校验。

### 6. 明确不做（本轮越界即失败）

- 不新增 RPC / 不新增 method；不改 wire `version`；不改 Android 清单；不动 vendor（`marked` / `purify`）；
  不装新依赖；不部署；不 commit / push / publish。
- 不实现"切模型就取消正在进行的回合"；不实现 DSH subagent 的模型切换。
- 不在用户流程里显示内部实现细节。

## 实证（2026-10-09，root 现场，作为实现依据而非猜测）

- Codex app-tools：`list_projects` 真实形状见上；本机真实项目 5 个（`remote-control` 的
  `projectId = c49702d7-0af5-4eba-bef8-a74582276dd3`，路径 `D:\workspace\codex-workspace\remote-control`；
  另有 ai-connect / inception-plan-1 / agent-learn / lifebot）。**这些值只作核对，不得写死进代码。**
- `send_message_to_thread` 真实 schema：`threadId`、`prompt` 必填；可选 `model`（与 `create_thread` 同一组 7 个本机模型）
  与 `thinking`（枚举 effort）。**app-tools 里没有独立的"设置模型"或"停止"工具** ——
  所以聊天页的模型选择**只能**作用于**下一条要发的消息**，UI 必须这么说。
- DSH 后端 `http://127.0.0.1:19387`（沿用既有自动发现）：`session/selectModel` 请求
  `{sessionId, provider, model, reasoningEffort?}` → 返回 `{selected:{provider, model, reasoningEffort?}}`；
  `session/create` 原生 schema `{workspaceId?, cwd?, sessionId?, agentPreset?}`；`session/modelCatalog` 仍是实时目录。
- 已核验的只读测试会话（**本轮不得发送/新建/停止任何东西**；root 独占真实变更验收）：
  Codex `01a11a8c-9512-79c3-ae04-a47584282b0b`；DSH `session-d4c45f7b-515e-48eb-a8ef-7c320bb7fd54`。

## 它触及什么

| 文档 / 模块 | 改动 |
| --- | --- |
| `docs/tasks/T-desktop.md` | PM 追加 **D19–D24**（6 条 DoD） |
| `docs/tasks/T-relay.md` | PM 追加 **R25–R28**（4 条 DoD） |
| `docs/tasks/T-mobile.md` | PM 追加 **M19–M26**（8 条 DoD） |
| `desktop/**` | 由 **desktop owner** 实现（真实项目字段、发送时模型、能力位、`currentModel` 已知边界、有意义的测试） |
| `relay/**` | 由 **relay owner** 实现（白名单 + result 校验 + 保持既有一切） |
| `mobile/**` | 由 **mobile owner** 实现（美化、新建选真实项目、详情页选下条消息模型、状态保持） |

**接缝归属**：`mobile/web/**` → `relay/web/**` 的搬运**仍由 PM 执行**（owner 不得自己写进 `relay/**`）。
本轮三个 owner 领地互不重叠；PM 是唯一 seam owner，负责在实现后复核并搬运 + 逐文件哈希比对。

## 成本

- 三个 owner 并行：desktop（真实项目 + 发送模型）、relay（加法校验）、mobile（UI + 选择器 + 状态保持）。
- **无里程碑重排**：仍在 M1 内，属用户已授权的同一轮产品升级。
- 预计风险：DSH workspace 只读目录的形状校验；Codex 项目字段的两套兼容；发送时切模型的"选择失败就不发"落地。

## 决定

**accepted** —— 由**用户**提出（原话见上）、root 复核并给出实证口径；PM 记录、写进任务表并分派三个 owner。

## 新增的 DoD 条目

- `T-desktop.md`：**D19–D24（6 条）**
- `T-relay.md`：**R25–R28（4 条）**
- `T-mobile.md`：**M19–M26（8 条）**

## Applied

| 文档 | 新版本 |
| --- | --- |
| `docs/decisions/crd/0008-mobile-polish-project-and-next-message-model.md` | v1（本文件，2026-10-09） |
| `docs/tasks/T-desktop.md` | v5（PM 追加 D19–D24） |
| `docs/tasks/T-relay.md` | v8（PM 追加 R25–R28） |
| `docs/tasks/T-mobile.md` | v5（PM 追加 M19–M26） |
