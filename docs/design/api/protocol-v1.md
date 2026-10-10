# protocol-v1 — AI 远程控制 线路协议（relay ↔ desktop ↔ mobile）

- **文档路径**: `docs/design/api/protocol-v1.md`
- **版本**: v5（2026-10-08 v1 创建；同日按 CRD 0003 加 `forbidden` 错误码 → v2；同日按 CRD 0004 更正 §4.6 / §7.2 里配对码长度的散文字样 20 → 24 → v3；同日按 CRD 0006 加 `models.list` / `session.create` 两个 method、四个 `capabilities` 位、三个错误码，并**推翻 v1 §3 第 5 条"手机不能新建会话"** → v4；同日按 CRD 0007 给 `session.read` 加可选字段 `historyTruncated` → v5。**协议版本号仍是 `version: 1`**（新增 method、新增可选字段、新增错误码都属于 §12.3 的加法，没有改动任何已有 method、字段或错误码的名字、类型与语义））
- **协议版本号**: `version: 1`（见第 12 节）
- **文档名说明**: 本文件是 crew 惯例的**模块边界契约**（`docs/design/api/<caller>-<callee>.md`）。因为本作业的三个模块共用**同一条线上协议**（HTTP 面由手机调服务器，WebSocket 面由电脑连服务器），写在一个文件里可以避免"两个方向各写一半、两边对不上"；第 2 节给出线上真正存在的两条接缝。
- **冻结规则**: 本文件是**冻结契约**。任何一侧的工程师**不得修改本文件**；发现契约有误或有冲突 → 写 `<job folder>/inbox/Q-<n>.md` 报告 PM，由 PM 决定；**只有架构角色改这份文件**，改完由 PM 通知两侧重新阅读。改的时候优先**只增不改**（新增 method / 新增字段 / 新增错误码），因为已完成的一侧不能再做一次。
- **本文件不写什么**: 不写实现语言细节、不写函数名、不写数据库表结构、不写任何真实 token。字段名、method 名、JSON 关键字、CLI 参数、HTTP 路径一律保持英文原样。

---

## 1. 一句话摘要

服务器（relay）在 `127.0.0.1:8080` 上只监听回环，Caddy 在 443 上做 HTTPS 反代，公网入口是 `https://101.43.98.18`；手机用 HTTP + `rc_session` cookie 调 relay，电脑用一条**主动外连**的 WebSocket（`wss://101.43.98.18/bridge`）挂在 relay 上；手机发起的**六个**受限方法（`sessions.list` / `session.read` / `session.send` / `session.stop` / `models.list` / `session.create`）全部由 relay 转成 `request` 帧发给电脑，电脑回 `response` 帧，relay 原样转回手机。其中最后两个是 v4 新增：手机据此先看到电脑上**真实可用**的模型，再在电脑上**那个桌面应用里**新建一条真实会话。

---

## 2. 接缝（谁调谁）与边界风格

| 接缝 | 方向 | 线上形态 | 契约归属 | 谁实现哪侧 |
| --- | --- | --- | --- | --- |
| **mobile → relay** | 手机（caller）调服务器（callee） | HTTPS / REST + 一条 cookie 会话 | 本文件第 5–7 节 | relay 实现服务端；mobile 实现客户端 |
| **desktop ↔ relay** | 电脑（callee 侧的执行者）**主动出站**连服务器（broker） | WebSocket 上的 JSON 帧 | 本文件第 8 节 | relay 实现 broker 端；desktop 实现 bridge 端 |

- **风格**: 手机侧是 **HTTP/REST + JSON**；电脑侧是 **WebSocket + JSON 文本帧**。这是本作业新引入的风格（仓库里此前没有线上协议），所以它是**风险最高的边界**：两端风格不同、由两个不同的人写、且中间还夹着一个 broker。
- **为什么不是其它风格**: 手机↔服务器必须是浏览器/WebView 能直接被 Caddy 反代的形态（HTTP）。电脑↔服务器必须是**电脑主动外连**（NAT 后面没有入站端口可用），因此是长连接；用 WebSocket 而不是"HTTP 长轮询"是因为要服务端**主动**把手机请求推给电脑，长轮询会引入额外的取件与去重状态。
- **契约归属（owner）**: relay。手机侧与电脑侧的**行为**由本文件钉死；两侧都不得自行扩展 method、字段或错误码。
- **本文件不指定库**: 用哪个 WebSocket 库、哪个 HTTP 框架、哪个 SQLite 驱动，由各模块按本仓库已确认的栈自行决定，不在契约范围内。

---

## 3. 硬不变量（违反任意一条即为实现错误）

> **v4 说明**: 第 5 条被**用户明确覆盖并改写**（原文"手机不能新建会话"已不成立）。**第 1–4、6–10 条一字未改**，仍然全部有效。

1. **只听回环**: 服务进程只监听 `127.0.0.1:8080`。不得监听 `0.0.0.0`，不得直接监听 443。公网流量一律经 Caddy。
2. **公网入口唯一**: 对外只有 `https://101.43.98.18`（HTTPS，443）。**无公网 bootstrap 端点、无默认口令、无首次运行免认证窗口。**
3. **不开 CORS**: 任何响应都**不得**出现 `Access-Control-Allow-Origin`（包括 `*`）。任何请求都**不得**带 `Access-Control-Allow-Credentials`。这是**同一来源部署**（Web 前端与 API 同在 `https://101.43.98.18`），不需要跨域。
4. **服务器不存聊天全文**: 持久化只允许 **手机 token 的哈希**、**审计元数据**（时间、来源、结果码）、**配对码哈希**与**短期状态**。`session.read` 返回的消息正文、`session.send` 的文本**一律不落盘、不写日志**。
5. **手机只能新建该工具真实支持的会话，且必须落在那台电脑的桌面应用里**（**v4 改写**，原文是"手机不能新建会话：不存在任何创建会话的 method"）:
   - 创建会话**只有一个**入口：`session.create`。除它之外，手机**不得**通过任何其它 method 创建会话。
   - **创建必须落在电脑上那个桌面应用里**，成为**该应用的一条新会话**。**不得**在命令行另起一个 CLI / appserver 进程来充当"新会话"——这条是 v4 的**实现约束**，它决定实现方向，不是建议。命令行另起的进程在手机上看起来一样，但它不是用户要求的那条会话（用户要的是"电脑上那个应用里"多一条会话，不是"电脑上多了一个进程"）。
   - **`session.create` 只允许在当前工具真实支持的参数内创建**：`params.model` 必须取自 `models.list` 返回的 `id`；工具当前不可用、或电脑侧拒绝，一律失败（`tool_unavailable` / `model_not_available` / `session_create_failed`），**不得**退化成"随便挑一个默认值建出来"。
   - **创建出来的 `sessionId` 与既有会话是同一个 id 空间**：它必须能被 `sessions.list` 看到、能被 `session.read` 读到、能被 `session.send` / `session.stop` 操作。**创建成功但列不出来 = 没建成**。
   - **`sessionId` 永远是电脑侧真实存在的会话 id**：旧的四个方法拿到的 `sessionId` 仍然必须是电脑上**真实已存在**的会话 id；手机**不得**自己构造 id（4.1）。v4 增加的是"可以**请求**电脑新建一条"，而不是"手机可以编造 id"。
   - 9.3（`session.send`）里"**不新建会话**、不重放历史、不改写历史"这一条**继续有效、一字未改**：它约束的是**发送**，不是创建。两条不冲突：`session.send` 永远不创建，`session.create` 是唯一创建入口。
   - **部分成功也是"建成"**：一旦电脑侧真的建出了会话，`session.create` 就回 `ok:true` + 真实 `sessionId`（后续 `selectModel` / `prompt` / 首条消息失败**不得**把它藏起来，见 9.5 的"部分成功"）。
6. **权限不扩张**: 手机能做的操作是电脑端能力的子集；白名单之外的会话不可见、不可读、不可操作（表现为 `session_not_found`，见 6.4）。
7. **不重试发送**: `session.send` 与 `session.stop` 在超时、断线、重连后**一律不自动重发**（防重复消息）。重发只能由用户再次点击触发。
8. **待决请求有界**: relay 内存中的待决请求有硬上限与强制回收（见第 10 节），不得无限增长。
9. **秘密不进任何输出**: token / 口令 / cookie 值 / 配对 code **不得**出现在日志、错误文本、源码、配置模板、公网可下载产物中。日志里只允许出现**哈希后的前缀**（见 6.9）。
10. **token 只用哈希落盘**: `rc_session` cookie 与 `bridgeToken` 在磁盘上只以哈希形式存在；明文只在内存与线上出现。
11. **六个 method 之外没有通道，且不得由此长出"执行任意命令"的口子**（**v4 新增，依据 CRD 0006 §三**）: relay 只转发第 7.3 节白名单里的**六个** method；`session.create` 的 `params` **只允许** 9.5 表里那些字段，**不得**出现 `shell` / `exec` / `argv` / `command` 之类字段，**不得**有 `callerSource` 之类能改写上游调用身份的绕过字段。任何白名单外字段一律 `invalid_params`。`capabilities` 由 relay **原样透传**（不做合并、不做推断，见 9.7）。

---

## 4. 基本约定

### 4.1 id 的形态与归属

| 名字 | 生成者 | 形态 | 生命周期与唯一性 |
| --- | --- | --- | --- |
| `id`（`pair.create` / `pair.created` / `request` / `response` 帧里的 id） | **`pair.create` 的 id 由电脑生成；`request`/`response` 的 id 由 relay 生成** | **UUID v4 小写**，36 字符，正则 `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` | 电脑侧 id 在一条 bridge 连接内唯一；relay 侧 id 全局唯一，**只允许被应答一次** |
| `code`（配对码） | relay | 见 4.6 | 一次性，5 分钟 |
| `sessionId` | 电脑（会话的既有 id） | 1–128 字符，`^[A-Za-z0-9._:-]{1,128}$` | 由电脑侧会话本身决定；手机不得构造。**v4 补充**：`session.create` 建出来的新会话 id 与既有的**同一个空间、同一条正则**——手机把它当作普通 `sessionId` 用，不得区分对待 |
| `rc_session`（cookie 值） | relay | 32 字节加密随机数的 base64url（无填充），43 字符，正则 `^[A-Za-z0-9_-]{43}$` | 默认 30 天（见 5.2），注销/撤销后立即失效 |
| `bridgeToken` | relay `--init` 生成 | ≥32 字节加密随机数的 base64url，正则 `^[A-Za-z0-9_-]{43,86}$` | 长期；轮换即旧值立即失效 |
| `deviceId` | relay | UUID v4 小写 | 与一条 `rc_session` 一一对应，随撤销消失 |

- **id 的对应关系是转发正确性的唯一保证**: relay 收到 `{type:'response',id}` 时，必须按 id 在待决表里查到**那一条**请求；查不到（重复应答、已超时回收、伪造 id）→ **丢弃该帧，不改任何待决请求的状态**（见 10.2）。
- **id 不得复用**: relay 为一次手机请求分配一个 id，该 id 在应答或回收后**永不再分配**。
- **id 不得由手机指定**: 手机在 HTTP body 里传 id 一律忽略（不报错也不采纳）。

### 4.2 时间格式（写死）

- 所有时间字段（`expiresAt`、`updatedAt`、`timestamp`）都是字符串，**RFC3339 / ISO 8601，UTC，`Z` 结尾**，秒级或毫秒级小数都接受，输出统一为：
  - 秒级: `2026-10-08T03:58:07Z`
  - 毫秒级: `2026-10-08T03:58:07.412Z`
- **禁止**输出本地时区偏移（如 `+08:00`）、禁止输出秒以下以外的时间戳数字、禁止输出 `null`。
- 解析时**必须接受**两种精度；比较时按 UTC 瞬时值比较。
- 客户端展示时区由客户端自己转换，协议层永远是 UTC。

### 4.3 `status` 的取值（写死）

会话状态，只允许这四个值：

| 值 | 含义 |
| --- | --- |
| `idle` | 会话空闲，没有正在执行的一轮 |
| `working` | 会话正在执行（有活跃的一轮） |
| `stopped` | 会话被停止过（用户停止或上游停止），当前没有任何人在跑 |
| `error` | 会话处于错误态（上游报错、进程异常），需要用户到电脑上处理 |

- 出现未知值时：**relay 不改写、不猜测**，原样透传；客户端遇到不认识的 `status` 按 `error` 的样式显示但**不禁用**任何按钮（按钮是否可用只看 `canStop` / `capabilities`）。

### 4.4 `role` 的取值（写死）

消息角色，只允许这四个值：

| 值 | 含义 |
| --- | --- |
| `user` | 用户发出的消息 |
| `assistant` | AI 回复 |
| `system` | 会话系统消息（提示、状态行、错误行） |
| `tool` | 工具调用/工具结果 |

- 未知 `role` 原样透传，客户端按 `system` 的样式显示，不得丢弃该条消息。

### 4.5 `tool` 的取值（写死）

只允许 `"codex"` 与 `"dsh"` 两个值（**两者都是要求**，不是先后顺序）。其它值一律拒绝：`params.tool` 非法 → `invalid_params`。

### 4.6 配对 code 的字符集、长度、熵

- **规范形式**: 24 个 **Crockford Base32** 字符（`0-9` 与 `A-Z` 去掉 `I` `L` `O` `U`），每 4 个一组用 `-` 连接，共 6 组：
  `^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){5}$`
  例：`K7QP-3MZD-9XTB-2RCV-6HNF-0JWS`
- **总长**: 29 字符（含 5 个 `-`）；**去掉连字符后 24 字符**。24×5 bit = **120 bit 熵**，满足"至少 10 字符"且远高于它。
- **输入归一化**: 校验前先删除所有 `-`、把字母转大写、把 `O`→`0`、`I`/`L`→`1`、`U`→`V`（Crockford 别名规则）。归一化后必须正好 24 字符且属于字母表。
- **不得**使用可读单词、时间戳、递增序列、`sessionId` 或设备名参与生成。生成必须来自加密随机源。

> **更正（2026-10-08，v3，依据 CRD 0004）**: v2 的散文曾写"20 字符 / 100 bit"，与同段的正则（6 组）和例子（24 字符）矛盾。以正则与例子为准：**归一化后 24 个 Crockford 字符、120 bit**。正则与例子未改动。

---

## 5. HTTP 面：统一约定

### 5.1 请求头要求

| 请求头 | 规则 |
| --- | --- |
| `Content-Type` | **强制**。`POST` 请求必须精确等于 `application/json`（大小写不敏感，允许 `;` 后的参数）。缺失或其它值 → **415** `unsupported_media_type`。`GET` 不需要也不检查。 |
| `Origin` | `/api/*` 与 `/downloads/*` **强制**，且必须**精确等于** `https://101.43.98.18`。见 5.3。`GET /health` 不检查。 |
| `Cookie` | 需要认证的端点必须带 `rc_session=<值>`。缺失 → **401**。 |
| `Authorization` | 只用于 `/bridge`：`Bearer <bridgeToken>`。见第 8 节。 |
| `Content-Length` | 必须存在（Go 的 `net/http` 对无 body 的请求会填 0）。超过上限 → **413**，在读取 body **之前**就拒绝。 |
| `User-Agent` | 不检查、不记录（避免把设备指纹写进日志）。 |
| 任何 `X-` 自定义头 | 不要求。不得用自定义头承载认证（认证只认 cookie / Bearer）。 |

- 请求头名字大小写不敏感（HTTP 规定）。
- **`X-Forwarded-For` 的信任规则**: 只有当连接的对端地址是回环（`127.0.0.1` / `::1`）时才读取它（此时它是 Caddy 写入的真实客户端地址）；否则一律忽略该头，用连接对端地址。这是把"限速按谁算"钉死的唯一定义，避免伪造头绕过限速。

### 5.2 响应头要求

| 响应头 | 值 | 适用 |
| --- | --- | --- |
| `Content-Type` | `application/json; charset=utf-8` | 所有 JSON 响应 |
| `Content-Type` | `application/vnd.android.package-archive` | 只有 APK 下载（7.5） |
| `Cache-Control` | `no-store` | 所有 `/api/*` 响应（含成功与失败） |
| `X-Content-Type-Options` | `nosniff` | 所有响应 |
| `Vary` | `Origin` 与 `Cookie` | 所有 `/api/*` 响应 |
| `Referrer-Policy` | `no-referrer` | 所有响应 |
| `Set-Cookie` | 见 7.2 | 只有配对成功（成功）与 6.10 的失败清理 |
| `Access-Control-Allow-Origin` | **禁止出现** | 任何响应 |

- **cookie 属性（写死）**: `Set-Cookie: rc_session=<值>; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict`
  - `Max-Age=2592000` = 30 天。`Expires` 不写（`Max-Age` 优先，避免两个时间打架）。
  - 必须有 `HttpOnly`、`Secure`、`SameSite=Strict` 三者。
  - 不得设置 `Domain`（保持主机绑定）。
- **吊销 cookie 的写法（写死）**: `Set-Cookie: rc_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`。

### 5.3 `Origin` 的精确匹配规则（写死）

- 允许的**唯一**字符串是 `https://101.43.98.18`（小写 scheme、小写 host、无端口、无结尾斜杠）。
- 比较前只做两件事：**去掉首尾空白**、**整个字符串转小写**。除此之外**逐字节相等**。
- **不匹配的情况一律拒绝（403 `origin_forbidden`）**，包括：缺头、`null`、`http://101.43.98.18`、`https://101.43.98.18:443`、`https://101.43.98.18/`、`https://101.43.98.18.evil.example`、`https://101.43.98.18:8443`、大写 host 之外任何差异、多个 Origin 值。
- 本规则对 `/api/*` 与 `/downloads/*` 生效；`GET /health` 例外（见 7.1）。
- **移动端的一条硬要求**: WebView 里的前端必须显式发出 `Origin: https://101.43.98.18`（同源 `fetch` 会发；用 `file://` 或 `data:` 加载页面**不会**发 Origin，那种装载方式在本契约下不可用）。这一条的取舍与风险见第 15 节 R1。

### 5.4 body 大小上限（写死）

| 端点 | 上限 | 超限响应 |
| --- | --- | --- |
| `POST /api/pair` | **4096 字节** | 413 `payload_too_large` |
| `POST /api/rpc` | **16384 字节** | 413 `payload_too_large` |
| `POST /api/logout` | **1024 字节** | 413 `payload_too_large` |
| 其它任何 `POST` | 1024 字节 | 413 |

