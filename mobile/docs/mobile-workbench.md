# 手机端 AI 工作台 — 界面与线协议实现说明

本文记录 `mobile/` 这一层的**真实实现**：网页工作台的三个视图、会话详情里
的待答问题与权限审批、以及它们对应的**加性**线协议字段。所有事实都来自本仓库
的真实源码与真实测试输出；未实测的部分在第 8 节逐条列出。

- 代码：`mobile/web/{index.html,css/app.css,js/*.js}`
- 测试：`mobile/tests/*.test.js`（`D:\env\node.exe --test`）
- 线协议契约（**不属于本层**，由根集成维护）：`docs/design/api/protocol-v1.md`

## 0. 外壳：新建动作与退出登录的位置

- **新建会话**是**顶栏里的一个紧凑动作**（`#new-session-button`，`.icon-action`，
  44×44 命中区，`aria-label="新建会话"`），不再是会话列表底部的整宽按钮 ——
  底栏按钮会一直压着列表的可视高度。它只做一件事：打开 `#new-screen`。
- **退出登录只有一个控件**，就是 `#logout-button`，位于 **设置** 视图的「账号」
  分组里。**id 与行为都没变**（仍是 `POST /api/logout` 后回到配对页），
  原来的 `#settings-logout-button` 重复控件已删除；会话列表里不再有任何
  整宽页脚按钮。
- 会话卡片上的工具标签显示 **产品名**（`Codex` / `DSH`），不是线上的小写 id；
  手机不认识的工具仍显示它自己的 id，绝不冒充这两个之一
  （`core.toolLabel` / `core.TOOL_LABELS`）。搜索索引同时含 id 与显示名，
  所以照着屏幕上看到的字搜索也能命中。
- 样式是中性浅/深两套色、单一强调色；图标圆点、分组标题与间距只做层级提示。

## 1. 工作台三个视图

不是三个路由，也不是三个 `<section>`：**「会话 / 任务 / 设置」是同一个
`#list-screen`/`#settings-screen` 视图组的三种形态**，切换视图不会丢刷新、搜索词或筛选。

| 视图 | 内容 | 数据来源 |
| --- | --- | --- |
| 会话 | 全部会话，可搜索、按工具筛选、按项目筛选、置顶 | `sessions.list` |
| 任务 | 只留 `status=working`、`status=error` 或 `needsInput=true` 的会话，并给一行中文总览 | `sessions.list` 的真实状态 |
| 设置 | 外观（跟随系统/浅色/深色）、筛选记忆、置顶统计、退出登录 | 本机 `localStorage` |
`#tab-tasks-badge` 上的数字 = **真实**的工作中 + 出错 + 待确认会话数；
一个会话都没有时徽标整体隐藏。**不编造进度、不编造卡片**。

## 2. 会话列表：搜索、筛选、置顶

- **搜索**：纯文本匹配标题 / 工具 / 状态中文名 / `cwd` / `id`（`core.filterSessions`）。
  搜索词**刻意不持久化** —— 记住搜索词会让"重启后列表莫名空白"。
- **工具筛选**：`全部 / Codex / DSH` 由**列表里真实出现的 tool** 生成
  （`core.toolChips`）。出现一个手机不认识的工具（例如 `trae`），它会有**自己的筛选项**，
  而不是被过滤到看不见。
- **项目筛选**：底部抽屉（sheet）。候选项目 = **各工具实时 `models.list.projects`
  的并集** 与"当前列表里会话真实报告的项目"的并集，**按真实目录去重**后显示
  （`core.mergeProjectOptions`）。搜索匹配项目名 / id / 完整路径 / 工具名。
  **绝不注册、绝不编造项目。**
