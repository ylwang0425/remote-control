# CRD 0007 — `session.read` 结果被截断时必须显式声明（`historyTruncated`）

> 撰写：PM（seam owner）｜ 日期：2026-10-08 ｜ 状态：**accepted（用户已实证并要求，属接口加法，不需要再次审批）**

## 谁提出的

**用户/协调者**。现场实证：`desktop.read` 取 PM 会话 200 条消息时，JSON 达 **287 733 字节**，
**同时超过两端的 256 KiB 帧上限**（§8.2 每帧 262 144 字节）→ 电脑侧 `sendFrame` 返回 `false` →
手机侧**超时**。这是**真 bug，不是措辞问题**。

## 他们要什么

1. 电脑侧**保留** 256 KiB 上限，但按 **UTF-8 完整 envelope 预算 ≤ 240 KiB** 截断：
   优先丢掉**更旧的消息**、以及**过长的工具输出**。
2. **必须显式声明"这不是全文"**，不得让手机以为读到的是全部历史。
3. **发送失败要给出短错误，不要沉默**（沉默就是现在这个超时）。
4. 接口上**允许** `session.read` 的 `result` 带一个**可选** `historyTruncated: boolean`；
   手机端为 `true` 时显示一句轻量提示（例如"已显示最近记录，部分较早/过长输出未加载"）；
   **relay 的 result 校验接受这个可选 bool**；**旧客户端忽略它，保持兼容**。
5. **不要为这件事再开审批会**（用户明确）。

## 契约改动（加法）

- `session.read` 的 `result` 增加**可选**字段 **`historyTruncated: boolean`**（§9.2 的 result 字段表）。
  - `true` = **本次返回的消息不是全部历史**（因为帧预算截断）。
  - **省略等价于 `false`**（旧电脑侧不发这个字段 → 旧客户端行为不变）。
- **语义边界（写死）**：`historyTruncated` 只描述**本次结果被截断**，**不**表示会话本身有问题；
  手机**不得**因此禁用任何按钮，也不得把它当错误处理。
- **`capabilities` 不新增位**：这是**可选字段**，不是能力。

## 实现约束（写进各模块）

| 模块 | 要求 |
| --- | --- |
| **desktop** | 保留 256 KiB 上限；按 **UTF-8 完整 envelope ≤ 240 KiB** 做预算；超预算时**丢更旧的消息 / 截断过长工具输出**；**置 `historyTruncated:true`**；**发送失败必须回一个短错误**（不得静默返回 `false` 让手机超时） |
| **relay** | result 校验**接受**可选 `historyTruncated: boolean`（类型不对仍按既有判例拒）；**不推断、不改写**该字段；其余行为不变 |
| **mobile** | `true` 时显示**轻量提示**（不打断阅读、不阻塞轮询）；`false`/省略时不显示；**不把它当错误**；配合 `<details>` 活动块，截断的早期内容不假装存在 |

## 成本与顺序

**极小**。这是**纯加法**（一个可选布尔 + 三处行为），不改变任何既有字段语义，`version` 仍为 **1**。
**不得**因此打断主线：Markdown 渲染、工具折叠、新建会话与模型选择仍是**主线**。

## 决定

**accepted** —— 由**用户**实证并提出；PM 记录并分派。**无需再次审批。**

## 新增的 DoD 条目

- `T-desktop.md`：新增 **D18**（截断预算 + 显式标记 + 失败给短错误）——**1 条**
- `T-relay.md`：新增 **R24**（校验接受可选 bool）——**1 条**
- `T-mobile.md`：新增 **M18**（`historyTruncated` 的轻量提示）——**1 条**

## Applied

| 文档 | 新版本 |
| --- | --- |
| `docs/decisions/crd/0007-history-truncated.md` | v1（本文件） |
| `docs/design/api/protocol-v1.md` | v5（架构角色执行：§9.2 加可选 `historyTruncated`） |
| `docs/tasks/T-desktop.md` / `T-relay.md` / `T-mobile.md` | PM 追加各 1 条 DoD |