- 判定顺序：先看 `Content-Length`（> 上限立即 413，不读 body），再用受限读取器兜底（防 `Content-Length` 撒谎）。
- 上限按**请求体的原始字节数**算，不解压、不按字符算。

### 5.5 成功与失败的状态码表（总表）

| 端点 | 成功 | 失败 |
| --- | --- | --- |
| `GET /health` | **200** | （无认证、无 Origin 检查；服务活着就 200） |
| `POST /api/pair` | **200** + `Set-Cookie` | 400 / 401 / 403 / 404 / 405 / 413 / 415 / 429 / 500 / 503 |
| `POST /api/rpc` | **200**（业务错误也是 200，见 6.1） | 400 / 401 / 403 / 405 / 413 / 415 / 429 / 500 / 502 / 503 / 504 |

> **业务错误的 HTTP 状态（v4 复述，避免两侧各自猜）**: 只有**传输与鉴权**层的结果用非 200 表示。**全部**业务失败（含 v4 新增的 `unknown_method` / `invalid_params` / `not_capable` / `too_long` / `session_not_found` / `session_gone` / `bridge_error` / `tool_unavailable` / `model_not_available` / `session_create_failed`）都是 **HTTP 200**，靠 body 的 `ok:false` + `error.code` 区分。非 200 只在四种情况下出现：`401 unauthenticated`、`403 origin_forbidden`、`429 rate_limited`、`400 invalid_json` / `invalid_request`（请求体本身不成立）。
| `POST /api/logout` | **200** | 400 / 401 / 403 / 405 / 413 / 415 / 429 / 500 |
| `GET /downloads/...` | **200**（流式） | 403 / 404 / 405 / 429 |

- **方法不匹配** → 405 `method_not_allowed`，且必须带 `Allow` 头（例如 `Allow: POST`）。
- **未知路径**（`/api/xxx` 或其它） → 404 `not_found`。不得回落到任何静态文件或调试页。
- **500** 文本固定为 `internal error`，**不得**包含堆栈、路径、SQL、上游原文。
- `Retry-After` 头只在 **429**（值 = 建议等待秒数）与 **503**（值 = `1`）出现。

---

## 6. 统一的错误体与错误码

### 6.1 错误体形状（全篇统一，写死）

任何失败都是一样的形状（**HTTP 层错误**与 **RPC 层业务错误**都用它）：

```json
{"ok":false,"error":{"code":"<稳定机器码>","message":"<安全文本>"}}
```

- `ok`: 固定 `false`。
- `error.code`: **稳定机器码**，只在第 6.2 表里取值。客户端按 `code` 分支，**不得**按 `message` 分支。
- `error.message`: 面向人的短句（英文，≤120 字符）。**不得**含堆栈、文件路径、SQL、token、code、cookie、上游原始错误文本。客户端可以直接显示，也可以按 `code` 显示自己的文案。
- 成功形状永远是 `{"ok":true, ...}`。**同一响应里不得同时出现 `ok:true` 与 `error`**，也不得出现 `ok:false` 与业务字段并存。
- **`/api/rpc` 的业务错误用 HTTP 200 返回**，即"HTTP 成功、业务失败"。理由：手机只需要一个分支点（`ok` 字段）就能区分业务结果；HTTP 状态码只表达**传输与鉴权**层的结果（是否到达 relay、是否被允许、上游是否在线）。

### 6.2 错误码总表（写死，不得新增同义码）

| `code` | HTTP | 含义 | 客户端该做什么 |
| --- | --- | --- | --- |
| `invalid_json` | 400 | body 不是合法 JSON，或 JSON 顶层不是对象 | 修客户端，不重试 |
| `invalid_request` | 400 | 缺少必需字段，或字段类型/取值非法（含未知 method 的白名单字段） | 修客户端，不重试 |
| `unauthenticated` | 401 | 缺 cookie、cookie 格式非法、cookie 未知/已过期/已撤销 | 回到配对界面 |
| `invalid_credentials` | 401 | `POST /api/pair` 的 code 不存在、已消费、已过期、超过尝试次数 | 让用户重新生成配对码 |
| `forbidden` | 403 | **已认证但无权执行**（身份有效、权限不足）。与 `unauthenticated`(401) 明确区分：401 = 没带上有效身份；403 = 身份有效但没权限 | 不重试；提示"没有权限"（v2 新增，见 §7.4 与 §15 R4） |
| `origin_forbidden` | 403 | `Origin` 缺失或不精确匹配 | 修客户端，不重试 |
| `not_found` | 404 | 未知路径，或配对 code 未知（对外统一为 404） | 不重试 |
| `method_not_allowed` | 405 | HTTP 方法与路径允许的不符 | 修客户端；看 `Allow` 头 |
| `payload_too_large` | 413 | body 超过 5.4 的上限 | 修客户端，不重试 |
| `unsupported_media_type` | 415 | `Content-Type` 不是 `application/json` | 修客户端，不重试 |
| `rate_limited` | 429 | 触发限速（见 6.3 的限速表，以及 7.2 / 7.3 / 7.5） | 等 `Retry-After` 秒后重试一次 |
| `internal` | 500 | relay 内部错误 | 可重试一次；仍失败则上报 |
| `bridge_offline` | 503 | 电脑不在线，或请求发出前后连接断开 | 提示"电脑不在线"，可手动重试 |
| `bridge_busy` | 503 | 待决请求已达上限（第 10 节） | 等 `Retry-After` 后重试一次 |
| `bridge_timeout` | 504 | 超过 `timeoutMs` 仍未收到 `response` | 提示"电脑没有及时回应"；**不自动重试** |
| `bridge_bad_response` | 502 | 收到的帧无法解析，或 `result` 不符合该方法的结果形状 | 记一条客户端诊断；不自动重试 |
| `unknown_method` | 200 | `/api/rpc` 的 `method` 不在**六个**白名单方法里 | 修客户端，不重试 |
| `invalid_params` | 200 | `params` 含白名单外字段，或必填字段缺失/非法 | 修客户端，不重试 |
| `session_not_found` | 200 | `sessionId` 在电脑侧不存在或不在白名单内 | 刷新列表 |
| `session_gone` | 200 | 会话存在但已不可操作（已结束） | 刷新列表 |
| `not_capable` | 200 | 该会话或该工具没有声明对应 capability（例如不支持停止、不支持 `models.list`） | 把按钮置灰（**不得假装可用**） |
| `too_long` | 200 | `params.text` 超过 16384 字符 | 提示用户，不重试 |
| `tool_unavailable` | 200 | **v4 新增**：请求里的 `tool` 当前不可用（桌面应用没开 / 适配器没连上）。**只在 `session.create` 上出现**；`models.list` 遇到同一情况**不报错**，返回 `models: []` + `reason`（见 §9.4） | 提示"该工具当前不可用"，把新建面板置灰 |
| `model_not_available` | 200 | **v4 新增**：`params.model`（或 DSH 缺 `provider` / `provider` 不在目录里）不在该工具 `models.list` 当前返回的集合里 | 回到模型选择，重新读一次 `models.list` 再让用户选 |
| `session_create_failed` | 200 | **v4 新增**：电脑侧创建/配置失败（桌面应用拒绝、`cwd`/`projectId` 不可用、上游报错）。`message` 为安全文本 | 显示 `message`；**不自动重发**（§9.5 与第 11 节） |
| `bridge_error` | 200 | 电脑侧执行失败，`error` 透传（安全文本） | 显示 `message`，不自动重试 |

- **不允许**在 `code` 里出现 `unknown`、`error`、`failed` 这类无信息值。
- 同一含义**只能有一个** code。新增 code 属于契约变更（第 12 节第 3、6 条）。

### 6.3 限速与响应（写死）

按**客户端 IP**（见 5.1 的 `X-Forwarded-For` 信任规则）计桶。桶是滑动窗口，计数器在内存里，重启即清空（这是可接受的：限速是抗滥用，不是账务）。

| 端点 | 窗口与配额 | 突发 | 超限响应 |
| --- | --- | --- | --- |
| `POST /api/pair` | **60 秒内 5 次**，且 **3600 秒内 20 次** | 无额外突发 | 429 `rate_limited` + `Retry-After: 60` |
| `POST /api/rpc` | **60 秒内 120 次** | 允许瞬时 20 次 | 429 `rate_limited` + `Retry-After: 5` |
| `POST /api/logout` | 60 秒内 10 次 | — | 429 `rate_limited` + `Retry-After: 60` |
| `GET /downloads/*` | 60 秒内 30 次 | — | 429 `rate_limited` + `Retry-After: 30` |
| `GET /health` | 60 秒内 120 次 | — | 429 `rate_limited` + `Retry-After: 5` |

- **同 IP 的并发连接数**上限 **64**：超过时新连接直接 429 `rate_limited` + `Retry-After: 5`。
- 另有一层**全局**保护：整个 `/api/*` 每秒处理上限 **500 请求**；超过时 503 `bridge_busy` + `Retry-After: 1`（2 核 2G 机器的自我保护，避免被一段突发打满内存）。
- 限速计数**不得**把 code、cookie、token 写进日志（只记 IP、路径、结果码）。

### 6.4 会话可见性的统一口径（写死）

"白名单之外的会话不可见、不可操作"在协议层表现如下，**不得**用其它方式表达（不能因为"存在但不在白名单"就返回不同的错误，那会变成枚举工具）：

| 情况 | 返回 |
| --- | --- |
| `sessionId` 在电脑侧不存在 | `session_not_found` |
| `sessionId` 存在，但不在手机可见集合内 | `session_not_found`（**与上一种完全同形**，不可区分） |
| `sessionId` 存在且可见，但会话已结束 | `session_gone` |

---

## 7. HTTP 端点

统一前缀：`https://101.43.98.18`（下文写相对路径）。所有时间按 4.2。

### 7.1 `GET /health`

- **认证**: 无。**`Origin` 检查**: 无。**body**: 无。
- **成功 200**:

```json
{"ok":true,"bridgeOnline":true}
```

| 字段 | 类型 | 必填 | 取值 |
| --- | --- | --- | --- |
| `ok` | boolean | 必填 | 固定 `true` |
| `bridgeOnline` | boolean | 必填 | 是否**至少有一条**已通过 `hello` 的 bridge 连接在线 |

- `bridgeOnline` 的判定：存在至少一条 WebSocket 连接已通过鉴权、已收到合法 `hello`、且未被判死（第 9.3 节）。
- **本端点不泄露任何其它信息**: 不得返回版本号、设备名、会话数、主机名、时间之外的任何细节。
- 这个端点也用于：反代后的自检、Caddy 健康检查（可选）。因此它对非浏览器也友好（不查 Origin）。

### 7.2 `POST /api/pair`

- **认证**: 无（本身就是认证入口）。**`Origin` 检查**: 强制（5.3）。**`Content-Type`**: `application/json`。**body 上限**: 4096。
- **请求体**:

```json
{"code":"K7QP-3MZD-9XTB-2RCV-6HNF-0JWS","deviceName":"Pixel 8"}
```

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `code` | string | 必填 | 归一化后 24 个 Crockford 字符（4.6）。**未归一化**前允许 20–64 字符（含连字符与空格） |
| `deviceName` | string | 必填 | 1–64 字符；**去掉首尾空白**后不得为空；只允许可打印字符，去除控制字符；超出即 `invalid_request` |

- **成功 200**（并在同一响应里下发 cookie）:

```json
{"ok":true}
```
```
Set-Cookie: rc_session=<rc_session>; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict
```

- **失败**:

| 场景 | 状态码 | `code` | `message` |
| --- | --- | --- | --- |
| body 不是 JSON / 顶层不是对象 | 400 | `invalid_json` | `invalid json body` |
| 缺 `code` 或 `deviceName`，或类型/长度非法 | 400 | `invalid_request` | `invalid request body` |
| code 归一化后不合法 | 401 | `invalid_credentials` | `pairing code is not valid` |
| code 不存在（含已被清理） | 404 | `not_found` | `not found` |
| code 已过期（> 300 秒） | 401 | `invalid_credentials` | `pairing code has expired` |
| code 已被消费 | 401 | `invalid_credentials` | `pairing code already used` |
| 该 code 的错误尝试次数已达 5 次 | 401 | `invalid_credentials` | `pairing code is not valid` |
| 触限速 | 429 | `rate_limited` | `too many requests` |
| Origin 不匹配 | 403 | `origin_forbidden` | `origin not allowed` |
| Content-Type 不对 | 415 | `unsupported_media_type` | `content type must be application/json` |
| body 超限 | 413 | `payload_too_large` | `request body too large` |

- **配对 code 的完整语义（写死）**:
  1. **一次性**: 消费判定发生在**成功路径上且只发生一次**。服务端必须用**原子操作**（比较并置位）把 code 从 `unused` 变成 `consumed`；**只有把置位成功的那一次请求**才签发 cookie。两个并发请求用同一个 code，**恰好一个**成功，另一个必须得到 `401` / `pairing code already used`。
  2. **5 分钟过期**: 从 relay 生成该 code 的时刻起 **300 秒**（`expiresAt = createdAt + 300s`，秒级精确）。过期判定以 relay 的**单调时钟**为准，避免系统时间回跳。
  3. **过期清理**: 到期后 code 立刻不可用（不依赖后台清理）；后台清理任务每 **60 秒**跑一次，删掉已过期或已消费超过 **300 秒**的记录。清理只是省内存，不影响正确性。
  4. **失败尝试计数**: 同一个 code 累计 **5 次**失败（归一化不合法、已过期、已消费都算）后**立即作废**该 code，后续任何使用都返回 `invalid_credentials`。计数保存在该 code 的记录里。
  5. **签发时**: relay 生成 32 字节随机 `rc_session`；**落盘只存 SHA-256（不加盐，因为值本身 256 bit 熵，不需要盐）**；明文 `rc_session` 只在内存与那一个 `Set-Cookie` 里出现；明文**不得**进日志。
  6. **一个 code 最多签发一个 `rc_session`**（与"一次性"同一条规则）。
- **设备名**: 只用于在电脑端/手机端显示"哪台设备配对过"；它进入审计元数据，**不得**进入日志的自由文本。

### 7.3 `POST /api/rpc`

- **认证**: 必须（`Cookie: rc_session=<值>`）。**`Origin` 检查**: 强制。**`Content-Type`**: `application/json`。**body 上限**: 16384。
- **请求体**:

```json
{"method":"session.send","params":{"tool":"codex","sessionId":"0f1c...","text":"继续"}}
```

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `method` | string | 必填 | 只能是 `sessions.list` \| `session.read` \| `session.send` \| `session.stop` \| `models.list` \| `session.create`（**六个**；v4 新增最后两个） |
| `params` | object | 可选 | 缺省视为 `{}`。字段白名单**按 method 收紧**，见下表 |

- **`params` 白名单（写死；多一个字段就是 `invalid_params`）**:

| method | `tool` | `sessionId` | `text` |
| --- | --- | --- | --- |
| `sessions.list` | 可选 | 必须省略 | 必须省略 |
| `session.read` | 必填 | 必填 | 必须省略 |
| `session.send` | 必填 | 必填 | 必填 |
| `session.stop` | 必填 | 必填 | 必须省略 |

**v4 新增的两个 method 各有一张自己的白名单表**（字段名不同，所以不并进上表）：

| method | `tool` | `model` | `provider` | `reasoningEffort` | `cwd` | `projectId` | `text` | `requestId` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `models.list` | 必填 | 必须省略 | 必须省略 | 必须省略 | 必须省略 | 必须省略 | 必须省略 | 必须省略 |
| `session.create` | 必填 | 必填 | **DSH 必填 / Codex 必须省略** | 可选 | 可选 | 可选 | 可选 | **必填** |

**两条跨表的通用规则（写死）**:
- **`model` / `provider` / `reasoningEffort` / `cwd` / `projectId` / `requestId` 只允许出现在 `session.create` 的 `params` 里**。出现在任何其它 method（含 `models.list`）的 `params` 里 → `invalid_params`。
- **`tool` 永远只表示"用哪个应用"**，取值仍是 4.5 的 `"codex"` \| `"dsh"`。**不得**用 `tool` 承载模型、也不得把模型名塞进 `tool`（模型永远是 `model`）；更**不得**把 4.5 的两个取值扩成"工具 + 模型"的混合枚举。

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `tool` | string | `"codex"` 或 `"dsh"`（4.5） |
| `sessionId` | string | `^[A-Za-z0-9._:-]{1,128}$` |
| `text` | string | 长度 **1–16384** 字符（按 Unicode 码点计），去空白后不得为空；不得包含 NUL 字符。超长 → `too_long`；空/全空白 → `invalid_params` |
| `model` | string | 1–128 字符，去空白后非空，不得含控制字符。**语义**：电脑侧真实标识（**逐字节敏感**），且必须来自该工具 `models.list` 的 `id` 集合（见 9.4）。空/超长/含控制字符 → `invalid_params`；不在集合里 → **`model_not_available`** |
| `provider` | string | **DSH 必填、Codex 必须省略**。1–128 字符，去空白后非空，不得含控制字符；**允许** `/` `-` `_` `.`（真实 provider 名里有）。缺失（DSH）/ 空 / 超长 / 含控制字符 → `invalid_params`；不在目录里 → `model_not_available` |
| `reasoningEffort` | string | 可选，1–64 字符，去空白后非空，不得含控制字符。必须取自 `models.list` 里该模型的 `reasoningEfforts` |
| `cwd` | string | 可选；电脑侧**绝对路径**。1–1024 字符，去空白后非空，不得含 NUL；`C:\...` / `\\server\share\...` / `/home/...` 三种形态都合法。**校验分两层**：(a) 形态与安全性 → **`invalid_params`**；(b) 电脑侧判定"不存在 / 不可用 / 桌面应用不接受" → **`session_create_failed`**。**缺省由电脑侧按该桌面应用自己的默认行为处理**，relay 不得替它补一个默认目录 |
| `projectId` | string | 可选；**必须是真实 `local/list_projects`（Codex）或 DSH 项目列表里的 id**（取自 `models.list` 的 `projects[].id`）。1–128 字符，去空白后非空，不得含控制字符；**允许**字母数字与 `.` `_` `-` `:`（本机原生 id 里会出现，例如 `proj_01H9-XYZ:abc`）。relay **不解释**这个命名空间，只校验形态。校验分两层同 `cwd` |
| `requestId` | string | **必填**；**UUID v4 小写**，正则同 4.1。**大写一律拒绝**。用于创建去重（9.6 铁律 5）。手机每次创建生成一个新的 v4 UUID，不得复用 |

- **成功 200**:

```json
{"ok":true,"result":{ ... }}
```