- **同一个目录只出现一次**：`core.canonicalPath` 是目录的相等键 ——
  统一分隔符、去掉尾部 `\` 或 `/`、去掉首尾空白、**大小写归一**。
  `D:\work\app`、`d:/work/app/`、`D:\Work\App` 是同一个目录，
  所以"目录相同、写法不同"不会变成两行；**真正不同的目录仍是两行**。
  路径内部空格保留（`C:\Program Files` 是一个目录）。
  大小写归一是有意为之：驱动这台工作台的只有 Windows，而比较键**从不发给
  电脑**，只用于判断相等。
- **工具线索**：目录若被两个工具都真实报告，抽屉里仍是**一行**，
  行内用 `Codex` / `DSH` 两个小标签说明"这个目录在这两个工具里都有项目"
  （`core.projectToolIds`，线上 id 存在 `toolIds` 里备用）。
  抽屉会为**每个有能力的工具**各取一次 `models.list`，因为诚实的线索需要
  每个工具自己的清单；还没回来的工具**没有线索**，不会猜。
- **筛选值**：抽屉里的行按 `.sheet-row-active` 高亮，用目录的
  **可匹配集合**判断（`core.projectOptionMatches`，id 与规范路径都算），
  所以旧版本存下来的"原始路径"筛选仍然高亮同一行、选中同一批会话
  （`core.filterByProject` 接受第三参数：本次抽屉的导航选项）。
- **置顶**：`☆/★` 是本机偏好（`localStorage`，键 `rc.workbench.v1`），
  只影响这一台手机的排序，不写回电脑、不影响任何会话。
- **待确认徽标**：`待确认` 只由桌面端真实发送的 `needsInput: true` 决定，
  **不从标题、消息内容或状态猜**（`core.sessionNeedsInput`）。

记住的偏好只有：**主题、当前视图、工具筛选、项目筛选、置顶集合**；
切走再回来（含轮询、失败、导航）都不丢。存储不可用（无痕、WebView 关掉 DOM storage）
时**静默降级为内存默认值**，不抛异常、不挡用。

## 3. 会话详情

- 用户 / AI 气泡用 Markdown（`marked` + `DOMPurify`，严格白名单，**未改动 vendor**）；
  工具 / 系统消息**折叠**成 `<details>`，默认收起，展开状态按消息 id 键保存在
  `state.expandedActivity`，2 秒轮询**不重建节点**，因此不会丢展开、不会丢选区、不会跳滚动位置。
- 代码块与表格在**自身内部**横向滚动；代码块右上角有复制按钮。
- 顶部的"已显示最近记录"提示（`historyTruncated`）在 `#message-list` **之外**，
  显示 / 隐藏都不会移动阅读位置。
- **草稿按会话隔离**：切换会话时先把输入框内容存回**旧会话**的草稿，
  再恢复**新会话**的草稿（`state.drafts`）。没有草稿时输入框**清空**——
  否则为 A 打了一半的字会被发到 B。
- **晚到的回包**：`session.read` 的结果用「请求代际 + 目标 sessionId + 当前屏」
  三重校验，过期回包整包丢弃（`isStaleDetailResponse`）。
- 停止按钮：能力位 `stop:<tool>` 为真且 `canStop === true` 才可用；
  电脑不支持该能力时按钮**保留但置灰**并给出中文原因。

### 3.1 2 秒轮询不得重建用户正在操作的控件

待答问题、权限审批、模型选择器都由 `reconcileByKey` 按**键 + 原生表单签名**
做增量化重绘：

| 面板 | 键 | 签名内容 |
| --- | --- | --- |
| 待答问题 | 原生 `callId` | 每个问题的 id / 单多选 / header / 题面 / detail / **选项 label 与描述的顺序**，加上该批次的回执状态 |
| 权限审批 | 原生 `approvalId` | sessionId / approvalId / toolName / callId / reason，加上回执状态 |
| 模型选择器 | 单个容器 | 工具 / 已选模型键 / effort / 目录状态 / 电脑报告的当前模型 / 选项键序列 |

- **签名不变 ⇒ 同一个 DOM 元素原封不动**：不重建、不换节点，因此
  `document.activeElement`、光标与选区（`selectionStart/End/Direction`）以及
  已选中的 `aria-pressed`/`option-active` 都保持原样。回执与说明文字每次都会
  重新写入同一位置（只写文本，不换控制件）。
