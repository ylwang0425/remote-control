# qa/gaps.md — 已知测不到的地方（**PM 拥有；QA 在本轮报告里给出要加的行使，由 PM 写入**）

> 这个文件只增不减地记录"**我们知道但当前环境测不了**"的东西。它比红色的测试更危险，
> 因为红色测试会自己跳出来，而这些空白不会。
> 规则：每条要有 **谁报的**、**为什么测不了**、**在什么条件下能测**。

## 格式

```
### GAP-<n> — <一句话>
- 报自: <角色 / 任务 id / 人>
- 测不了的原因: <真实原因>
- 现在的替代证据: <我们用它顶替了什么，或者"无">
- 能测的条件: <具体到什么机器/账号/网络>
```

---

## 当前清单

### GAP-1 — 服务器侧（CentOS Stream 9 / 101.43.98.18）本轮**没有**真机执行
- 报自: PM（本轮 brief 明确：本轮只生成可审查的部署脚本，由协调者 SSH 执行）
- 测不了的原因: 部署动作本轮不在本机执行范围内
- 现在的替代证据: `relay/deploy/install-centos.sh` 的静态审查 + 本机 `bash -n` 语法检查 + Linux 交叉编译产物存在
- 能测的条件: 协调者在 101.43.98.18 上执行脚本；需 root 登录

### GAP-2 — IP 证书（Certbot + shortlived profile）尚未真签
- 报自: PM
- 测不了的原因: 需要真实的公网 IP 与 80 端口 + 真机 Certbot ≥5.4
- 现在的替代证据: 脚本内写死 `--ip-address 101.43.98.18 --preferred-profile shortlived` 与 HTTP01 webroot 续期 hook
- 能测的条件: 服务器上执行部署脚本后，`openssl s_client -connect 101.43.98.18:443`（**不带 `-k`**）

### GAP-3 — 手机端真实设备上的 WebView 行为尚未实测
- 报自: PM（CRD 0003 的 R1 风险）
- 测不了的原因: 本轮本机无 Android 真机/模拟器
- 现在的替代证据: 桌面 Chromium 同源页面的行为 + 静态分析（由 T-mobile 的 M10 给出，**必须标注哪一种是推断**）
- 能测的条件: 装 APK 到真机并配对一次；观察 `/api/rpc` 是否因缺 `Origin` 被 403

### GAP-4 — Codex Desktop 的"向用户既有聊天发送消息 / 停止"未实测
- 报自: PM（本轮 brief 禁止向用户既有聊天发测试消息或停止请求）
- 测不了的原因: 会污染用户真实会话
- 现在的替代证据: `list_threads` / `read_thread` 的**真实只读计数**（不输出正文）
- 能测的条件: 协调者指定一条**专用的**验收会话后，才可实测 `session.send` / `session.stop`

### GAP-5 — 三端联合的端到端（手机 → 服务器 → 电脑 → 原桌面）未实测
- 报自: PM
- 测不了的原因: 依赖服务器部署 + 真机 APK + 电脑桥三者同时在线
- 现在的替代证据: 各模块自己的测试 + 契约两侧的契约测试
- 能测的条件: 部署完成后，协调者按 `docs/tasks` 的验收步骤跑一次完整配对

### GAP-6 — relay 配置文件在 Windows 上拿不到 POSIX `0600` 语义
- 报自: crew_qa（T-relay，`qa/T-relay/cases_01_03_test.go` TestCase01Init）
- 测不了的原因: 本机是 Windows；Go 在 Windows 上不把 `0600` 映射成 NTFS ACL，`os.Stat().Mode().Perm()` 不代表真实权限
- 现在的替代证据: 生成路径按要求以 `0600` 写入，且已断言"重复 `--init` 不覆盖 / token ≥32 字节（256 bit 熵）/ token 不进终端输出"；用例内打印 `SKIP(POSIX mode): …`
- 能测的条件: 在 CentOS Stream 9 上执行部署脚本后 `stat -c %a /etc/ai-remote-relay/relay.json` 必须为 `600`

### GAP-7 — `/downloads/*` 的符号链接逃逸检查在本机跑不了
- 报自: crew_qa（T-relay，`qa/T-relay/cases_11_12_test.go` TestCase12DownloadsWhitelist）
- 测不了的原因: Windows 创建 symlink 需要特权或开发者模式，本机报 `A required privilege is not held by the client`
- 现在的替代证据: 同一用例已覆盖字面与百分号编码的路径穿越（含 `%2e%2e%2f`、`%5c`、`c:%5c`）、非白名单扩展名、目录段，以及 `Lstat` 分支；符号链接一项 `SKIP` 并打印原因
- 能测的条件: 在 CentOS 上重跑 `TestCase12DownloadsWhitelist`：白名单根外放一个真文件、白名单内建一个指向它的 symlink，必须 404

### GAP-8 — 契约 §7.3 的 `too_long` 在 HTTP 面上无法触发
- 报自: crew_qa（T-relay，`qa/T-relay/cases_07_10_test.go` TestCase08MethodAndParamsWhitelist）
- 测不了的原因: `params.text` ≥16385 字符时，请求体先超过 §5.4 的 16384 字节上限，relay 回 413 `payload_too_large`，`too_long` 永远排在后面 —— 两节的数值互相压住
- 现在的替代证据: 实测 15000 字符的 `session.send` 通过校验并到达 bridge；16385 字符实测得 413；用例内打印 `FINDING` 一行
- 能测的条件: 只能由单元测试直接调参数校验函数触达。若要端到端可测，需调整 §7.3/§5.4 的数值关系（PM 决定）

### GAP-9 — §5.4 的"Content-Length 撒谎"兜底无法用真实请求构造
- 报自: crew_qa（T-relay，`qa/T-relay/cases_07_10_test.go` TestCase07BodyLimitAndContentType）
- 测不了的原因: 声明 `Content-Length: 10` 却发送 20000 字节时，多出的字节按 HTTP 规范不属于请求内容，合规服务器不会读（读了即为请求走私）
- 现在的替代证据: 受限读取器那条路径改由 **chunked body** 覆盖：20000 字节的 chunked 请求实测得 413 `payload_too_large`；另实测"声明 16385 → 413（读 body 之前）"与"恰好 16384 → 不 413"
- 能测的条件: 只有单元测试能直接驱动 `MaxBytesReader` 分支；不需要新环境

### GAP-10 — F1（`/bridge` 握手限速 + audit 双保留）没有独立 QA 用例
- 报自: crew_qa（T-relay，主动声明"我不声称验证过 F1"）
- 测不了的原因: 本轮 QA 的 14 条验收项里没有它，QA 也没有握手洪水用例
- 现在的替代证据: PM 逐行读代码确认 `ws.go` 的 `limits.enter`（L47）在 `Audit`（L58/L66）之前；relay 侧有 `TestBridgeHandshakeIsRateLimitedBeforeAnyWrite` / `TestAuditIsBoundedByRowCount` / `TestAuditIsBoundedByAge`
- 能测的条件: 补一条 QA 用例（90 次未鉴权握手 → 期望出现 429 且 audit 行数受配额所限，而非受尝试次数所限）