`result` 的形状由 `method` 决定，见第 9 节。

- **失败**:

| 场景 | 状态码 | `code` |
| --- | --- | --- |
| 无 cookie / cookie 非法 / 未知 / 已撤销 | 401 | `unauthenticated` |
| 缺 `method`、`method` 不是字符串 | 200 | `invalid_request` 改为 `invalid_params`（见下） |
| `method` 不在白名单 | 200 | `unknown_method` |
| `params` 有白名单外字段、缺必填字段、取值非法 | 200 | `invalid_params` |
| `params.text` 超 16384 | 200 | `too_long` |
| 电脑侧说会话不存在/不可见 | 200 | `session_not_found` |
| 电脑侧说会话已结束 | 200 | `session_gone` |
| 会话没声明对应能力 | 200 | `not_capable` |
| `session.stop` | 200 | `not_capable` |
| **`models.list`**: `tool` 当前不可用（应用没开 / 适配器没连） | **200** | **`ok:true`**（**不是错误**），`result.models: []`（可带 `result.reason`，见 9.5） |
| **`models.list`**: `capabilities` 里该工具的 `models.list` 位不为 `true` | 200 | `not_capable` |
| **`session.create`**: `tool` 当前不可用（应用没开 / 适配器没连） | 200 | `tool_unavailable` |
| **`session.create`**: `capabilities` 里该工具的 `session.create` 位不为 `true` | 200 | `not_capable` |
| **`session.create`**: `model`（或 `provider`）不在该工具当前 `models.list` 的集合里 | 200 | `model_not_available` |
| **`session.create`**: 电脑侧创建/配置失败（上游拒绝、`cwd` 不可用、桌面应用报错） | 200 | `session_create_failed` |
| 电脑侧执行失败 | 200 | `bridge_error`（`message` 用电脑给的安全文本） |
| 桥不在线 | 503 | `bridge_offline` |
| 待决已满 | 503 | `bridge_busy` |
| 超过 `timeoutMs` | 504 | `bridge_timeout` |
| 电脑回的 `result` 不符形状 | 502 | `bridge_bad_response` |
| 连接在等应答时断开 | 502 | `bridge_bad_response` |
| body 非法 JSON | 400 | `invalid_json` |
| body 顶层不是对象、`method` 缺失或类型错 | 400 | `invalid_request` |

> **`method` 缺失或类型错**归 `400 invalid_request`（"请求本身不成立"）；`method` 是字符串但不在白名单归 `200 unknown_method`（"请求成立、能力不足"）。这两条不要混。

- **超时与转发（写死）**:

| 项 | 值 |
| --- | --- |
| 单次 RPC 默认 `timeoutMs` | **30000**（30 秒） |
| `sessions.list`、`session.read`、**`models.list`** 的 `timeoutMs` | **15000**（15 秒） |
| `session.send`、`session.stop`、**`session.create`** 的 `timeoutMs` | **30000**（30 秒） |
| 手机可选的 `timeoutMs` 覆盖 | **允许但被夹紧到 1000–60000**；超出范围按边界值取；缺省用上表默认 |

- **移动端实时性（写死，避免"实时轮询"变成打服务器）**:
  - 实时看输出 = 对**同一个 `sessionId`** 反复调 `session.read`，**间隔 ≥ 2000 毫秒**；`status==="working"` 时建议 2000 ms，`status!=="working"` 时建议 5000 ms。
  - 两次 `session.read` 之间如果 `messages[].id` 集合没变，视为无变化（客户端自行比较，协议不额外发通知）。
  - 单设备对单会话的 `session.read` 频率超过 **1 次/秒**会被 `/api/rpc` 的限速拦（6.3）。

### 7.4 `POST /api/logout`

- **认证**: 必须。**`Origin` 检查**: 强制。**`Content-Type`**: 若带 body 则必须 `application/json`；**允许完全无 body**。**body 上限**: 1024。
- **两种用法（同一端点，靠是否带 `targetSessionId` 区分）**:

| 用法 | 谁可以调 | body | 效果 |
| --- | --- | --- | --- |
| 注销自己 | 任何已认证设备 | 无 body 或 `{}` | 使**当前这条** `rc_session` 立即失效 |
| 桥认证的设备撤销 | **必须**在同一个 TCP/TLS 请求里带 `Authorization: Bearer <bridgeToken>` | `{"targetSessionId":"<rc_session 的明文值>"}` | 使**指定的那条** `rc_session` 立即失效 |

- **请求体（可选）**:

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `targetSessionId` | string | 可选 | 43 字符的 `rc_session` 明文（正则同 4.1）。带了它就是"撤销指定设备" |

- **成功 200**（两种用法都是）:

```json
{"ok":true}
```
```
Set-Cookie: rc_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict
```
（"撤销指定设备"时，只有当 `targetSessionId` 就是当前 cookie 时才会带上清理 cookie；撤销别人的设备不改变自己的 cookie。）

- **失败**:

| 场景 | 状态码 | `code` |
| --- | --- | --- |
| 无 cookie | 401 | `unauthenticated` |
| 带 `targetSessionId` 但没有合法的 `Authorization: Bearer <bridgeToken>` | **403** | **`forbidden`** |
| `targetSessionId` 格式非法 | 400 | `invalid_request` |
| `targetSessionId` 不存在或已失效 | 200 | `ok:true`（**幂等**：撤销一个已失效的设备也算成功） |

> **更正痕迹（写给读到过 v1 的人）**: v1 里这一格退化成 **`401 unauthenticated`**，因为 6.2 表当时没有"已认证但无权"这一类码。**v2 起改用 `403 forbidden`**（这是 CRD 0003 的加法：§6.2 新增一个码，**没有改动任何已有码的名字、状态码或语义**）。语义区分保持不变：**401 = 没带上有效身份；403 = 身份有效但没权限**。
>
> 这条更正也回答了 v1 第 15 节 R4 提出的问题（已裁决：accepted）。**除这一格外，第 7.4 节其余内容与 v1 一致。**

- **撤销/注销的即刻性（写死）**: 使 `rc_session` 失效就是**从存储里删除它的哈希**。任何**后续**请求携带该 cookie 必须立刻得到 `401 unauthenticated`。已经完成中的请求不打断（30 秒内自然结束）。revoked 事件必须同时：把该设备从"在线设备"里移除、清掉它在该设备上的限速桶之外的任何内存态。
- **`rc_session` 的过期**: 30 天（`Max-Age` 与存储里的过期时间必须一致）。过期与撤销在协议上不可区分（都是 `401 unauthenticated`）。

### 7.5 `GET /downloads/*`

- **目的与边界**: 只用于把 **APK** 交给手机下载安装（公网入口是 `https://101.43.98.18/downloads/<file>.apk`）。**桌面 token、私密配置、任何非 APK 文件、任何路径穿越都必须被拒。**
- **认证**: 无。**`Origin` 检查**: 强制（5.3）。
- **写死的白名单规则（全部满足才允许）**:
  1. 请求路径必须以 `/downloads/` 开头。
  2. 取 `/downloads/` 之后的**剩余部分**，先做一次**百分号解码**，得到候选文件名。
  3. 候选文件名必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.apk$`（1–128 字符，`.apk` 结尾，不区分大小写）。
  4. 候选文件名中**不得**出现 `/`、`\`、`..`、`:`、NUL，也不得出现额外路径段（即解码后含 `/` 一律拒绝）。
  5. 解码后不等于原始剩余部分时（存在百分号编码）→ 允许，但必须用**解码后**的名字做第 3、4 条检查（避免 `%2e%2e%2f` 之类绕过）。
  6. 最终文件路径 = **白名单根目录**（部署时固定，例如 `/opt/ai-remote/downloads/`）**拼接**校验通过的文件名；拼接后必须 `realpath`，`realpath` 结果必须仍在白名单根目录之下（挡住符号链接逃逸）。
  7. 打开前用 `O_NOFOLLOW` 语义（拒绝是符号链接的文件）。
- **成功 200**: 直接流式返回文件。响应头：`Content-Type: application/vnd.android.package-archive`、`Content-Length: <字节数>`、`Content-Disposition: attachment; filename="<文件名>"`、`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`。**禁止目录列表**。
- **失败**:

| 场景 | 状态码 | `code` |
| --- | --- | --- |
| 文件不在白名单（扩展名不是 `.apk`、名字非法、含路径段） | 404 | `not_found` |
| 路径穿越尝试（含 `..`、含 `/`、编码绕过） | 404 | `not_found` |
| 符号链接逃逸白名单根目录 | 404 | `not_found` |
| 文件不存在 | 404 | `not_found` |
| 请求 `/downloads/` 之后为空或只指目录 | 404 | `not_found` |
| Origin 不匹配 | 403 | `origin_forbidden` |
| 非 `GET`/`HEAD` | 405 | `method_not_allowed`（带 `Allow: GET, HEAD`） |
| 触限速 | 429 | `rate_limited` |

- **一切拒绝都必须返回同一句** `not found`，**不得**区分"不该给你"和"没有这个文件"——否则本端点会变成文件系统探测器。
- **`HEAD` 允许**（返回同样的头，无 body）。**`POST`/`PUT`/`DELETE` 一律 405。**
- **手机端 APK 与网页端**（T-relay 的 DoD R12 同时提到"静态托管 `relay/web/`"）：`relay/web/` 的静态文件**不属于**本端点；它由单独的静态托管路径提供（PM 决定路径）。本端点**只**服务 APK 白名单。两者的路由不得互相回退。
- **禁止**在本端点下放任何 `.json`、`.db`、`.log`、`.yml`、`.pem`、`.key`、`.txt` 文件——即使它们恰好放在白名单根目录里，也必须 404（规则 3 已经保证：只放 `.apk` 能过）。

---

## 8. WebSocket 面：`/bridge`（电脑 → 服务器）

### 8.1 握手

- **URL**: `wss://101.43.98.18/bridge`（relay 本地是 `ws://127.0.0.1:8080/bridge`，由 Caddy 反代升级）。
- **鉴权**: `Authorization: Bearer <bridgeToken>`。token 缺失、格式不对、不匹配 → **HTTP 401**，**不升级**，响应 `{"ok":false,"error":{"code":"unauthenticated","message":"invalid bridge token"}}`。每次拒绝都要记一条审计（时间、来源 IP、结果），**不得记 token 本身**。
- **Origin**: **拒绝一切浏览器 Origin**。电脑端 bridge **不得**在握手请求里带 `Origin` 头（Node 的 WebSocket 客户端默认不发）；如果带了任何值 → **HTTP 403** `{"ok":false,"error":{"code":"origin_forbidden","message":"origin not allowed"}}`，**不升级**。
- **子协议**: 不使用 `Sec-WebSocket-Protocol`。不得用它承载 token。
- **其它**: 不使用 cookie。不得用 query 参数传 token。
- **同一 `bridgeToken` 允许多条连接**（重连窗口内新旧并存）；relay 必须能承受这一点，并在手机请求分发时按 9.4 的规则选一条。

### 8.2 帧格式

- **只允许文本帧**（JSON）。二进制帧 → 视为协议错误（8.5）。empty 文本帧 → 协议错误。
- **每帧最大 262144 字节（256 KiB）**。超限 → 协议错误并关闭连接（`1009 message too big`）。这条上限是为了让 `session.read` 的大历史也能过，但又不让一个恶意帧把 2G 机器打爆。
- **`type` 必须存在且为字符串**，取值只能是 8.3 里列出的 8 种。未知 `type` → **忽略该帧**（不关闭连接），并记一条审计。这一条让未来加消息类型时旧实现不会崩。

### 8.3 帧总表

| `type` | 方向 | 用途 |
| --- | --- | --- |
| `hello` | 电脑 → relay | 上线声明与能力上报 |
| `hello.ok` | relay → 电脑 | relay 接受该 hello，告知连接已就绪 |
| `ping` | 双向 | 心跳 |
| `pong` | 双向 | 心跳应答 |
| `pair.create` | 电脑 → relay | 请 relay 生成一个配对码 |
| `pair.created` | relay → 电脑 | 配对码已生成 |
| `pair.used` | relay → 电脑 | 该码刚被手机消费（含设备名，便于电脑端显示"谁配对了"） |
| `request` | relay → 电脑 | 手机的一次调用 |
| `response` | 电脑 → relay | 该调用的结果 |

> `pair.used` 是让用户能看见"有人用我的码配对了"的最小通知。它**不带** token、不带 cookie、不带手机 IP。

### 8.4 逐帧字段

#### 8.4.1 `hello`（电脑 → relay）

```json
{"type":"hello","version":1,"clientName":"DESKTOP-7F3A","capabilities":{}}
```

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `type` | string | 必填 | `"hello"` |
| `version` | integer | 必填 | **必须等于 `1`**。别的值 → relay 关闭连接（`1008 policy violation`）并记审计；电脑端应提示用户升级 |
| `clientName` | string | 必填 | 1–64 字符，去空白后非空 |
| `capabilities` | object | 必填 | 电脑声明的**方法集合**，见 9.7 |

- **在收到合法 `hello` 之前的任何其它帧**（`request` 是不可能的，因为 relay 还没把它算作在线）→ relay 关闭连接（`1008`）。**第一条帧必须是 `hello`**。
- `hello` 重复发送（同一连接第二次）→ 覆盖能力声明并回一次 `hello.ok`（幂等）。

#### 8.4.2 `hello.ok`（relay → 电脑）

```json
{"type":"hello.ok","version":1,"serverTime":"2026-10-08T03:58:07Z","heartbeatIntervalMs":20000,"idleTimeoutMs":60000,"requestTimeoutMs":30000,"maxPending":16}
```

| 字段 | 类型 | 必填 | 值 |
| --- | --- | --- | --- |
| `version` | integer | 必填 | 固定 `1` |
| `serverTime` | string | 必填 | RFC3339 UTC（4.2） |
| `heartbeatIntervalMs` | integer | 必填 | 固定 `20000` |
| `idleTimeoutMs` | integer | 必填 | 固定 `60000` |
| `requestTimeoutMs` | integer | 必填 | 固定 `30000` |
| `maxPending` | integer | 必填 | 固定 `16` |

- 电脑端**必须**按 `hello.ok` 给出的值做心跳，而不是写死自己的常量（relay 以后调大心跳间隔时，旧电脑端不会崩）。

#### 8.4.3 `ping` / `pong`

```json
{"type":"ping"}
```
```json
{"type":"pong"}
```

- 逐字面无其它字段。收到 `ping` **必须**立刻回 `pong`；收到 `pong` 就更新"最近活动时间"。
- **relay 主动发 `ping`**：每 `heartbeatIntervalMs`（20000 ms）一次。

#### 8.4.4 `pair.create`（电脑 → relay）

```json
{"type":"pair.create","id":"3f2504e0-4f89-41d3-9a0c-0305e82c3301"}
```

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `id` | string | 必填 | UUID v4 小写（4.1），**由电脑生成** |

- 电脑侧必须自己保证同一连接内 `id` 不重复。
- 频率限制：同一 bridge 连接 **60 秒内最多 10 次** `pair.create`；超出 → relay 回一个 `pair.created` 形状的**错误**是**不允许**的（见下）——正确做法是：relay 回 `{"type":"response","id":"<该 pair.create 的 id>","ok":false,"error":{"code":"rate_limited","message":"too many requests"}}`，并在第 60 秒前不再处理该连接的 `pair.create`。**这一条把 `response` 帧的用途扩展到 `pair.create` 的失败路径**；`pair.create` 成功仍然用 `pair.created`。

#### 8.4.5 `pair.created`（relay → 电脑）

```json
{"type":"pair.created","id":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","code":"K7QP-3MZD-9XTB-2RCV-6HNF-0JWS","expiresAt":"2026-10-08T04:03:07Z","url":"https://101.43.98.18/#pair=K7QP-3MZD-9XTB-2RCV-6HNF-0JWS"}
```

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `id` | string | 必填 | **原样回** `pair.create` 的 id |
| `code` | string | 必填 | 4.6 的规范形式（**带连字符**） |
| `expiresAt` | string | 必填 | RFC3339 UTC，等于签发时刻 + 300 秒 |
| `url` | string | 必填 | 固定拼法 `https://101.43.98.18/#pair=<code>`（code 用规范形式，**不额外编码**——Crockford 字母表里没有需要转义的字符） |

- **`url` 是给人扫/点的**：手机端打开它时，前端从 `location.hash` 里取 `pair=` 后面的 code。**hash 不会发给服务器**（这是把它放在 fragment 里的原因）。
- 电脑端**必须**把 `code` 当作秘密处理：只显示给正在电脑前的用户，**不得**写进日志、不得写进文件、不得进任何上报。过期后必须清掉本地副本，并把界面上显示的码换成"已过期，重新生成"。

#### 8.4.6 `pair.used`（relay → 电脑）

```json
{"type":"pair.used","codeId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","deviceName":"Pixel 8","at":"2026-10-08T03:59:41Z"}
```

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `codeId` | string | 必填 | == `pair.created` 里的 `id`（让电脑知道是哪一个码被用了） |
| `deviceName` | string | 必填 | 手机在 `POST /api/pair` 里给的 `deviceName`（已按 7.2 清洗） |
| `at` | string | 必填 | 消费成功的时刻，RFC3339 UTC |

- 这条帧**不含** `code`、不含 `rc_session`、不含手机 IP。
- 电脑端可以据此在界面上显示"已配对：Pixel 8"。

#### 8.4.7 `request`（relay → 电脑）

```json
{"type":"request","id":"9c858901-8a57-4791-81fe-4c455b099bc9","method":"session.send","params":{"tool":"codex","sessionId":"0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70","text":"继续"},"timeoutMs":30000}
```

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `id` | string | 必填 | UUID v4 小写，**relay 生成** |
| `method` | string | 必填 | 六个方法之一（`sessions.list` \| `session.read` \| `session.send` \| `session.stop` \| `models.list` \| `session.create`） |
| `params` | object | 必填 | 与 7.3 的 `params` **同形同约束**（已通过 relay 校验） |
| `timeoutMs` | integer | 必填 | 本次 RPC 的预算（毫秒），见 7.3 |

- **电脑端必须在 `timeoutMs` 内回 `response`**；超时由 relay 判定并回手机 504，电脑端即使晚了 1 毫秒回的帧也会被丢弃。
- 电脑端**不得**在同一个 `id` 上回两次。
- 电脑端**不得**为同一个 `request` 自己重试执行（`session.send` 重复执行 = 重复消息）。

#### 8.4.8 `response`（电脑 → relay）

成功：