- **签名改变 ⇒ 真的重建**：新的原生表单是不同的控件集合，不能只在旧控件上
  改文案。重建前会先 `reconcileDraftWithForm` 把"已经不在选项里的选择"删掉，
  避免留下一个看不见也取消不掉的隐藏答案。
- **控件消失 ⇒ 直接移除**：`callId` 不再被报告时整张卡片从 DOM 移除
  （而不是留在隐藏面板里），所以后来的一次误触不可能提交旧表单；
  提交前 `core.validateAnswers` 还会用**当前**批次再校验一次。
- **焦点不做盲目恢复**：只有"重绘开始那一刻确实持有焦点"的控件，
  才按其**语义键**（`data-custom-for` / `data-option-label` / `id` / 模型键）
  在重建后的等价控件上恢复焦点与光标。用户自己点去别处，轮询不会把人拽回来。
- **模型选择器与审批按钮同样不churn**：模型选择器内部只在签名变化时重绘，
  相同的轮询连选项节点都不重建；审批卡片的两个决定按钮在相同轮询下保持
  同一个元素、同一个焦点。

## 4. 「下条消息模型」选择器

手机端**默认「沿用当前模型」**，此时 `session.send` 发送的 body 与旧版**逐字节相同**
（`{tool,sessionId,text}`），老桌面继续可用。

主动选择某个模型时（`core.sessionSendBody` + `core.sendModelOverride`）：

- `model` = 该条目的 `id`；
- `provider` **跟随所选条目**（同一个模型 id 在不同 provider 下是两个模型，
  见 `core.modelOptionKey` 的 U+0000 唯一键）；**Codex 永不带 provider**；
- `reasoningEffort` 只在用户真的选了具体模型时才可能带上（选项来自该模型
  `reasoningEfforts`，默认取 `defaultReasoningEffort`）。
- 「沿用当前模型」时**不附任何 effort**；那一行只显示电脑报告的当前 effort，
  并明确标注「（当前）」，因为它**是信息，不是选择**。
- **这是"下一条消息"的覆盖，不是会话级设置**：不改电脑上的默认模型、
  不写设置文件、不发任何额外请求。

`session.read.currentModel` 是电脑报告的**原生当前模型**，只有它才能让界面说"现在"。
选择器里的选择值只是**偏好**，两者绝不混淆；Codex 的 `read_thread` 不带该字段，
因此界面**明说"电脑没有报告这个会话当前使用的模型"**，不猜。

## 4.1 新建会话：项目 id 必须来自**所选工具自己的**实时目录

`models.list` 的结果按**工具**分别缓存（`state.sessionCatalogs`）。
新建面板的下拉框只列**当前所选工具**那一份清单，并且：

- 从列表页带进来的目录（`prefillProjectId`）会**先按所选工具的清单解析**
  （`resolveProjectIdForTool`：先比 `project.id`，再比规范目录），
  解析得到的是**该工具自己的 id**；解析不到就不预选。
- **切换工具会重新解析**：`A` 工具的项目 id **绝不**在切到 `B` 之后仍然生效
  （预选值在第一次渲染后即被消费，不再跨工具复用）。
- **提交前再解析一次**（`submitNewSession`）：真正发出的 `projectId` 是
  **提交那一刻**从该工具清单里取到的 id。若该目录不在所选工具的清单里，
  就**明确拒绝并说明**（"这个项目不在 DSH 的项目列表里…"），
  既不换用另一个工具的 id，也不悄悄退化成"不使用项目"。
- 自由目录（`cwd`）仍然只在 **DSH** 显示与发送；Codex 的原生创建没有 `cwd`，
  它只能用一个真实 `projectId`。选中项目时**绝不**同时带 `cwd`。
- `requestId` 的既有规则不变：一次尝试一个 id，重试复用，改动内容才换新。