```json
{"type":"response","id":"9c858901-8a57-4791-81fe-4c455b099bc9","ok":true,"result":{"accepted":true,"sessionId":"0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70"}}
```

失败：

```json
{"type":"response","id":"9c858901-8a57-4791-81fe-4c455b099bc9","ok":false,"error":{"code":"session_not_found","message":"session not found"}}
```

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `id` | string | 必填 | **必须与 `request.id` 逐字节相同** |
| `ok` | boolean | 必填 | 成功 `true`、失败 `false`。`ok:false` 用 `error` |
| `result` | object | `ok:true` 时必填 | 形状必须匹配该方法（第 9 节） |
| `error.code` | string | `ok:false` 时必填 | 只能取 6.2 表里**可以来自电脑侧**的码：`session_not_found` / `session_gone` / `not_capable` / `too_long` / `bridge_error` / `invalid_params` / `unknown_method`。其它码（例如 `unauthenticated`、`rate_limited`）→ relay 记为协议错误，回手机 `502 bridge_bad_response` |
| `error.message` | string | `ok:false` 时必填 | **安全文本**：≤120 字符，**不得**含堆栈、绝对路径、token、cookie、code、SQL、上游原文。**电脑端必须在原生错误进入这里之前做一次清洗**（只保留简短的人话） |

- **电脑端的清洗要求（写死）**: 电脑桥在构造 `error.message` 时，只允许使用**自己写的固定文案**或**经过白名单处理的短文本**；原生异常对象、`stack`、`errno`、命令行、文件路径一律**不得**直接 JSON 化进这一帧。

### 8.5 协议错误与关闭码（写死）

| 情况 | relay 行为 | WebSocket 关闭码 |
| --- | --- | --- |
| 二进制帧 | 关闭，记审计 | `1003 unsupported data` |
| 帧超过 256 KiB | 关闭，记审计 | `1009 message too big` |
| 首帧不是 `hello` | 关闭，记审计 | `1008 policy violation` |
| `hello.version != 1` | 关闭，记审计 | `1008 policy violation` |
| 帧不是合法 JSON 或顶层不是对象 | 关闭，记审计 | `1002 protocol error` |
| 未知 `type` | **忽略该帧**，连接继续 | 不关闭 |
| `response.id` 查不到（重复/伪造/已回收） | 丢弃该帧，记审计 | 不关闭 |
| `response` 的形状违反 8.4.8 | 按 8.4.8 转成 `502 bridge_bad_response` 给手机 | 不关闭 |
| 心跳超时（9.3） | 关闭 | `1001 going away` |

- 关闭前 relay 应尽力发一次 `Close` 帧并带上原因码；原因文本只写机器可读的短句（例如 `bad hello`），**不得**含 token。

---

## 9. **六个** method 的 `result` 形状（写死）

（v1–v3 这里是"四种"；v4 新增 `models.list` 与 `session.create`，于是变成六个。9.1–9.3 与 **9.4（`session.stop`）** 是原有的四个，**一字未改**；**9.5 / 9.6 是 v4 新增的两个**，排在原有四个之后；原来的 9.5（`capabilities`）顺移为 **9.7**。）

所有字段都是**必填**，除非标了"可选"。**多出来的字段**：relay **透传**（它只校验必填字段在不在、类型对不对），客户端**忽略**不认识的新字段 —— 依据是第 12 节第 4 条。

### 9.1 `sessions.list` → `result`

```json
{
  "sessions": [
    {
      "id": "0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70",
      "tool": "codex",
      "title": "重构 relay 的转发层",
      "status": "working",
      "updatedAt": "2026-10-08T03:57:55Z",
      "cwd": "D:\\workspace\\codex-workspace\\remote-control"
    }
  ],
  "capabilities": {
    "sessions.list": true,
    "session.read": true,
    "session.send": true,
    "session.stop": true,
    "stop:codex": false,
    "stop:dsh": true,
    "tools": ["codex", "dsh"]
  }
}
```

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `sessions` | array | 必填 | 0–200 条。超过 200 条时电脑只返回最近更新的 200 条（按 `updatedAt` 降序） |
| `sessions[].id` | string | 必填 | 同 4.1 的 `sessionId` 规则 |
| `sessions[].tool` | string | 必填 | `"codex"` \| `"dsh"` |
| `sessions[].title` | string | 必填 | 1–200 字符；不得为空；**不得**含换行控制字符 |
| `sessions[].status` | string | 必填 | 4.3 的四个值 |
| `sessions[].updatedAt` | string | 必填 | RFC3339 UTC（4.2） |
| `sessions[].cwd` | string \| null | 必填 | 电脑侧的会话工作目录；**取不到就显式 `null`**，不得省略该字段 |
| `capabilities` | object | 必填 | 见 9.7 |

- 排序：`updatedAt` 降序（最新在前）。相同 `updatedAt` 时按 `id` 升序，保证稳定。

### 9.2 `session.read` → `result`

```json
{
  "id": "0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70",
  "tool": "codex",
  "title": "重构 relay 的转发层",
  "status": "working",
  "messages": [
    {"id":"m-0001","role":"user","text":"帮我看看转发层","timestamp":"2026-10-08T03:55:02Z"},
    {"id":"m-0002","role":"assistant","text":"我先读一下现有的转发代码。","timestamp":"2026-10-08T03:55:09Z"}
  ],
  "canStop": true,
  "activeTurnId": "turn-7"
}
```

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `id` | string | 必填 | 请求里那个 `sessionId` |
| `tool` | string | 必填 | `"codex"` \| `"dsh"` |
| `title` | string | 必填 | 同 9.1 |
| `status` | string | 必填 | 4.3 的四个值 |
| `messages` | array | 必填 | **最近 ≤200 条**，**按时间升序**（最旧在前、最新在后） |
| `messages[].id` | string | 必填 | 电脑侧稳定消息 id，1–128 字符；**同一条消息在多次 `session.read` 之间 id 必须不变**（客户端靠它去重） |
| `messages[].role` | string | 必填 | 4.4 的四个值 |
| `messages[].text` | string | 必填 | 0–65536 字符。超过 65536 的**单条**消息截断到 65536，并在末尾加 `…`（一个字符） |
| `messages[].timestamp` | string | 必填 | RFC3339 UTC |
| `canStop` | boolean | 必填 | **本次会话当前能否停止**。`false` 时手机必须把停止按钮置灰 |
| `activeTurnId` | string | **可选** | `status==="working"` 时应给出（1–128 字符）；否则**必须省略该字段**（不得给 `null`） |
| `historyTruncated` | boolean | 可选 | **本次返回的消息不是全部历史**（因帧预算截断）。省略等价于 `false`（旧电脑侧不发 → 旧客户端行为不变）。**只描述本次结果被截断**，不表示会话有问题；手机不得因此禁用按钮、不得当错误处理 |

- **只读**: `session.read` 不得改变会话状态、不得发消息、不得触发 AI 继续。
- **`canStop` 的判定**（电脑侧写死）: `status==="working"` **且** 该会话的 `tool` 在 `capabilities` 里对应的 `stop:<tool>` 为 `true`。两个条件都满足才 `canStop:true`。

**长历史的截断预算（v5 新增，依据 CRD 0007；实证：200 条消息的 JSON = 287 733 字节，**同时超过两端 256 KiB 的帧上限**→ 电脑侧 `sendFrame` 返回 `false` → 手机侧只会看到超时）**:

- **上限不变**: §8.2 的**每帧 262144 字节（256 KiB）**继续有效，不得为了塞下历史而提高它。
- **电脑侧义务（写死）**: 按 **UTF-8 完整 envelope（整条 `response` 帧，含 `type` / `id` / `ok` / `result` 的 JSON 外壳与转义）预算 ≤ 240 KiB** 来裁剪 `messages`：
  - **优先丢更旧的消息**（`messages` 是升序的，所以从**头部**丢，保留尾部）；
  - **截断过长的工具输出**（单条消息按 9.2 的 65536 上限先截，再按预算继续裁）；
  - **一旦发生任何截断**，**必须**在 `result` 里置 **`historyTruncated: true`**。没截断时**可以省略**该字段（省略等价于 `false`）。
- **发送失败必须回一个短错误**: 电脑侧若发现帧仍然发不出去（超预算或底层写失败），**必须**回一条**短**的 `ok:false`（`bridge_error`，安全文本），**不得**静默返回 `false`、**不得**什么都不发——**沉默正是本次超时的原因**，它让手机只能等到 504。
- **`capabilities` 不新增位（写死）**: `historyTruncated` 是**可选字段**，不是能力。手机**不得**用任何一个 `capabilities` 键去猜它有没有；旧电脑侧根本不发这个字段时，手机按"没有截断"处理即可。
- **手机端（写死）**: `historyTruncated === true` 时，在消息列表顶部给一句提示（例如"更早的历史已省略"），**不得**把它当错误、**不得**禁用任何按钮、**不得**自动重试。它**不**表示会话有问题。

### 9.3 `session.send` → `result`

```json
{"accepted":true,"sessionId":"0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70"}
```

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `accepted` | boolean | 必填 | **固定 `true`**（失败用 `ok:false` + `error` 表达，不用 `accepted:false`） |
| `sessionId` | string | 必填 | == 请求里的 `sessionId` |

- **语义（写死，这是整个作业最容易被做错的一条）**: `accepted:true` 只表示**消息已交给电脑侧那个真实会话的输入口**，**不表示**AI 已完成回复。手机的"AI 回复"靠后续 `session.read` 的 `messages` 增长看到。
- 电脑侧必须把文本送进**已打开的那一个会话**（C3）：**不新建会话、不重放历史、不改写历史**。
- 重发风险由客户端规则兜住：`session.send` 在超时/断线后**不自动重发**（第 11 节）。

### 9.6 `session.stop` → `result`

```json
{"accepted":true,"sessionId":"0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70"}
```

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `accepted` | boolean | 必填 | **固定 `true`** |
| `sessionId` | string | 必填 | == 请求里的 `sessionId` |

- **能力门（写死）**: 会话对应的 `capabilities["stop:<tool>"]` 不为 `true` 时，`session.stop` **必须**返回 `ok:false` + `not_capable`，**不得**假装成功。手机上必须在此之前就把按钮置灰（`canStop`）。
- `accepted:true` 表示"停止请求已被接受"，不保证会话已经停在某一瞬间；后续状态靠 `session.read` 的 `status` 变化观察。

### 9.4 `models.list` → `result`

**用途**: 让手机知道**这台电脑上该工具当前真实可用**的模型（以及可用的项目），供"新建会话"面板选择。手机**不得**自己写一份模型清单。**本节依据 CRD 0006 定稿**。

```json
{
  "tool": "dsh",
  "models": [
    {
      "id": "deepseek-chat",
      "label": "DeepSeek Chat",
      "provider": "deepseek",
      "isDefault": true,
      "reasoningEfforts": ["low", "medium", "high"],
      "defaultReasoningEffort": "medium"
    },
    { "id": "qwen3", "label": "Qwen3", "provider": "ollama" }
  ],
  "projects": [
    { "id": "proj_01H9-XYZ:abc", "name": "remote-control", "cwd": "D:\\workspace\\codex-workspace\\remote-control" }
  ]
}
```

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `tool` | string | 必填 | **回显请求里的 `tool`**（`"codex"` \| `"dsh"`）。让手机把"面板属于哪个工具"和"拿到的是哪个工具的结果"对上，不用靠请求顺序猜 |
| `models` | array | 必填 | **0–200** 条（顺序**由电脑决定**，但同一份目录的两次调用顺序必须稳定）。**查不到任何模型时必须是 `[]`**，不得省略该字段、不得给 `null` |
| `models[].id` | string | 必填 | **拿到它传给 `session.create` 用的就是它**。电脑侧**真实**的模型标识，1–128 字符、去空白后非空、不得含控制字符。**逐字节敏感**（大小写、点号、连字符都算区别）；relay **不做归一化、不做大小写转换、不做别名替换** |
| `models[].label` | string | 必填 | 1–200 字符，给人看的中文/英文名；去空白后不得为空、不得含换行控制字符。**只用于显示**，任何一侧都不得拿 `label` 去调 `session.create` |
| `models[].provider` | string | **DSH 必有；Codex 不得有** | DSH 的 **providerId**，来自本机 DSH 目录。1–128 字符、去空白后非空、不得含控制字符；**允许** `/` `-` `_` `.`（真实 provider 名里会出现，例如 `azure-openai/us-east-1`）。**`session.create` 的 `provider` 必须从这里取** |
| `models[].isDefault` | boolean | 可选 | 该工具下**是否默认选中**。省略等价于 `false`。**注意字段名是 `isDefault`，不是 `default`**。同一份结果里**最多一个 `true`**；万一给了多个，客户端取 `id` 升序的第一个、其余按 `false` 看 |
| `models[].reasoningEfforts` | string[] | 可选 | 该模型**可选**的思考档位（例如 `["low","medium","high"]`）。**只有该工具/该模型支持时才给**；去重，顺序由电脑决定。手机把它作为可选项展示 |
| `models[].defaultReasoningEffort` | string | 可选 | 该模型**默认**的思考档位，**应当**是 `reasoningEfforts` 里的一个成员。给了 `defaultReasoningEffort` 却没有 `reasoningEfforts` 时，客户端把它当作唯一档位 |
| `projects` | array | 可选 | 0–200 条，该工具当前可以建会话的**真实项目**。**允许省略**（省略 = 手机不显示项目选择）。给了就必须是数组 |
| `projects[].id` | string | 必填（在 `projects[]` 里） | **真实 projectId**，来自 **Codex 的 `local/list_projects`** 或 DSH 自己的项目列表。1–128 字符、去空白后非空；**允许**字母数字与 `.` `_` `-` `:`（本机原生 id 里会出现，例如 `proj_01H9-XYZ:abc`），不得含控制字符 |
| `projects[].name` | string | 必填（在 `projects[]` 里） | 1–200 字符，给人看的名字；去空白后不得为空 |
| `projects[].cwd` | string | 必填（在 `projects[]` 里） | 该项目的绝对路径，1–1024 字符，去空白后非空、不得含 NUL。**三个字段一个都不能少**：缺 `cwd` 的项目对象视为形状不合（relay → `bridge_bad_response`） |
| `reason` | string | 可选 | **只在 `models` 为 `[]` 时有意义**，且此时**应当给出**（1–300 字符、安全文本、不得含路径与堆栈）。给手机**显示**用（例如"codex app is not running"），**不是错误码**，手机**不得**按它分支 |

- **允许多余字段（写死）**: 上表之外的字段（例如 `contextWindow`、`futureField`）一律**透传、忽略、不得报错**（§12.4）。relay 对 `result` 只校验**必填字段**在不在、类型与取值合不合法；**本节不写 `...` 占位符** —— 想要附加字段，就必须由电脑侧在自己的实现文档里写明类型与含义，本契约不为未列出的字段背书。
- **模型必须来自电脑侧的真实能力（写死，本节的重点）**:
  - `models[]` 的**唯一合法来源**是：**真实本机 DSH 目录**（`session/modelCatalog`，见 §15 R14），或 **Codex 当前 `create_thread` 的真实 schema**（见 §15 R13）。
  - **禁止**硬编码常量表、禁止凭记忆补一份、禁止猜测；**没有目录就返回 `models: []`，不许假填**。
  - **不得**由手机网页硬编码或猜测；**不得**由 relay 缓存或构造（relay **不得缓存**本结果；手机**不得**长期缓存它——每次打开新建面板或用户手动刷新时重新调一次）。
  - **默认项（写死）**: `isDefault: true` **只有在本机原生默认已被确认时才允许给**。无法确认哪个模型是本机原生默认（或压根没有目录）时，**要明确表示"不支持"**：所有模型一律 `isDefault: false`（或省略该字段），**不得假填一个**。手机端此时按"没有默认项"处理——让用户自己选，**不得**擅自把列表第一项当默认。
- **`models` 为空数组的语义（写死）**: `200 {"ok":true,"result":{"tool":…,"models":[]}}`（可带 `reason`）**不是错误**。手机端必须显示"该工具当前没有可用模型"（有 `reason` 就显示 `reason`）并**禁用新建**。
- **该工具不可用时的返回值（写死）**: 该工具**当前不可用**（桌面应用没开、适配器没连上）**不是错误**，返回：

```json
{"ok":true,"result":{"tool":"codex","models":[],"reason":"codex app is not running"}}
```

- **为什么选"`models: []` + `reason`"而不是"`ok:false` + 错误码"**: 沿用 §9.7 已有的判例——"电脑还没配好会话来源"表现为"**连上了但没有会话**"（`sessions: []`），而不是"连不上"。同理 `models.list` 回答的是"**有什么**"，"什么都没有"和"这个工具现在没有"对手机是**同一个动作**（显示原因 + 禁用新建），不该分裂成两个分支。
- **与 `capabilities` 的边界（写死，避免两处冲突）**:
  - **只有当整条 bridge 离线**时才回 **503 `bridge_offline`**（既有码，v4 不新增传输层码）。
  - **`capabilities` 里该工具的 `models.list` 位不为 `true`** 时回 **`not_capable`**：那是"这台电脑**根本不提供**这个能力"，与"提供了但这会儿没有模型"是**两件不同的事**，必须能分开。
  - 因此三种结果互不重叠：**能力没有** → `not_capable`；**能力有、这工具没开** → `ok:true` + `models:[]` + `reason`；**能力有、有模型** → `ok:true` + 非空 `models`。电脑侧**不得**用 `ok:false` 表达"当前没有模型"。
  - **`params` 只有 `tool` 一个字段**（必填）：多给任何字段 → `invalid_params`（连 `model`、`sessionId` 都不允许出现）。

### 9.5 `session.create` → `result`

**用途**: 手机在**电脑上那个桌面应用里**新建一条真实会话，成为该应用的一条新会话。**本节依据 CRD 0006 定稿**（形状抄给它三份 brief，逐字相同）。

**请求**（`params`，示例是"所有字段都给上"的样子）:

```json
{"method":"session.create","params":{"tool":"dsh","model":"deepseek-chat","provider":"deepseek","reasoningEffort":"medium","cwd":"D:\\workspace\\codex-workspace\\remote-control","projectId":"proj_01H9-XYZ","text":"帮我看看这个仓库","requestId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301"}}
```