## 5. 待答问题（`pendingQuestions` → `session.answer`）

界面标签、选项、单选/多选、`header/detail` **全部来自桌面端投影**，
手机一个都不生成。

- **能力缺失**（`session.answer:<tool>` 不为真）→ 面板显示**真实的问题文字**，
  并写明"这个会话不支持在手机上回答，请在电脑上回答"，
  **不出现任何假按钮**（`Codex lacks native answer tool` 属于这一类）。
- **超出可表示范围** → 整批**拒绝展示为可回答**（`core.pendingQuestionsState === 'oversized'`），
  并诚实提示"超出手机能安全展示的范围，请在电脑上回答"。
  宁可说不，也不给一份缺项的表格。
- **边界**（`core.Q_LIMITS`，与 relay 一致）：≤4 批 / 会话，≤8 问 / 批，
  ≤12 选项 / 问，题面 ≤1000、header ≤200、选项文字 ≤500、自定义答案 ≤1000 字符。
  截断按**码点**计数，不会把 emoji 切一半。
- **草稿按 callId 保存**：选中的选项与自定义文本存在 `state.answerDrafts`，
  轮询不丢；半截死的自定义文本不回写 DOM 以免跳光标。
- **提交前校验**（`core.validateAnswers`）：callId 仍在、每个问题都有答案、
  单选只能一个、选项必须是**当前真实存在的 label**、选项与自定义文本不能同时出现在单选里。
  校验不过就**不发请求**，并说明缺什么。
- **只提交一次**：同一 `callId` 的提交成功后按钮置灰、回执显示「已提交，等待电脑处理…」，
  卡片**不消失**——只有电脑端自己不再报告该批次（自然结算/取消）才会消失。
  失败/过期（`accepted !== true`）时**保留用户的选择**、显示中文原因、允许重新提交
  （那是用户的下一次显式点击，不是自动重试）。

## 6. 权限审批（`pendingApprovals` → `session.approve`）

- 卡片显示真实的 `toolName`、`reason`（以及 `callId`，若有）。
  文案明确写：**只对这一次请求生效，不改变电脑的权限设置**。
- 两个按钮：**「仅允许本次」/「拒绝」**。**没有** allow-always、没有全部允许、
  没有自动同意、没有策略修改，也没有任何通用 RPC 通道。
- 每次点击**只提交一次**（同 `approvalId` 成功后按钮置灰）。
- 回执只说 **「已提交，等待电脑确认…」**：HTTP/适配器成功只代表**传输被接受**，
  **不代表这台手机赢得了竞争**。另一台设备可能先答了，所以界面
  **绝不说"已允许""授权成功"**；卡片只在电脑端真的不再报告它时消失。
- 过期/取消（`accepted !== true`）→ 显示中文错误，卡片**保留**且仍可操作
  （电脑端才是判断"还有没有效"的唯一权威）。
- 能力位 `session.approve:<tool>` 为假 → **不出现审批面板**。

## 7. 测试与实际跑过的命令

```
D:\env\node.exe --test D:\workspace\codex-workspace\remote-control\mobile\tests\*.test.js
```

最近一次真实输出：`# tests 166 / # pass 166 / # fail 0`。