- `provider` **仅 DSH 用**（Codex 省略）。
- `reasoningEffort` / `cwd` / `projectId` / `text` **均可省略**（省略规则见下面的省略规则一条）。
- **`requestId` 必填。**

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `tool` | string | 必填 | `"codex"` \| `"dsh"`（4.5），含义与 `models.list` 的 `tool` **完全一致**：用哪个应用 |
| `model` | string | 必填 | **必须来自 `models.list` 返回的 `id`**（同一 `tool` 的那一份）。1–128 字符、非空、不得含控制字符。**逐字节敏感**。不在集合里 → `model_not_available`；类型/空/长度/字符非法 → `invalid_params` |
| `provider` | string | **`tool:"dsh"` 时必填；`tool:"codex"` 时不得出现** | DSH 的 **providerId**，**必须**取自该模型在 `models.list` 里的 `provider`。1–128 字符、去空白后非空、允许 `/` `-` `_` `.`。**为什么必填（写死）**：同一个 `model` id 在 DSH 上可能同时存在于**多个 provider**（实测同一 model ID 有 3 个 provider），**不传 `provider` 就丢路由、落到不确定的那个**。缺字段或与目录不符 → `invalid_params` / `model_not_available` |
| `reasoningEffort` | string | 可选 | 思考档位。**允许提交**（不是只读展示字段），取值**必须**是该模型 `reasoningEfforts` 里的成员；**不在集合里 → `invalid_params`**（**契约侧只校验形态与"给得出来就得在集合里"；对真实 catalog 的核对由电脑侧做**——它才是唯一知道目录的人）。**映射（写死）**：Codex 侧映射到 `create_thread` 的 **`thinking`**；DSH 侧映射到 **`selectModel` 的 reasoningEffort**。省略 = 用 `defaultReasoningEffort`（若给了）/ 电脑侧默认 |
| `cwd` | string | 可选 | 电脑侧**绝对路径**。1–1024 字符、去空白后非空、不得含 NUL。**允许** `C:\...`、`\\server\share\...`、`/home/...` 三种真实形态。省略时由电脑侧按该桌面应用自己的默认行为决定，**relay 不补默认值** |
| `projectId` | string | 可选 | 项目 id，取值来自 `models.list` 的 `projects[].id`。**Codex 只允许真实 `local/list_projects` 的 id**；**禁止** worktree、**禁止** cloud。1–128 字符、去空白后非空、不得含控制字符；**允许**字母数字与 `.` `_` `-` `:`（本机原生 id 里会出现，例如 `proj_01H9-XYZ:abc`）。与 `cwd` 同时给出时由电脑侧决定优先级并写进实现说明；**不在真实项目列表里 → `invalid_params`**（格式/安全性问题同样是 `invalid_params`；**只有"目录用不了"这一类电脑侧运行时拒绝才归 `session_create_failed`**） |
| `text` | string | 可选 | 首条消息正文，规则与 `session.send` 的 `text` **完全相同**（1–16384 字符、去空白后非空、不得含 NUL；超长 → `too_long`、空/全空白 → `invalid_params`）。**省略 = 只建会话、不发第一条消息** |
| `requestId` | string | **必填** | **创建去重键**。同一 `requestId` 重复到达时，电脑侧**不得**再建第二条：要么返回**第一次**创建的结果（`sessionId` 相同），要么回 `session_create_failed` 并说明"结果未知/请查询"。格式必须是小写 UUID v4（`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`），否则 `invalid_params`。**持久化要求**：电脑侧**至少要把 `requestId` 与结果一起持久记录**（进程重启后仍能去重）；做不到持久时，必须**明确返回"结果未知"**并且**不自动重建** |

- **`title` 不是 `params` 字段**：它是 `result` 里那个可选字段（见下面的成功 `result` 表）。把它发给 `session.create` 就是多余字段 → `invalid_params`。

- **可选字段的省略规则（写死）**: 可选字段**要么给一个合法值，要么整个省略**。**不得**给 `null`、不得给空串、不得给 `"   "`——那三种都按 `invalid_params` 拒绝。手机把空白的可选输入直接丢掉，不要发出去。

**成功 `result`**:

```json
{"sessionId":"0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70","tool":"codex","model":"gpt-5-codex","title":"帮我看看这个仓库"}
```
```json
{"sessionId":"7a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5e","tool":"dsh","title":"继续","model":"deepseek-reasoner","provider":"deepseek","reasoningEffort":"high"}
```

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `sessionId` | string | 必填 | **新建会话的真实 id**，满足 4.1 的 `sessionId` 规则（`^[A-Za-z0-9._:-]{1,128}$`）。**与 `sessions.list` / `session.read` / `session.send` / `session.stop` 是同一个 id 空间** —— 手机拿到它之后直接当普通 `sessionId` 用，**不需要任何转换、映射或注册步骤** |
| `tool` | string | 必填 | 回显请求里的 `tool` |
| `model` | string | 必填 | 回显请求里的 `model`（**逐字节**）。它让手机确认"电脑真的按我要的模型建的"，而不是悄悄换成默认模型 |
| `provider` | string | 可选 | 回显请求里的 `provider`（仅 DSH 会有）。**逐字节**回显，让手机确认路由到的是同一个 provider |
| `reasoningEffort` | string | 可选 | 回显请求里的 `reasoningEffort`（若有）。让手机确认档位被采纳 |
| `title` | string | 可选 | 电脑侧给新会话起的标题，1–200 字符，规则同 9.1 的 `sessions[].title`。暂时没有标题就**省略该字段**（不得给 `null`、不得给空串） |

- **成功形状里没有 `accepted`（写死）**: `session.create` **不得**模仿 `session.send` / `session.stop` 回 `{"accepted":true,...}`。一次 create **要么真的建出一条会话**（回真实 `sessionId`），**要么就是失败**——"已受理但还没建"这种中间态不允许出现在成功路径上。（`{"accepted":true,"sessionId":…}` 形状不合法 → relay 回 `bridge_bad_response`。）
- **允许多余字段（写死）**: 上表之外的字段（例如 `futureField`）**透传、忽略、不得报错**（§12.4）；relay 只校验上表必填字段在不在、类型与取值合不合法。

**实现铁律（逐条写死，这八条是这条需求的灵魂，电脑侧必须做到）**:

1. **必须落在"电脑上那个桌面应用"里 —— 不得在命令行另起 CLI / appserver 充当新会话。**
   - **Codex**: 用 app-tools 的 **`create_thread`**（真实桌面线程，它自带 `model` 与 `thinking`）。
   - **DSH**: 用正式的 **`session/create`**。
   - 命令行独立进程与"应用内新会话"在手机上**无法分辨**，所以这条只能由电脑侧在实现里保证，**不可能靠手机端检查**。它决定实现方向，不是建议。
2. **Codex 的项目只能选真实的 `local/list_projects` id**。**禁止 worktree、禁止 cloud**（`create_thread.target` 里那两种形态不得使用）。
3. **DSH 创建之后要再调一次 `selectModel`，然后 `prompt` 一次**：建会话、选模型、发首条消息是**三个真实步骤**，不得只做第一步就宣布成功。
4. **已创建但后续步骤失败（`selectModel` / `prompt` / 首条消息失败）→ 必须报告已经建出来的那个 `sessionId`，禁止盲目重试**（详细规则见下面"部分成功"一条）。
5. **`requestId` 用于创建去重**。电脑侧**至少要持久记录**已处理的 `requestId`（进程重启后仍能去重）；**做不到持久记录时，必须明确返回"结果未知"，并且不自动重建**。同一个 `requestId` 第二次到达时：
   - 能确认前一次的结果 → **直接回同一个结果**（同一条 `sessionId`），**不得再建一条**；
   - 不能确认，但**能查到**该 `requestId` 对应会话确实存在 → 回**那个已存在的 `sessionId`**（按"已创建"处理，见"部分成功"第 3 条）；
   - 既不能确认、又查不到 → 回 `session_create_failed`，`message` 用契约固定的 `create result unknown`，**不得**再建一条、**不得**猜测。
   - 这一条与第 11 节的"不自动重发"是**两件事**：那条管**客户端**不自动重发，这条管**电脑侧**即使收到重复请求也**不得**重复创建。
6. **闭环（本方法的验收线）**: 创建成功后该会话**必须**能被 `sessions.list` 看到、能被 `session.read` 读到，`sessionId` 与 `sessions.list` **同一 id 空间**。**创建成功但 `sessions.list` 里看不到 = 没建成**，属于实现错误，不是"最终一致"。手机端拿到 `sessionId` 后的第一件事就是调一次 `session.read` 把它打开——这也顺便验证了闭环。
7. **首条消息 `text` 只发一次**（写死）: 手机**不得**在创建成功后再补发一次 `text`；失败后**由用户重新点击**触发（与 `session.send` 的"不自动重发"同一原则，第 11 节）。
8. **默认模型项**：`models.list` 里的 `isDefault: true` **只有在本机原生默认已被确认时才允许出现**。**不支持 / 没有目录 → 明确表示不支持，不许假填**（见 9.4「默认项」那一条）。

**部分成功（写死，禁止"整次失败后让用户再建一条"）**:

1. **一旦电脑侧真的创建出了会话**，`session.create` **必须**把**已创建的 `sessionId`** 返回给手机（`ok:true` + `result.sessionId`），并在结果里用一个明确字段标注"创建成功但后续步骤未完成 / 未完成到哪一步"（字段名由电脑侧定，**必须**写进实现说明与 `capabilities` 文档）。
2. **`selectModel` / `prompt` 失败时**：**保留**该 `sessionId` 给手机，让用户**打开它**、并在同一会话里**重试发送**。**禁止**把它藏起来当作"整次失败"，**禁止**引导用户再点一次新建 —— 那会**制造孤儿会话与重复会话**。
3. **超时 / 结果未知时**（电脑侧无法确认是否建成功）：**必须**先去 `sessions.list` **查询**该 `requestId` 对应的会话是否存在，**不得**盲目重建。查不到再按"未创建"处理。
4. **`requestId` 贯穿全程**：重试、超时、进程重启后的去重都靠它。
5. 手机端**不得**因为"后续步骤失败"就丢弃 `sessionId`：新会话必须出现在列表里并可被打开（见闭环要求）。

**手机端怎么读"部分成功"（写死，与上一段配对）**: 手机**不得猜测**——它按下面两步判断，两步都不需要电脑侧新字段就一定能工作：

- **第一步（永远有效）**: 拿到 `sessionId` 后立刻 `sessions.list`（或直接对 `sessionId` 调一次 `session.read`）。**查得到 = 已创建**：把这条会话显示出来，允许用户打开、允许用户在同一会话里重新发送；**绝不**自动再创建。**查不到 = 没建成**：按"未创建"处理。
- **第二步（电脑侧给了就更好）**: 电脑侧若在 `result` 里给了那个"未完成到哪一步"的字段，手机优先用它**直接把话说明白**（例如"会话已建好，但模型没设上/首条消息没发出去"）。电脑侧**没给**该字段时，手机**不得**因此认为创建失败——按第一步的结论走。

**错误情况（写死，逐条给码）**:

| 触发条件 | HTTP | `code` | 谁判定 |
| --- | --- | --- | --- |
| `params.model`（或 DSH 的 `provider`）不在该工具**当前** `models.list` 的集合里 | **200** | `model_not_available` | 电脑侧（只有它知道真实目录） |
| 该工具当前不可用（桌面应用没开 / 适配器没连上） | **200** | `tool_unavailable` | 电脑侧 |
| `capabilities` 里该工具的 `session.create` 位不为 `true` | 200 | `not_capable` | relay（能力门）**与**电脑侧（不假装成功） |
| `cwd` / `projectId` 形态或安全性非法（类型错、超长、含 NUL、含控制字符） | 200 | `invalid_params` | relay |
| 电脑侧判定 `cwd` / `projectId` 不存在、不可用或桌面应用不接受 | **200** | `session_create_failed` | 电脑侧 |
| 电脑侧创建/配置失败（桌面应用拒绝、`create_thread` / `session/create` / `selectModel` / `prompt` 任一步上游报错） | **200** | `session_create_failed` | 电脑侧 |
| 重复 `requestId`，电脑侧**既不能确认结果、也查不到**该会话（铁律 5） | **200** | `session_create_failed`，`message` = `create result unknown` | 电脑侧 |
| 电脑**离线**（没有已 `hello` 的连接） | **503** | `bridge_offline` | relay |
| 超过该方法的 `timeoutMs`（默认 30000） | **504** | `bridge_timeout` | relay |
| 待决已满（单连接 16 / 全局 64） | **503** | `bridge_busy` | relay |
| 电脑回的 `result` 不符本节形状（含回了 `accepted`、缺 `sessionId`、`sessionId` 含空格等） | **502** | `bridge_bad_response` | relay |
| 连接在等应答时断开 | **502** | `bridge_bad_response` | relay |
| `tool` 缺失 / 不是 `"codex"` / `"dsh"` | 200 | `invalid_params` | relay |
| `model` 缺失 / 类型错 / 空 / 长度或字符非法 | 200 | `invalid_params` | relay |
| **DSH 缺 `provider`**，或 `provider` 含控制字符 / 超长 / 空 | 200 | `invalid_params` | relay（**缺 provider 是请求不成立，不是 `model_not_available`**） |
| `requestId` 缺失 / 不是 v4 / **是大写** / 空 | 200 | `invalid_params` | relay |
| 未知字段（例如 `sudo`、`callerSource`） | 200 | `invalid_params` | relay |
| `text` 给了但超 16384 | 200 | `too_long` | relay |
| `text` 给了但去空白后为空 | 200 | `invalid_params` | relay |

- **`cwd` / `projectId` 为什么不新增错误码（写死）**: "请求本身不成立"（形态与安全）用既有的 `invalid_params`；"请求成立但这个目录/项目用不了"归入 `session_create_failed`。**不新增第四个码**——手机对这两种情况的动作是同一个：把 `message` 显示给用户，让他改。多一个 `cwd_not_found` 只会给手机添一个没有不同处理的分支。
- **"已创建但后续失败"不是错误（写死，改自早期草稿）**: 一旦真的建出了会话，响应就是 **`ok:true` + `result.sessionId`**（见上面的"部分成功"）。**不得**把它塞进 `ok:false`，**不得**用 `error.sessionId` 之类的自定义错误字段表达它——早期草稿曾这么写，**已作废**：`ok:false` 只表示**没有建出会话**。手机对这两者的处理完全不同（有 `sessionId` = 打开它；无 `sessionId` = 没建成，可以重新点）。
- **结果未知（`create result unknown`）怎么写（写死）**: `{"ok":false,"error":{"code":"session_create_failed","message":"create result unknown"}}`，**不带任何 `sessionId`**。手机必须提示用户"结果未知，请先刷新列表看看有没有建出来"，**不得**自动重建。
- **客户端不得按 `message` 分支**（§6.1 的规则）：`create result unknown` 这句固定文案只是给人看的说法；手机的分支点只有 **`code`** 与 **`result.sessionId` 在不在**。因此**本条不新增错误信封字段**——错误体保持 §6.1 的三字段形状（`ok` / `error.code` / `error.message`）。
- **电脑侧若只回 `ok:false` + `bridge_error`**（内部没分类），relay **不得**改写它，原样透传；手机按 `session_create_failed` 的样式显示（§12.4 未知码的降级规则）。
- **relay 不得**在电脑侧拒绝后替用户"改成默认模型再试一次"——**不得重试、不得替换参数、不得补默认值**。
- **不得因为这六个方法产生任何"执行任意命令"的通道（写死）**: relay 只转发这六个 method，`session.create` 的字段**只允许上表那八个**；**不得**出现 `shell` / `exec` / `argv` 之类的字段，**不得**有 `callerSource` 之类能改写上游调用身份的绕过字段（CRD 0006 第三节）。任何上表之外的字段一律 `invalid_params`。

### 9.7 `capabilities` 的形状与来源（写死）

- **来源**: 电脑在 `hello.capabilities` 里上报（第 8.4.1）。relay **原样保存**，并在每次 `sessions.list` 的 `result.capabilities` 里返回**同一份声明**（不做合并、不做推断）。
- **形状**: 对象，键是固定字符串，值是 `boolean`，外加一个 `tools` 数组：

| 键 | 类型 | 含义 |
| --- | --- | --- |
| `sessions.list` | boolean | 是否支持列会话 |
| `session.read` | boolean | 是否支持读历史 |
| `session.send` | boolean | 是否支持发送 |
| `session.stop` | boolean | 是否支持停止（**任一会话**） |
| `stop:codex` | boolean | Codex 会话是否支持停止 |
| `stop:dsh` | boolean | DSH 会话是否支持停止 |
| `models.list:codex` | boolean | **v4 新增**：Codex 是否支持列出模型（即该工具的 `models.list` 是否可用） |
| `models.list:dsh` | boolean | **v4 新增**：DSH 是否支持列出模型 |
| `session.create:codex` | boolean | **v4 新增**：Codex 是否支持新建会话（即该工具的 `session.create` 是否可用） |
| `session.create:dsh` | boolean | **v4 新增**：DSH 是否支持新建会话 |
| `tools` | string[] | 实际上报的会话来源，取值 `"codex"` / `"dsh"`，**至少 1 个**，不得有重复 |

- **缺键的默认值（写死）**: 任何**未出现**的键按 `false` 处理。**不开默认放行**——这是"不假装可用"的实现基础。
- **`tools` 为空数组或缺失时（写死）**: relay **接受**该 `hello`（回 `hello.ok`），**不得**把它当成连接失败；但把此后所有 `sessions.list` 的 `result` 裁剪为 `sessions: []`（`capabilities` 照原样返回）。手机端据此显示"电脑上没有可用的会话来源"。理由：一台还没配好会话来源的电脑，应该表现为"连上了但没有会话"，而不是"连不上"。
- **手机端的用法（写死）**: 手机**只能**根据 `capabilities` 与 `canStop` 决定按钮可用性；**不得**用一个本地写死的常量决定。`canStop` 是**每会话**的，`capabilities` 是**整机**的；两者同时满足才允许点停止。
- **v4 新增的四个位怎么用（写死）**: `models.list:codex` / `models.list:dsh` / `session.create:codex` / `session.create:dsh` 决定**新建面板里每个工具是否可选**：该工具的 `session.create:<tool>` 不为 `true` 时，手机**不得**允许在该工具下新建（**置灰并给出原因**，不是隐藏）；该工具的 `models.list:<tool>` 不为 `true` 时，手机**不得**去调 `models.list`，直接按"该工具不能新建"显示。**同样不得**用本地硬编码常量决定这四件事。
- **两种写法都合法（写死，避免两侧对不上）**: 既接受**扁平**的两个键 `models.list` / `session.create`（指"至少有一个工具支持"），也接受**带工具后缀**的四个键（见上表）。两种同时出现时以**带后缀的**为准。任一形式缺失时按 `false` 处理（沿用"缺键即 false"）。**relay 一律原样透传，不得只转发它自己认识的键**（§12.4）。
- **手机必须显示但禁用**: 不支持的按钮**置灰并给出原因文案**，不得隐藏后假装没这功能，也不得可点后返回失败。