| 文件 | 覆盖 |
| --- | --- |
| `tests/core.test.js` | 原有纯逻辑（配对码、状态、body、折叠…） |
| `tests/core-workbench.test.js` | 视图/工具/项目筛选、置顶、任务统计；**目录规范化与相等**（`canonicalPath`：分隔符 / 尾分隔符 / 大小写 / 首尾空白，以及根与空值）；**一组目录一个导航选项**（`mergeProjectOptions`：目录相同写法不同合并、真不同则分列、工具线索、同一 id 不重复）；**工具显示名**；`session.send` 的模型覆盖；`session.answer`/`session.approve` body；问题/审批投影与**边界拒绝**；`validateAnswers` 基数规则；`prefs` 往返与投毒存储 |
| `tests/app.test.js` | 原有 UI 行为、两个异步竞态、模型下拉唯一值；会话卡片显示**产品名而不是线上 id** |
| `tests/app-workbench.test.js` | 三视图、筛选、抽屉、置顶、主题、筛选记忆；**顶栏新建动作与「设置里唯一的退出登录」**（含 id 不变、列表内无整宽页脚按钮）；**同一目录两种写法只出现一行且带双工具线索**；**新建会话按所选工具解析 projectId**（含切工具重新解析、跨工具 id 拒绝提交）；模型芯片/选择器/effort；**问题作答一次性与竞态**；**相同轮询不重建控件 / 焦点与光标保留**；**表单变化则真重建、表单消失则控件移除、陈旧控件提交被拦**；**审批与模型控件不churn**；草稿隔离、阅读位置、晚到回包 |
| `tests/workbench-server.test.js` | **真实 `api.js` + 真实本地 HTTP**（mock relay）：投影往返、answer/approve 往返、过期拒绝、参数白名单、Origin/鉴权、静态页面字节 |
| `tests/source-guards.test.js` | 静态守卫（无注入、无 CDN、无秘密、Android 壳安全） |
| `tests/api.test.js` | HTTP 客户端契约 |

`tests/dom-harness.js` 是**最小 DOM 替身**：它按需补上了真实的
文本选区接口（`selectionStart/End/Direction`、`setSelectionRange`），
因为"轮询后光标还在原处"没有这个就没法测；它仍然**故意不提供** `find`/`findAll`
之类的非标准方法，也仍然把 `innerHTML` 设成抛异常。

`tests/mock-server.js` 的**旧默认值全部保留**，只新增可选注入：
`catalog/modelsResult/currentModel/pendingQuestions/pendingApprovals/createResult/
sendResult/stopResult/answerResult/approveResult/onAnswer/onApprove/sessions`。
不传就与旧行为一致。

**已删除**（由上一轮任务授权）：`tests/layout-probe.js`、`tests/polish-layout.test.js`
——那是 CSS token / 手工布局探针，不是功能回归。真实浏览器宽度检查
（360/390/430 无整页横向溢出）由根在同源 iframe harness 上跑**同一份静态字节**。

## 8. 未验收点（如实）

1. **没有与真实 relay/desktop 联调**：`session.answer` / `session.approve` /
   `models.list` / `session.create` 全部打在 mock relay 上。
   **目录去重与工具线索依赖真实 `models.list.projects` 的写法**：本层只用
   mock 的目录（互不相同、只差分隔符）验证过；真实桌面若给出同一目录的
   **第三种**写法（例如 UNC `\\server\share` 与映射盘符 `Z:\`），
   规范化后仍是两个不同字符串，因而会显示成两行 —— 这是**已知边界**，
   没有实测样本。
2. **没有在真机 Android WebView 上验证**：键盘遮挡、safe-area、触摸目标
   （含顶栏 44×44 的新建动作）只有 CSS 与 mock DOM 依据；
   360/390/430 的真实浏览器宽度检查由根负责。
3. **没有重打 APK**：本轮改动全在服务器托管的 web 层，APK 壳只 `loadUrl`。
4. **DSH 原生审批/问题传输**由根用专用安全会话验证；本层只消费投影。
5. `currentModel` / `pendingQuestions` / `pendingApprovals` / `needsInput`
   都是**可选**字段：桌面端不发时界面按"没有"处理（不发按钮、不猜值）。
6. **光标恢复的宿主差异**：焦点与光标按语义键恢复，依赖宿主提供
   `activeElement` / `selectionStart` / `setSelectionRange`。宿主不提供时
   代码会跳过恢复（不抛异常），此时"轮询后光标位置"只有 mock DOM 的证据。
7. **`role="tablist"` 未加**：`#tabbar` 目前只有 `role` 语义的空缺（三个按钮各自
   可点、`aria-selected` 已设），但本轮**没有**改 ARIA 结构，也没有做屏幕阅读器实测。