---

## 10. 一致性与生命周期（写死）

### 10.1 一条 RPC 的完整生命周期

```
手机 POST /api/rpc
  → relay 校验 Origin / Content-Type / 大小 / cookie / method / params
  → relay 取 bridge：没有已 hello 的连接 → 503 bridge_offline
  → relay 把待决数 +1 并做上限检查 → 超限 → 503 bridge_busy（+ Retry-After: 1）
  → relay 生成 id，存 {id → 手机连接、method、params、deadline}
  → relay 把 {type:'request',...} 发给电脑
  → 电脑执行，回 {type:'response',id,...}
  → relay 按 id 找到待决项，校验 result 形状，回手机 200 {ok:true,result} 或 200 {ok:false,error}
  → relay 删除待决项（无论成功/失败）
```

### 10.2 待决（pending）的上限与回收（写死）

| 项 | 值 |
| --- | --- |
| **单条 bridge 连接的待决上限** | **16** |
| **relay 全局待决上限** | **64** |
| 达到任一上限 | 新请求立刻 **503 `bridge_busy`** + `Retry-After: 1`；**不排队、不落盘** |
| 单请求超时 | 按 7.3 的 `timeoutMs`（15 s / 30 s） |
| 超时到达时 | 回手机 **504 `bridge_timeout`**，并立刻删除待决项 |
| 超时后电脑才回的 `response` | **丢弃**，记一条审计（含 id 与耗时），**不改任何状态** |
| 电脑在等待中断线 | 该连接上**全部**待决项立刻回手机 **502 `bridge_bad_response`**（`message: "bridge disconnected"`），并删除 |
| relay 收到重复 `response`（同 id 第二次） | 丢弃 + 审计 |
| relay 收到未知 id 的 `response` | 丢弃 + 审计 |
| 手机在等待中断开（客户端断开 HTTP 连接） | relay 在**下一次写响应失败**时删除待决项；最长不超过该请求的 `timeoutMs` |
| 待决项数量上限的计数粒度 | 全局计数 + 每连接计数，两个都要维护 |

- **待决项只存在内存里**。relay 重启 = 所有待决项消失（客户端收到的是连接断开）。
- **待决项不得写入 SQLite**。
- **不重试发送**: relay 在超时后**不得**重新发一次 `request`；**不得**在电脑重连后补发旧请求。要重试只能等用户再点一次。

### 10.3 电脑侧选一条连接（同一 token 多条连接时）

按下列顺序选一条，用于分发 `request`：

1. 已通过 `hello` 的连接（未 hello 的不算）；
2. 其中待决数 < 16 的；
3. 其中**待决数最少**的；
4. 仍并列时取**最近一次收到帧**的连接。

一条连接都不满足 → `503 bridge_offline`（若"有连接但全满"则 `503 bridge_busy`）。

### 10.4 断线重连与消息不重复（写死）

- **relay 侧**: 电脑断线 → 该连接所有待决项按 10.2 完结；`bridgeOnline` 重算（可能变 `false`）。
- **电脑侧重连**: 必须**指数退避**，序列（毫秒，**写死**）：
  `1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, …`（从第 6 次起固定 30000 ms）
  - 每次退避加 **0–20% 的随机抖动**（`delay × random(0, 0.2)`），避免多台机器同时重连。
  - 任何一次连接建立成功并收到 `hello.ok` → **退避序列重置**回第一次。
  - 收到 `401`（token 无效）时**不得**继续重连：这是配置错误，必须停下来在界面上报"bridge token 无效"，每 300 秒**最多**重试一次，避免把服务器打成登录风暴。
- **重连后电脑必须重新发 `hello`**（含最新 `version` 与 `capabilities`）。
- **重连后 relay 不补发任何旧的 `request`**（10.2）。
- **电脑侧不得**因为重连而重放它曾经发过的 `session.send`。

### 10.5 心跳与判死（写死）

| 项 | 值 |
| --- | --- |
| relay 发 `ping` 的间隔 | **每 20000 ms** |
| 电脑端发 `ping` 的间隔 | 也允许（建议同样 20000 ms），收到必须回 `pong` |
| 判死条件（relay） | 距离**最后一次收到该连接的任何帧**超过 **60000 ms**，或一次 `ping` 后 **10000 ms** 内没有收到任何帧 |
| 判死动作 | relay 关闭连接，关闭码 `1001`，清掉该连接的待决项（10.2），记一条审计 |
| 最长静默 | 电脑端在**没有任何业务帧**时也必须每 20000 ms 发一次 `ping`（或回 `pong`），保证不会被判死 |

- 心跳的**唯一用途**是判断"电脑还在不在"，**不**用于保活 Caddy（Caddy 对 WebSocket 的默认超时足够长；不额外配置）。

---

## 11. 最小端到端时序（配对 → list → 模型 → 新建 → read → send → stop）

下面的每条消息都是**原文**。占位符：`<bridgeToken>`、`<rc_session>`、`<code>`。时间取自 `2026-10-08T03:58:07Z`。

### 步骤 1 — 手机开机自检（可选，但这是"服务器活着吗"的第一个信号）

```
GET https://101.43.98.18/health
```

```json
{"ok":true,"bridgeOnline":false}
```

### 步骤 2 — 电脑主动连上 relay

```
GET wss://101.43.98.18/bridge
Upgrade: websocket
Authorization: Bearer <bridgeToken>
（不带 Origin 头）
```

relay 升级成功（HTTP 101）。

### 步骤 3 — 电脑声明上线与能力

电脑发出：

```json
{"type":"hello","version":1,"clientName":"DESKTOP-7F3A","capabilities":{"sessions.list":true,"session.read":true,"session.send":true,"session.stop":true,"stop:codex":false,"stop:dsh":true,"tools":["codex","dsh"]}}
```

relay 回：

```json
{"type":"hello.ok","version":1,"serverTime":"2026-10-08T03:58:07Z","heartbeatIntervalMs":20000,"idleTimeoutMs":60000,"requestTimeoutMs":30000,"maxPending":16}
```

此后 `GET /health` 变成 `{"ok":true,"bridgeOnline":true}`。

### 步骤 4 — 电脑要一个配对码

电脑发出：

```json
{"type":"pair.create","id":"3f2504e0-4f89-41d3-9a0c-0305e82c3301"}
```

relay 回：

```json
{"type":"pair.created","id":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","code":"K7QP-3MZD-9XTB-2RCV-6HNF-0JWS","expiresAt":"2026-10-08T04:03:07Z","url":"https://101.43.98.18/#pair=K7QP-3MZD-9XTB-2RCV-6HNF-0JWS"}
```

电脑把 `code` 显示给正在电脑前的用户。**码 5 分钟后（`04:03:07Z`）失效。**

### 步骤 5 — 手机用码换 cookie

```
POST https://101.43.98.18/api/pair
Origin: https://101.43.98.18
Content-Type: application/json
Content-Length: 61

{"code":"K7QP-3MZD-9XTB-2RCV-6HNF-0JWS","deviceName":"Pixel 8"}
```

relay 回 **200**：

```
Set-Cookie: rc_session=<rc_session>; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict
Cache-Control: no-store
```

```json
{"ok":true}
```

同一时刻 relay 给电脑推一条：

```json
{"type":"pair.used","codeId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","deviceName":"Pixel 8","at":"2026-10-08T03:59:41Z"}
```

**同一个 `code` 再用一次 → 401：**

```
{"ok":false,"error":{"code":"invalid_credentials","message":"pairing code already used"}}
```

### 步骤 6 — 手机列会话

```
POST https://101.43.98.18/api/rpc
Origin: https://101.43.98.18
Content-Type: application/json
Cookie: rc_session=<rc_session>
Content-Length: 26

{"method":"sessions.list"}
```

relay → 电脑：

```json
{"type":"request","id":"1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d","method":"sessions.list","params":{},"timeoutMs":15000}
```

电脑 → relay：

```json
{"type":"response","id":"1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d","ok":true,"result":{"sessions":[{"id":"0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70","tool":"codex","title":"重构 relay 的转发层","status":"working","updatedAt":"2026-10-08T03:57:55Z","cwd":"D:\\workspace\\codex-workspace\\remote-control"}],"capabilities":{"sessions.list":true,"session.read":true,"session.send":true,"session.stop":true,"stop:codex":false,"stop:dsh":true,"tools":["codex","dsh"]}}}
```

relay → 手机 **200**：

```json
{"ok":true,"result":{"sessions":[{"id":"0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70","tool":"codex","title":"重构 relay 的转发层","status":"working","updatedAt":"2026-10-08T03:57:55Z","cwd":"D:\\workspace\\codex-workspace\\remote-control"}],"capabilities":{"sessions.list":true,"session.read":true,"session.send":true,"session.stop":true,"stop:codex":false,"stop:dsh":true,"tools":["codex","dsh"]}}}
```

> 注意这一条会话是 `codex`，而 `stop:codex` 是 `false` → 手机**必须**把这条会话的停止按钮置灰。

### 步骤 7 — 手机列模型（v4 新增；只在用户点"新建会话"时）

手机要知道**电脑上那个应用里真实可选**的模型，于是给**每个工具**各调一次：

```
{"method":"models.list","params":{"tool":"codex"}}
```

relay → 电脑：

```json
{"type":"request","id":"5e6f7a8b-9c0d-4e1f-2a3b-4c5d6e7f8091","method":"models.list","params":{"tool":"codex"},"timeoutMs":15000}
```

电脑 → relay（**id 与 label 来自电脑侧真实能力，不是手机编的**）：

```json
{"type":"response","id":"5e6f7a8b-9c0d-4e1f-2a3b-4c5d6e7f8091","ok":true,"result":{"tool":"codex","models":[{"id":"gpt-5-codex","label":"GPT-5 Codex","isDefault":true},{"id":"gpt-5","label":"GPT-5"}],"projects":[{"id":"proj_01H9-XYZ","name":"remote-control","cwd":"D:\\workspace\\codex-workspace\\remote-control"}]}}
```

relay → 手机 **200**：`result` 原样转发。

**该工具没开时不是错误**（**200**，注意不是 4xx/5xx）：

```json
{"ok":true,"result":{"tool":"dsh","models":[],"reason":"dsh app is not running"}}
```

→ 手机显示"该工具当前没有可用模型（`reason`）"并**把该工具下的新建置灰**。**不得**由手机自己填一份模型清单。

### 步骤 8 — 手机在电脑上那个桌面应用里新建一条真实会话（v4 新增）

用户选了 `codex` / `gpt-5-codex`，手机发（`requestId` 是**新的** v4 UUID；**同一会话的重试要复用同一个 `requestId`**）：

```
{"method":"session.create","params":{"tool":"codex","model":"gpt-5-codex","projectId":"proj_01H9-XYZ","text":"帮我看看这个仓库","requestId":"8f14e45f-ceea-467a-9e6b-1c0d2e3f4a5b"}}
```

relay → 电脑（**timeoutMs 是 30000，与 send/stop 同一档**）：

```json
{"type":"request","id":"6f7a8b9c-0d1e-4f2a-3b4c-5d6e7f8091a2","method":"session.create","params":{"tool":"codex","model":"gpt-5-codex","projectId":"proj_01H9-XYZ","text":"帮我看看这个仓库","requestId":"8f14e45f-ceea-467a-9e6b-1c0d2e3f4a5b"},"timeoutMs":30000}
```

电脑 → relay（**这条会话真的落在电脑上那个桌面应用里**，不是命令行另起的一个进程）：

```json
{"type":"response","id":"6f7a8b9c-0d1e-4f2a-3b4c-5d6e7f8091a2","ok":true,"result":{"sessionId":"3d2c1b0a-9f8e-4d7c-8b6a-5e4f3d2c1b0a","tool":"codex","title":"帮我看看这个仓库","model":"gpt-5-codex"}}
```

relay → 手机 **200**：

```json
{"ok":true,"result":{"sessionId":"3d2c1b0a-9f8e-4d7c-8b6a-5e4f3d2c1b0a","tool":"codex","title":"帮我看看这个仓库","model":"gpt-5-codex"}}
```

→ 闭环：手机随即用**这个 `sessionId`** 调 `session.read` / `sessions.list`，它必须能读到；之后 `session.send` / `session.stop` 也直接用它（**同一个 id 空间，不迁移、不映射**）。

**模型不在目录里时**（HTTP **200**，业务错误）：

```json
{"ok":false,"error":{"code":"model_not_available","message":"the selected model is not available"}}
```

→ 手机回到模型选择，**重新调一次 `models.list`** 再让用户选；**不得**自动换个模型重试。

**建出来了、但后续步骤失败时**（HTTP **200**，**成功**信封：`sessionId` 必须给出来，具体"未完成到哪一步"的字段名由电脑侧定）：

```json
{"ok":true,"result":{"sessionId":"3d2c1b0a-9f8e-4d7c-8b6a-5e4f3d2c1b0a","tool":"codex","model":"gpt-5-codex","incomplete":"prompt"}}
```

→ 手机**保留**这个 `sessionId`：把它显示出来、让用户打开、在同一会话里**重试发送**。**禁止**当作整次失败，**禁止**引导用户再点一次新建（那会多出第二条会话）。

### 步骤 9 — 手机读历史

```
{"method":"session.read","params":{"tool":"codex","sessionId":"0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70"}}
```

relay → 电脑：

```json
{"type":"request","id":"2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e","method":"session.read","params":{"tool":"codex","sessionId":"0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70"},"timeoutMs":15000}
```

电脑 → relay：

```json
{"type":"response","id":"2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e","ok":true,"result":{"id":"0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70","tool":"codex","title":"重构 relay 的转发层","status":"working","messages":[{"id":"m-0001","role":"user","text":"帮我看看转发层","timestamp":"2026-10-08T03:55:02Z"},{"id":"m-0002","role":"assistant","text":"我先读一下现有的转发代码。","timestamp":"2026-10-08T03:55:09Z"}],"canStop":false,"activeTurnId":"turn-7"}}
```

relay → 手机 **200**：把上面的 `result` 原样放进 `{"ok":true,"result":…}`。**注意 `canStop:false`——手机把停止按钮置灰。**

### 步骤 10 — 手机发一条消息（送到电脑上那条已有会话）

```
{"method":"session.send","params":{"tool":"codex","sessionId":"0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70","text":"继续，把转发层写完"}}
```

relay → 电脑：

```json
{"type":"request","id":"3c4d5e6f-7a8b-4c9d-0e1f-2a3b4c5d6e7f","method":"session.send","params":{"tool":"codex","sessionId":"0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70","text":"继续，把转发层写完"},"timeoutMs":30000}
```

电脑 → relay：

```json
{"type":"response","id":"3c4d5e6f-7a8b-4c9d-0e1f-2a3b4c5d6e7f","ok":true,"result":{"accepted":true,"sessionId":"0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70"}}
```

relay → 手机 **200**：

```json
{"ok":true,"result":{"accepted":true,"sessionId":"0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70"}}
```

### 步骤 11 — 手机轮询看到新输出

约 2 秒后再发一次 `session.read`（**同一个 sessionId，间隔 ≥ 2000 ms**）：

```json
{"method":"session.read","params":{"tool":"codex","sessionId":"0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70"}}
```

relay → 手机 **200**（新消息以**新的 `id`** 追加在尾部，旧消息的 `id` 不变）：

```json
{"ok":true,"result":{"id":"0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70","tool":"codex","title":"重构 relay 的转发层","status":"working","messages":[{"id":"m-0001","role":"user","text":"帮我看看转发层","timestamp":"2026-10-08T03:55:02Z"},{"id":"m-0002","role":"assistant","text":"我先读一下现有的转发代码。","timestamp":"2026-10-08T03:55:09Z"},{"id":"m-0003","role":"user","text":"继续，把转发层写完","timestamp":"2026-10-08T04:00:12Z"},{"id":"m-0004","role":"assistant","text":"好，我先补上 pending 的回收。","timestamp":"2026-10-08T04:00:19Z"}],"canStop":true,"activeTurnId":"turn-8"}}
```

### 步骤 12 — 停止（只有在能力允许时）

这条是 `dsh` 会话，`stop:dsh:true` → `canStop` 可以为 `true`：

```
{"method":"session.stop","params":{"tool":"dsh","sessionId":"7a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5e"}}
```

relay → 电脑：

```json
{"type":"request","id":"4d5e6f7a-8b9c-4d0e-1f2a-3b4c5d6e7f80","method":"session.stop","params":{"tool":"dsh","sessionId":"7a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5e"},"timeoutMs":30000}
```

电脑 → relay：

```json
{"type":"response","id":"4d5e6f7a-8b9c-4d0e-1f2a-3b4c5d6e7f80","ok":true,"result":{"accepted":true,"sessionId":"7a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5e"}}
```

relay → 手机 **200**：

```json
{"ok":true,"result":{"accepted":true,"sessionId":"7a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5e"}}
```

### 步骤 13 — 注销

```
POST https://101.43.98.18/api/logout
Origin: https://101.43.98.18
Cookie: rc_session=<rc_session>
Content-Length: 2

{}
```

relay 回 **200**：

```
Set-Cookie: rc_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict
```

```json
{"ok":true}
```

再带旧 cookie 调 `/api/rpc` → **401**：

```json
{"ok":false,"error":{"code":"unauthenticated","message":"session is not valid"}}
```

### 步骤 14 — 电脑掉线时手机调 `/api/rpc`

relay 回 **503**：

```
Retry-After: 1
```

```json
{"ok":false,"error":{"code":"bridge_offline","message":"desktop is offline"}}
```

### 步骤 15 — 电脑回得太慢

relay 在 `timeoutMs` 后回 **504**：

```json
{"ok":false,"error":{"code":"bridge_timeout","message":"desktop did not answer in time"}}
```

### 步骤 16 — 被拒的非法请求（安全断言）

**不带 `Origin`** 的 `POST /api/rpc` → **403**：

```json
{"ok":false,"error":{"code":"origin_forbidden","message":"origin not allowed"}}
```

**`Origin: https://101.43.98.18.evil.example`** → **403**，响应同上（**逐字节比较，不做后缀匹配**）。

**`POST /downloads/../relay-config.yml`** → **404**：

```json
{"ok":false,"error":{"code":"not_found","message":"not found"}}
```

**`GET /downloads/bridge-token.txt`** → **404**，响应同上。

**`POST /api/rpc` 带一个不在六个白名单里的 method**（**注意：`session.create` 自 v4 起是合法方法，不能再拿它当反例**）→ **200**：

```
{"method":"shell.exec","params":{"cmd":"whoami"}}
```

```json
{"ok":false,"error":{"code":"unknown_method","message":"method is not allowed"}}
```

**`session.create` 带白名单外字段**（**包括 `callerSource` 这类改写上游身份的字段，一律拒绝**）→ **200**：

```
{"method":"session.create","params":{"tool":"codex","model":"gpt-5-codex","requestId":"8f14e45f-ceea-467a-9e6b-1c0d2e3f4a5b","callerSource":"desktop"}}
```

```json
{"ok":false,"error":{"code":"invalid_params","message":"params contain an unknown field"}}
```

**`session.create` 对 DSH 不带 `provider`**（DSH 上同一个 model id 可能对应多个 provider，缺了就丢路由）→ **200**：

```json
{"ok":false,"error":{"code":"invalid_params","message":"provider is required for dsh"}}
```

**`POST /api/rpc` 带 `{"method":"session.send","params":{"tool":"codex","sessionId":"0f1c7a2e-9b64-4c5f-8f1a-2d3e4b5c6a70","text":"x","timeoutMs":1}}`** → **200**（白名单外字段）：

```json
{"ok":false,"error":{"code":"invalid_params","message":"params contain an unknown field"}}
```

**配对连错 6 次** → 第 6 次起 **429**：

```
Retry-After: 60
```

```json
{"ok":false,"error":{"code":"rate_limited","message":"too many requests"}}
```

---

## 12. 兼容性与演进规则（写死）

1. **`version:1` 的含义**: 它同时钉住四件事 —— (a) **v1 当时那四个** method 的名字（`sessions.list` / `session.read` / `session.send` / `session.stop`）；(b) 每个 method 的 `params` 与 `result` 形状；(c) `hello` / `pair.*` / `request` / `response` 帧的字段集；(d) 第 6.2 节的错误码集合。**改动这四件事里的任何一件都要求一个新的 `version` 值**（2、3…）。
   - **v4 澄清（重要，别读错成"加方法也要升版本"）**: 这一条说的是**已有的那些** method / 字段 / 码**不能再改**。**新增** method、新增字段、新增 `capabilities` 键、新增错误码**属于第 3 条的加法，不要求新 `version`** —— 这正是 v4 把 method 从 4 个加到 6 个而 `version` 仍是 `1` 的依据。**已有四个 method 的语义在 v4 里一字未改**（CRD 0006 §兼容性）。
2. **`hello.version` 不匹配的处理**: relay 只接受 `1`；收到别的值 → 关闭连接（`1008`）。这样"新版电脑 + 旧版服务器"会被明确拒绝，而不是以半个协议运行。
3. **只增不改（最重要的一条）**:
   - **可以**加：新的 `method`、新的 `result` 字段、新的 `capabilities` 键、新的 `error.code`、新的帧 `type`。这些是**向后兼容的加法**。
   - **不可以**改：已有字段的名字、已有字段的类型、已有字段的语义、已有 `method` 名、已有 `error.code` 的含义、`status` / `role` / `tool` 已有取值的含义。
   - 删字段、把可选字段变必填、把错误码换一个意思 —— 都是**破坏性**改动，必须走新 `version`。
4. **未知字段怎么处理（写死）**:
   - 收到**对象里多出来的键** → **忽略，不得报错**。这一条对手机、relay、电脑三方都适用。
   - 收到**未知 `type` 的帧** → 忽略该帧、连接继续（见 8.5 表）。
   - 收到**未知的 `status` / `role` / `tool` 值** → 原样透传，客户端按 4.3 / 4.4 的降级样式显示。
   - 收到**未知的 `error.code`** → 客户端按 `bridge_error` 的方式显示（显示 `message`，不自动重试）。
   - **这一条对第 9 节具有约束力（写死）**: 第 9 节里"多出的字段不转发"那句**以本条为准**。relay 对 `result` 的校验**只做两件事**：(a) 该方法**必填**的字段都在；(b) 这些字段的类型与取值合法。**多余的字段一律透传，不得因此报 `bridge_bad_response`。** 客户端收到不认识的字段就忽略。这是"只增不改"能真正落地的前提 —— 否则新版电脑加一个字段，旧 relay 就开始拒绝它。
5. **能力协商是唯一的"新功能开关"**: 想让手机用上新能力，先加 `capabilities` 键（默认 `false`），再让电脑端实现。**不要**用"服务器版本号"或"日期"来猜对端能力。
6. **谁批准变更**: 本文件由架构角色维护。工程师发现需要改动 → 写 `inbox/Q-<n>.md` 给 PM；PM 决定后由架构角色改本文件、升版本号、并通知两侧重新阅读（"契约冻结，单侧不得私自改"）。
7. **旧版并存的期限**: `version:1` 在 `version:2` 出现后**至少共存一个里程碑**（让电脑端和手机端各自升级窗口），期间 relay 可以同时接受两个 `hello.version`。本作业只有 1，暂时不需要并存实现。

---

## 13. 契约测试（原有两侧各两条；v4 / v5 再各加一条）

这些是**契约测试**，不是功能测试。它们的唯一目的：在两侧见不到面的情况下，发现"两人对同一句话的理解不同"。**只写要测什么、断言什么，不写代码。**

> **v4 / v5 追加**: 原来的"服务端测试 1 / 2"与"电脑端测试 1 / 2"**一字未改**，仍必须存在。新增的是一个 method 加成的测试点：**服务端测试 3**（relay 对两个新 method 的校验）与**电脑端测试 3**（两个新 method 的真实执行）。**手机端（mobile）的契约测试点同时补上**，见本节末尾。

### 服务端（relay）一侧

**服务端测试 1 — 输入侧加固（对应 5.3 / 5.4 / 6.2）**

- 测什么: 对 `POST /api/rpc` 发四类非法请求：(a) 无 `Origin`；(b) `Origin: https://101.43.98.18.evil.example`；(c) `Origin: http://101.43.98.18`；(d) `Content-Type: text/plain`。
- 断言: 每个都返回 **403 `origin_forbidden`**（d 为 **415 `unsupported_media_type`**），**响应体是 6.1 的形状且 `error.code` 精确匹配**，并且响应头里**没有** `Access-Control-Allow-Origin`。
- 这一条同时证明"不开 CORS"。

**服务端测试 2 — 转发、超时与离线（对应第 8 节 / 9.2 / 10.2）**

- 测什么: 起一个真的 test bridge（用 `github.com/coder/websocket` 建客户连接，`Authorization: Bearer <测试 token>`，**不带 Origin**），走完 `hello` → 收到一次 `session.read` 的 `request` → **回一个符合 9.2 形状的 `result`**；然后做三种负面情形：(a) 用**同一个 code 两次**调 `POST /api/pair`；(b) 让 test bridge **不回** `response`，断言 relay 在 `timeoutMs` 后回 **504 `bridge_timeout`**；(c) 关掉 test bridge 后再调一次 `/api/rpc`，断言 **503 `bridge_offline`**。
- 断言: (a) 第一次 200 + `Set-Cookie` 三个属性齐全（`HttpOnly` / `Secure` / `SameSite=Strict`）、第二次 **401 `invalid_credentials`**；(b) 手机端收到 `200/504` 且 `error.code === "bridge_timeout"`；(c) `error.code === "bridge_offline"`；并且 (b) 之后 relay **没有**再往电脑侧发第二次 `request`（**不重试发送**，用 test bridge 收到的帧数断言）。
- 这一条**必须**声明 mock 了什么：mock 的是"电脑侧会话执行"，**不是** relay 的转发逻辑（转发逻辑是真的）。

**加上 `hello` 首帧与 token 断言**（属于同一条或独立一条，由实现者按花费决定）: 无 `Authorization` 连 `/bridge` → 握手 **401**；带 `Origin: https://101.43.98.18` 连 `/bridge` → 握手 **403**。

**服务端测试 3 — 两个新 method 的参数、结果校验与透传（v4 新增；对应 6.2 / 7.3 / 9.5 / 9.6 / 12.4）**

- 测什么: 对 `POST /api/rpc` 打两组请求。
  - **参数侧**: (a) `models.list` 带白名单外字段（`{"tool":"codex","model":"x"}`）；(b) `models.list` 缺 `tool`；(c) `models.list` 的 `tool` 是 `"claude"`；(d) `session.create` 缺 `requestId`；(e) `session.create` 的 `requestId` 是**大写** UUID；(f) `session.create` 的 `tool` 是 `"dsh"` 但**没有 `provider`**；(g) `session.create` 带 `callerSource` / `sudo` 这类字段；(h) `session.create` 的 `text` 超 16384。
  - **结果侧**: 让 test bridge 依次回四种 `result`：(i) 合法 `models.list`（空 `models` + `reason`）；(ii) 合法 `session.create`；(iii) `session.create` 回成 `{"accepted":true,"sessionId":"s1"}`（**旧的 send 形状**）；(iv) `models.list` 多带一个未知字段。
- 断言:
  - (a)–(c) 全部 **200 `invalid_params`**；(d)(e)(g) **200 `invalid_params`**；(f) **200 `invalid_params`**（**缺 `provider` 是请求不成立，不是 `model_not_available`**）；(h) **200 `too_long`**。
  - (i)(ii) 手机收到 **200 `ok:true`** 且 `result` **逐字节**是电脑侧给的那份（含 `reason`）；(iii) relay 回 **502 `bridge_bad_response`**（**`accepted` 不是 9.6 的必填字段，缺 `sessionId` 就是形状不合**）；(iv) 手机收到的 `result` **仍带着那个未知字段**（**不得被 relay 吃掉**，§12.4）。
  - **relay 不去重**: 同一个 `requestId` 连发两次 `session.create`，断言 relay **两次都转发了**（去重是电脑侧的义务，不是 relay 的）。relay **不得**自己缓存或改写 `requestId`。
  - **两个新 method 同样受约束**: 断言它们走的是同一条待决表（单连接 16 / 全局 64）、同一条限速、同一个 `timeoutMs` 计算（`models.list` 15000、`session.create` 30000）。

### 电脑端（desktop bridge）一侧

**电脑端测试 1 — 出站连与握手（对应 8.1 / 8.2 / 8.4.1）**

- 测什么: 用一个本地 WS 服务器扮演 relay。(a) 断言 bridge 的连接请求里**没有 `Origin` 头**、`Authorization` 是 `Bearer <token>`；(b) 服务器不回 `hello.ok` 时，断言 bridge 会在规定时间内**重发 `hello` 或被判超时**；(c) 服务器回一个 `{"type":"hello.ok","version":1,…}`，断言 bridge 发出的第一条帧是合法 `hello` 且 `version === 1`、`capabilities.tools` 是最少 1 个且不重复。
- 断言: 上述三条逐条成立；另外断言 bridge **不发送**任何第 8.3 表之外的 `type`。

**电脑端测试 2 — `request` 的处理与 `response` 的对应（对应 8.4.7 / 8.4.8 / 9.2 / 9.5）**

- 测什么: 让扮演 relay 的服务器依次发三条 `request`：(a) `session.read`（mock 一个会话，返回 2 条消息）；(b) `session.send`（断言文本被交给**同一个** `sessionId` 的输入口，且**没有**新建会话、没有重放）；(c) `session.stop`，且**故意把该会话的 `capabilities["stop:codex"]` 设为 `false`**。
- 断言:
  - (a) 回的 `response.id` **逐字节等于** request 的 `id`；`result` 满足 9.2 的**每个必填字段**（含 `canStop`、`status` 取值合法、`messages[].id` 稳定）；`status==="working"` 时给出 `activeTurnId`，否则**省略**该字段。
  - (b) 回的 `result` 精确等于 `{"accepted":true,"sessionId":"<请求里的 id>"}`；断言"没有新建会话"（mock 的会话表长度不变）。
  - (c) 回的 `ok === false`，且 `error.code === "not_capable"`（**不假装成功**），`error.message` 不含任何路径或堆栈。
  - 三条都必须：**同一 id 只回一次**；断言 mock 里**没有**"同一 request 执行两次"的记录。

**电脑端测试 3 — 模型目录、真实创建与"部分成功"（v4 新增；对应 8.4.7 / 8.4.8 / 9.5 / 9.6）**

- 测什么: 让扮演 relay 的服务器依次发三条 `request`：(a) `models.list`（`tool:"codex"`，且**让 mock 的工具运行时返回一个随机生成的 model id**——随机是为了让"这一定不是代码里的常量"变成可断言的事实）；(b) `session.create`（`model` 用 (a) 返回的那个 id，并带一个全新 `requestId`）；(c) **同一个 `requestId` 再发一次** `session.create`。
- 断言:
  - (a) `result.tool` 等于请求的 `tool`；`result.models[]` **逐字节**包含那个随机 id；`models[]` 的每一项都有 `id` 与 `label`；**目录为空时**回 `models: []`（**不是错误**）；**该工具没装上 / 适配器没连上时**回 `ok:true` + `models: []` + `reason`（**不是 `ok:false`**——**这是本次最容易做错的一条**）。
  - (b) `result.sessionId` 满足 §4.1 的 `sessionId` 正则；**没有 `accepted` 字段**；`result.model` **逐字节**等于请求里的 `model`；请求里有 `provider` / `reasoningEffort` 时它们**逐字节**回显。然后**立刻**断言闭环：这个新会话出现在 `sessions.list` 里、并且 `session.read` 能读到它（**同一个 id 空间**）。
  - (c) **mock 的会话表里新增的会话数仍是 1**（**不得因为重复 `requestId` 就建出第二条**）；回的是**第一次**的结果（`sessionId` 相同）。
  - **额外的错误路径断言**（同一条或独立一条，由实现者按花费决定）:
    - `model` 不在目录里 → `ok:false` + `model_not_available`；
    - 工具不可用 → `ok:false` + `tool_unavailable`；
    - **创建出来了、但 `selectModel` / `prompt` 失败** → `ok:true` 且 `result.sessionId` **必须给出**（**不得**藏起来当整次失败），并带上电脑侧那个"未完成到哪一步"的字段（字段名由电脑侧定，见 9.5）；
    - `requestId` **无法持久记录** → `ok:false` + `session_create_failed` + `message === "create result unknown"`，且**不得**再建一条。
- 这一条**必须**声明 mock 了什么：mock 的是**工具侧的运行时调用**（模型目录读取、`create_thread` / `session/create` / `selectModel` / `prompt`）；**不是** bridge 的帧收发、不是 `response` 的对应纪律、不是去重逻辑（那三样是真的）。mock 里的 **model id 必须是运行时生成的随机值**——否则这条测试证明不了"目录不是硬编码的"。

**电脑端测试 4 — 长历史必须被有预算地截断，且不静默失败（v5 新增；对应 8.2 / 9.2）**

- 测什么: 让 mock 的会话返回一条**超过 256 KiB** 的历史（例如 200 条长消息，总量 > 262144 字节），然后发一次 `session.read`。
- 断言:
  - **发出的那一帧 ≤ 262144 字节**（用 mock relay 实际收到的字节数断言，**不是**估算）；
  - **完整 envelope ≤ 240 KiB** —— 断言按整条 `response` 的 UTF-8 字节数算，不只是 `messages` 部分；
  - 截断发生了 → `result.historyTruncated === true`，且**尾部（最新）的消息仍在**、**头部（更旧）的被丢掉**；
  - 单条超长消息按 9.2 的 65536 上限截断；
  - **若帧仍然发不出去** → 回一条**短**的 `ok:false`（`bridge_error`），**断言不是"什么都不回"**——**沉默就是 CRD 0007 记录的那次超时**；
  - 没截断的普通 `session.read` → **省略** `historyTruncated`（或 `false`），且 `capabilities` 里**没有**为它新增任何位。

### 手机端（mobile）一侧（v4 追加）

手机侧原来没有列契约测试点（它上面两条是服务端与电脑端的）。v4 把手机也放进来，因为**这两个新 method 的分支判断主要发生在手机上**，而"两人对同一句话理解不同"在这里最容易发生。

**手机端测试 1 — 请求体只带白名单字段，`requestId` 每次都是新的 v4 UUID（对应 4.1 / 7.3 / 9.6）**

- 对应的真实测试文件与用例名（`mobile/tests/core.test.js`）: `models.list and session.create carry exactly the whitelisted fields` 与 `requestId is a fresh UUID v4 every time (protocol-v1 4.1)`。
- 断言: `modelsListBody` 只产出 `{tool}`；`sessionCreateBody` 只产出白名单字段，**空白的可选字段被丢掉**而不是发成空串；**DSH 一定带 `provider`、Codex 一定不带**；两次 `newRequestId()` 不相等，且形状匹配 4.1 的 v4 正则。

**手机端测试 2 — 新建面板的可用性只来自 `capabilities` 与目录，不来自任何本地常量（对应 9.5 / 9.6）**

- 对应的真实测试文件与用例名（`mobile/tests/core.test.js`）: `availability is explicit: never an empty dropdown pretending to be a choice`、`model options come from the live catalog and keep provider attached`、`new-session error codes have Chinese text`。
- 断言: `capabilities` 说没有 → `unsupported`（**即使目录里有模型也不许显示**）；`capabilities` 说有、但目录是空的 → `unavailable` **并显示电脑给的那个 `reason`**；**缺键按 `false`**；**带工具后缀的键优先于扁平键**（`models.list:codex:false` 压过 `models.list:true`）；目录里"没有 `id` 的项 / `null` / 字符串"一律**丢掉**，**绝不**编出一个模型名，**绝不**把列表第一项当默认（`isDefault` 没给就是没有默认）。

**手机端测试 3 — 失败之后不许自动重发 / 不许重复建会话（对应第 11 节 / 9.6）**

- 测什么（写成测试文件里的一条）: 给手机喂三类响应：(a) `ok:false` + `session_create_failed`（**没有 `sessionId`**）；(b) `ok:true` + `result.sessionId`（**部分成功**）；(c) `ok:false` + `bridge_timeout`。
- 断言: (a)(c) 之后手机**不得**自动重发 `session.create`（用户重新点击才发），并提示"结果未知，请先刷新列表"；(b) 时手机**必须**保留那个 `sessionId`——把它当作**已存在**的会话显示、允许打开、允许在同一会话里重试发送，**不得**引导用户再点一次新建；**同一会话的重试复用同一个 `requestId`，用户重新点"新建"时生成新的 `requestId`**。
- 这一条能独立发现一种真实错法：把"部分成功"读成"整次失败"。

---

## 14. 实现顺序建议（给 PM 排任务用，不是契约的一部分）

1. **先做"一条真实链路"**：`GET /health` → bridge 握手 + `hello` + `hello.ok` → `pair.create` / `pair.created` → `POST /api/pair` → `POST /api/rpc` 的 `sessions.list` 打通（只这一条 method）。这条链路跨了**三条**边界（HTTP 入口、cookie、WebSocket 转发），是**风险最高**的那一段，也是最早能发现"契约不成立"的地方。
2. 再加 `session.read`（含 `canStop` 与 `capabilities` 的用法）。
3. 再加 `session.send` + 轮询（含"不重发"）。
4. 再加 `session.stop` + `not_capable` 门。
5. 然后补 `POST /api/logout`、`GET /downloads/*`、限速、超时、`bridge_busy` 等加固项。
6. **（v4 / v5 追加）** 再做两个新 method：`models.list`（**先做"工具没装也返回 `ok:true` + 空数组 + `reason`"这条负面用例**，它最容易做错）→ `session.create`（**先做"重复 `requestId` 只建一条"与"建出来了但后续失败仍回 `sessionId`"两条**，它们才是这条需求的灵魂）→ 最后补 `session.read` 的 `historyTruncated` 截断预算（CRD 0007）。**顺序理由**: 新 method 依赖 `sessions.list` / `session.read` 已经在跑（闭环要拿它们验证），所以它们排在旧四个之后；而"落在桌面应用里"这条实现约束**只能由电脑侧保证**，手机与 relay 都不可能替它检查，所以它必须配一条真的契约测试。

---

## 15. 待决与风险

> 以下各条**我没有改契约**，只是记下来给 PM 裁决。在 PM 裁决前，两侧按**上面已经写死的文字**实现（每一条我都给了"现在的写法"）。

| # | 条目 | 为什么它是问题 | 我的建议 | 严重度 |
| --- | --- | --- | --- | --- |
| **R1** | **`/api/*` 要求 `Origin` 头存在** | 原始要求是"校验 exact Origin"。写成"缺 Origin 即 403"后，一个**不自动发送 Origin** 的客户端会被全盘拒绝。Android WebView 里用 `loadUrl("https://101.43.98.18/")` 加载同源页面后 `fetch` 会带 `Origin`；但若前端改用 `loadDataWithBaseURL`/`file://` 装载，或改用 **OkHttp/HttpURLConnection 原生请求**（原生客户端默认不带 `Origin`），请求会全部 403。 | 我选了"硬 403"（安全上最省事：一条规则、没有例外）。若真机实测发现 WebView 不带 `Origin`，需要 PM 决定改成"允许缺失 `Origin`、但存在时必须精确匹配"——那是一个**放宽**，必须走 CRD。**同时请在真机上先验证 WebView 发不发 `Origin`**。 | 高（会挡住手机端全链路） |
| **R2** | **`/downloads/*` 与 `relay/web/` 静态托管的关系** | `T-relay.md` 的 R12 只写"只允许 APK 文件白名单"，但同一任务的 Owned files 里有 `relay/web/**`（来自 T-mobile 的 `mobile/web/`）要交给服务端静态托管；PRD 又要求"手机端不缓存完整会话历史到服务器"。三句话放在一起，"网页前端从哪个路径提供"没有被任何文档钉住。 | 我按"两条路由互不回落"写（7.5 末尾）：`/downloads/*` 只服务 APK，`relay/web/` 另走一条路径（例如 `/` 与 `/assets/*`）。**请 PM 在 T-relay 的任务行里钉死那条路径**，否则工程师会自己选一个。 | 中 |
| **R3** | **手机端页面从哪来的两种交付形态** | PRD/任务行同时出现"Java + WebView 的 APK"和 `mobile/web/` 交给服务端静态托管。若手机端**只**是远程加载网页，那 APK 就只是个浏览器壳，`/downloads/*` 的白名单意义下降、而"页面本身"成了另一个要保护的资产；若手机端是**打包进 APK 的本地页面**，那 `relay/web/` 的服务端托管就只是为了方便在电脑上调试。 | 请 PM 明确一个主形态，另一个作为可选。**本契约对两种形态都成立**（HTTP 面完全一样），但"Origin 从哪来"（R1）取决于这个答案。 | 中 |
| **R4** | **缺一个"已认证但无权"的错误码** —— **已裁决：accepted（CRD 0003）** | 6.2 表里没有 `forbidden` 类码。`POST /api/logout` 的"桥认证的设备撤销"路径需要表达"你带了 cookie，但没有合法的 `Authorization: Bearer <bridgeToken>`"。我在 6.2 的约束下改用了 **`401 unauthenticated`**（见 7.4 的说明行），并在那一行留下了更正痕迹。**这说明 6.2 的码表少了一个必要成员。** | 建议在 6.2 增补一个码 `forbidden`（HTTP 403，"已认证但无权执行"），并在 7.4 改用它。这是**加法**（新增码），不破坏已有实现——但仍属契约变更，由 PM 决定后由架构角色改本文件并升版本。 | 中 |
| **R5** | **撤销路径能撤销"任意一条" `rc_session`，但输入的是明文 session 值** —— **已裁决：rejected —— 本轮不做 `devices.list`** | 7.4 的撤销用法要求请求体里放 `targetSessionId` = 那条 `rc_session` 的**明文**。这带来两个现实问题：(a) 用户手上只有"当前设备"的 cookie，要撤销**另一台**设备得先拿到它的值，而协议里**没有"列出已配对设备"**的接口；(b) 谁的值被拿走就等于谁被撤销。 | 建议增补一个只读方法（例如 `devices.list`，走 `/bridge` 侧认证）来列出已配对设备与其 `deviceId`，撤销改成按 `deviceId`。**那是加法**（新 method + 新字段），可以在 `version:1` 上做，但必须由 PM 批准、由架构角色落文档。**现在的实现按明文值走，并严格 0600 存哈希。** | 中 |
| **R6** | **`bridge.create` 的 id 归属与 T-relay 的 DoD R6 文字不一致** | `T-relay.md` 的 R6 写"`id` 由请求方带上并原样回，**或**按契约生成（以 `protocol-v1.md` 为准）"，把两种都写成可能。本文件选的是**电脑生成、relay 原样回**（8.4.4 / 8.4.5）。 | 本文件已经钉死一种（电脑生成）。请 PM 在 T-relay 的任务行里把 R6 那句"或"去掉，改为指向本文件，避免工程师按"或"挑了另一种。**这是任务行文字的澄清，不是契约变更。** | 低 |
| **R7** | **`pair.used` 是本契约新增的一条帧** | 定死的协议清单里没有 `pair.used`（只有 `hello` / `pair.create` / `pair.created` / `request` / `response` / 心跳）。我加上它是为了满足 PRD 场景 C 的"用户能看见配对发生"（否则"配对确认"这件事在电脑端不可见）。它是**纯加法**（未知 `type` 的帧按 12.4 被忽略），旧实现不受影响。 | 保留。请 PM 确认这是可接受的加法；若不接受，删掉它不影响其它任何一帧。 | 低 |
| **R8** | **"心跳 + 指数退避重连"没有给出数值，我补了** | 原始要求只写"心跳 + 指数退避重连"。我写死了 `20000 ms` 心跳、`60000 ms` 判死、`1000→30000 ms` 退避序列（含 0–20% 抖动）、`401` 不重连。这些数值是**工程判断**，不是用户确认过的需求。 | 数值都写在 8.4.2 / 10.4 / 10.5。若 2 核 2G 的服务器上"每 20 秒一帧心跳"被认为太频，可整体调大（`hello.ok` 会告诉电脑端新值，所以**调大不需要改电脑端**）。 | 低 |
| **R9** | **`timeoutMs` 由手机指定，范围被夹在 1000–60000** | 允许客户端指定超时能应对慢网络，但也意味着一次 `session.read` 可以占住一个待决槽位最多 60 秒；配合"单连接 16、全局 64"的上限，最坏情况下全局槽位被占满 60 秒。 | 现在的数值（15 s / 30 s 默认、16 / 64 上限）在单用户自用场景下足够宽。**如果实测出现 `bridge_busy`，先调大待决上限，再考虑收紧 `timeoutMs` 的夹紧范围**（那是契约变更）。 | 低 |
| **R10** | **`sessions.list` 只回 200 条、`session.read` 只回 200 条** | 这是为了让单帧不超过 256 KiB、也不让 2 代 2G 的服务器在序列化上抖动。长会话会"看不到最早的历史"。 | 保留（"继续聊天"场景只需要尾部）。若用户想看完整历史，那是**新功能**（例如按 `beforeId` 分页），需要新字段（加法）或新 method，由 PM 决定。 | 低 |
| **R11** | **服务端**必须**持有 `bridgeToken` 与 `rc_session` 的哈希，但本契约没给存储形状** | 定死的决策只说"SQLite 只持久手机 token 的哈希与审计元数据，不存聊天全文"。表结构、字段名、索引**不属于接口契约**（它是 relay 内部实现），所以我没有写。 | 由 relay 自己的任务行约束（T-relay 的 R13）。本契约只钉住**边界行为**：撤销即删哈希、过期与撤销在协议上不可区分。 | 低 |
| **R12** | **Caddy 与 relay 之间的 `X-Forwarded-For` 信任** | 我把限速的"按谁算"钉成"对端是回环时读 `X-Forwarded-For`，否则忽略"。如果部署时 Caddy 不是从回环连 relay（例如 Caddy 跑在另一台机器上），这条规则会让所有客户端被算成一个。 | 现在的部署是**同机 Caddy + relay**，规则成立。**部署脚本必须保证 Caddy 到 relay 是回环连接**（`reverse_proxy 127.0.0.1:8080`）。若以后分机部署，需要改这条规则（契约变更）。 | 低 |

**我没有发现**任何一条已定死的决策在本文件里是**自相矛盾或无法实现**的；R4 与 R6 是"文字需要澄清"和"码表少一个成员"，不是矛盾。**唯一真正可能挡住全链路的是 R1。**

> **v4 追加两条 —— R13 / R14。它们**不是裁决后的剩余争议**，而是"契约已经写死、但真实字段必须靠实测确认"的待办。**在电脑侧实测确认之前，两侧按本文件写死的形状实现；模型清单**不得**由任何一侧凭猜测补齐。**

| # | 条目 | 为什么它是问题 | 我的建议 | 严重度 |
| --- | --- | --- | --- | --- |
| **R13** | **Codex 侧到底怎么列出"可选模型" —— 待电脑侧实测确认** | 本机 app-tools 目录里**可见**的是 `create_thread{title,prompt,target,model,thinking}` 与 `send_message_to_thread{threadId,hostId,prompt,model,thinking}`：`model` 是**普通 string**（没有 enum，取值为 `null`），`thinking` 有固定枚举。**目录里没有任何一个 list-models 工具**。所以"模型从哪读"**没有实测答案**：可能是桌面应用的配置、可能是运行时接口、也可能当前根本读不到（那就必须回 `models: []`，不许假填）。 | **需要电脑侧工程师实测**并给出答案，然后写进 `desktop` 的实现说明（**不要**在这里编字段）。契约侧已经钉死**结果形状**（9.5）与**"没有目录就返回空数组"**的兜底，所以实测结论无论哪种都能落地。 | **高**（直接决定"新建会话"能否成功） |
| **R14** | **DSH 侧 `session/create` 与模型目录的真实字段 —— 待电脑侧实测确认** | 本机只**证实过** `session/list` 与 `session/page` 的调用形态（`session/modelCatalog` 的调用方式曾在一次探测里被拒：`args fields do not match the descriptor: unexpected "request"`，见 `desktop/docs/evidence/models-check-20261008.log`）；**`session/modelCatalog` 的真实返回字段**（`groups[].models[].id/reasoning`、`default`、`failures` 的准确名字与层级）与 **`session/create` 的真实入参/返回**（以及"创建后必须 `selectModel` 再 `prompt`"这条流程的确切字段）**都没有被证实过**。 | **需要电脑侧工程师读本机 types / runtime 并实测**，再把结论写进 `desktop` 的实现说明。契约侧同样只钉**结果形状**（9.5 / 9.6）与"说不清就返回空数组、不许假填"。**特别注意**: `session/modelCatalog` 的 `args` 必须为空（任何字段都会被拒），这条已经踩过一次坑。 | **高**（决定 DSH 侧能否列出模型与建会话） |

> **v5 追加**: CRD 0007（`docs/decisions/crd/0007-history-truncated.md`）记录的是一次**用户实证的真实 bug**（200 条消息 = 287 733 字节 > 256 KiB 帧上限 → `sendFrame` 返回 `false` → 手机侧超时）。契约侧的加法已落在 **§9.2 的 `historyTruncated`** 与上面的"长历史的截断预算"一段：可选字段、预算 240 KiB、优先丢更旧、**发送失败必须回短错误、不得静默返回 `false`**。**`capabilities` 不新增位**，**`version` 仍为 `1`**（纯加法）。这一条**已裁决、已落地**，不是待办。

> **裁决记录（v2 追加）**: 上面 12 条已由 PM 在 **CRD 0003**（`docs/decisions/crd/0003-protocol-v1-additive-fixes.md`）里逐条裁决完毕。逐条结果：**R4 = accepted**（§6.2 新增 `forbidden`，§7.4 改用它）、**R5 = rejected**（本轮不做 `devices.list`）、**R2 / R3 / R6 = accepted，由 PM 在 `docs/tasks/T-*.md` 里澄清**（不动本文件）、**R1 / R7 / R8 / R9 / R10 / R11 / R12 = 保持本文件的现有写法**。
>
> 与上面 12 行有关的只有 R4 与 R5 两行被加了裁决标记，**其余 10 行的原文一字未动**（它们是 PM 评审时读到的记录）。**本表其余内容仍是 v1 的原貌**；只有 §6.2 与 §7.4 是行为上的改动，两处都写明了更正痕迹。

---

## 16. 变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v1 | 2026-10-08 | 首次创建。写死：传输与端口、HTTP 四端点与 `GET /downloads/*` 白名单、WebSocket `/bridge` 的八种帧、四种 method 的 `result` 形状、`capabilities` 与 `canStop`、统一错误体与 21 个错误码、id 与时间的形态、`status`/`role`/`tool` 取值、限速与 body 上限、配对码的字符集与长度与 5 分钟一次性语义、待决上限（16/64）与回收策略、心跳（20 s）与判死（60 s）与退避序列、最小端到端时序 14 步、兼容与演进规则、两侧各两条契约测试、12 条待决与风险。 |
| v2 | 2026-10-08 | CRD 0003 加法：§6.2 新增 `forbidden`（403），§7.4 改用它表达"已认证但无权"（v1 那一格曾退化用 `401 unauthenticated`，已留更正痕迹）；§15 给 R4 加"已裁决 accepted"、给 R5 加"已裁决 rejected（本轮不做 `devices.list`）"，其余 10 行原文未动；§16 追加本行。**协议版本号仍是 `version: 1`：没有增删任何端点、帧、method 或字段，没有改动任何已有错误码的名字、状态码或语义。** |
| v3 | 2026-10-08 | CRD 0004 更正：§4.6 与 §7.2 里"配对码归一化后 20 个字符 / 100 bit 熵"的散文字样更正为 **24 个字符 / 120 bit 熵**（同段正则 `^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){5}$` = 6 组、例子 `K7QP-3MZD-9XTB-2RCV-6HNF-0JWS` 本来写的就是 24，两处**一个字都未改动**）；§4.6 段末留一行更正痕迹；§16 追加本行。**协议版本号仍是 `version: 1`：只更正一个散文数字，没有增删任何端点、帧、method 或字段。** |
| v4 | 2026-10-08 | **CRD 0006 加法（用户明确覆盖旧约束：允许新建会话）**：新增两个 method **`models.list`（§9.5）** 与 **`session.create`（§9.6）**，method 白名单 **4 → 6**（§1 / §6.2 / §7.3 / §8.4.7 / §12.1 / §13）；**§3 第 5 条"手机不能新建会话"被改写**为"手机只能新建**当前工具真实支持**的会话，且**必须落在电脑上那个桌面应用里**"（原文保留在改写说明里），并新增 §3 第 11 条"六个 method 之外没有通道、不得长出执行任意命令的口子"；§6.2 新增三个错误码 **`tool_unavailable` / `model_not_available` / `session_create_failed`**（都是 HTTP 200）；§7.3 新增两张白名单表与 `model` / `provider` / `reasoningEffort` / `cwd` / `projectId` / `requestId` 的字段约束，`models.list` 默认 `timeoutMs` **15000**、`session.create` 默认 **30000**；§9.7 `capabilities` 新增四个位（`models.list:codex` / `models.list:dsh` / `session.create:codex` / `session.create:dsh`，扁平两键也接受）；§11 时序新增**步骤 7（列模型）**与**步骤 8（桌面应用内新建会话 + 部分成功）**，原 7–14 顺移为 9–16，并换掉"拿 `session.create` 当 `unknown_method` 反例"的旧示例；§13 新增服务端测试 3、电脑端测试 3、手机端测试 1–3；§14 新增第 6 项；§15 新增 R13 / R14 两条**待电脑侧实测**的条目；§16 追加本行。**协议版本号仍是 `version: 1`：两个 method 是**新增的可选能力**，不是破坏性变更；已有四个 method（`sessions.list` / `session.read` / `session.send` / `session.stop`）的名字、`params`、`result` 与语义**一字未改**（CRD 0006 §兼容性）。** |
| v5 | 2026-10-08 | **CRD 0007 加法**：§9.2 `session.read` 的 `result` 新增**可选**字段 **`historyTruncated`**（boolean；省略等价 `false`），并新增长历史截断规则（保留 §8.2 的 256 KiB 帧上限不变，按 **UTF-8 完整 envelope ≤ 240 KiB** 裁剪、**优先丢更旧的消息**、截断过长的工具输出；一旦截断**必须**置 `historyTruncated: true`；**发送失败必须回一个短错误，不得静默返回 `false`**——沉默正是这次超时的原因），并写明**手机不得把它当错误**、**`capabilities` 不新增位**；§13 新增电脑端测试 4（帧字节数 + 截断行为 + 不得静默失败）与手机端对截断的处理断言；§15 追加 CRD 0007 的落地说明；§16 追加本行。**协议版本号仍是 `version: 1`（纯加法：新增一个可选字段，旧客户端忽略即兼容；旧电脑侧不发该字段时行为与 v4 一致）。** |
