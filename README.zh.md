# AI Remote — 手机 AI 工作台

在 Android 手机上统一操作 Windows 电脑中已打开的 Codex Desktop 与 DSH Desktop，并读取 WorkBuddy 的本地聊天：继续已有聊天、按已有项目新建会话、选择真实模型、查看任务状态，并处理工具实际提供的待回答事项。

[English](README.md)

## 已实现的功能

- 会话、任务、设置三个视图；搜索、工具和项目筛选、置顶、浅色/深色/跟随系统。
- 接着操作电脑里的原会话。新建时选择工具、已注册项目、模型与思考强度。
- 聊天输入区选择下一条消息的模型，候选来自电脑当前可用的真实目录。
- Markdown 标题、表格、代码块、复制代码；工具活动折叠，轮询保留展开状态。
- DSH 正在执行的任务可停止；原生提问可回填，包括工具执行中嵌套的提问。只有真实待批准事件出现时才提供权限操作。
- 轮询保留草稿、焦点与光标；短视口下可滚动到模型、思考强度与发送控件。
- 电脑端输入姓名并保存独立电脑编号；管理员通过一次性登记码接入其他电脑。
- 独立管理员登录，按人员查看在线／离线电脑和可用 AI 工具，指定电脑打开工作台；普通配对只访问自己的电脑。
- WorkBuddy 的本地会话和消息进入同一个工作台，支持 Markdown 与折叠工具记录；目前为只读接入。

## 技术结构

```text
Android WebView / 手机浏览器
            | HTTPS
Go 中转 + SQLite + Caddy（公网服务器）
            | 电脑主动建立的出站 WSS
Windows Node.js 桥接程序
            | 本机命名管道 / 回环 HTTP
Codex Desktop / DSH Desktop
```

AI 在电脑上执行。服务器只转发白名单 RPC，保存设备认证哈希和审计元数据，不保存聊天全文。电脑无需开放公网入站端口。

| 目录 | 内容 |
| --- | --- |
| `mobile/web` | 手机页面的主源码及本地 Markdown 库 |
| `mobile/android` | Java WebView 壳、Android 资源和 APK 构建脚本 |
| `desktop` | 电脑桥接、本机配对页面、工具适配、测试和便携 ZIP 打包 |
| `relay` | Go 中转、SQLite、协议校验和 Linux 部署脚本 |
| `qa` | 独立中转验收用例 |
| `docs` | 初始协议与设计决策 |

`relay/web` 是 `mobile/web` 的部署副本。修改网页后，两份目录必须逐字节一致。

## 启动电脑端

需要 Node.js 22 或以上，以及已启动、已登录的对应 AI 桌面工具。电脑端没有 npm 依赖。

日常用户直接启动电脑端，在[本机页面](http://127.0.0.1:18989/)输入姓名、服务器地址和管理员生成的一次性登记码。凭据由程序保存到 `%USERPROFILE%\.dsh\ai-remote-desktop.json`，网页不会显示它。

只有首次部署的引导电脑需要在本机配置服务器生成的引导凭据：

```json
{
  "relayUrl": "wss://101.43.98.18/bridge",
  "bridgeToken": "<在中转服务器生成的 token>",
  "tools": ["codex", "dsh"]
}
```

填写真实值后的配置不得提交。可以用 `AI_REMOTE_CONFIG` 指向其他配置文件，或用 `AI_REMOTE_BRIDGE_TOKEN`、`AI_REMOTE_RELAY_URL` 覆盖对应字段。

```powershell
node desktop/src/index.js --self-check
node desktop/src/index.js
```

在本机页面保存姓名并登记后，生成一次性配对码，在手机输入。使用期间保持桥接程序、电脑和桌面 AI 工具运行。引导凭据只绑定第一台电脑，其他电脑应使用自己的登记码和独立凭据。

从桌面双击启动时，桥接程序可只读查询当前用户的 Codex 本机索引，识别已有的桌面用户会话作为调用上下文。它不会为此新建聊天或读取消息正文；显式配置仍优先。自动发现需要 Node 22.13+，便携包已包含符合要求的运行时。索引版本不兼容或没有本机会话时，会明确提示先打开本机聊天或配置上下文。

## 管理员与多电脑

首次在服务器执行 `ai-remote-relay --init-admin --config /etc/ai-remote-relay/relay.json --admin-username admin`，从标准输入提供独立管理员密码。该命令拒绝覆盖已有管理员，仅保存加盐 PBKDF2-SHA256 校验值（310,000 次），不接收命令行密码。

手机登录页点击「管理员登录」。登录后按姓名查看电脑、生成有效期十分钟的一次性电脑登记码，并打开指定电脑的工作台。电脑姓名只用于显示，同名电脑仍以独立编号区分。

配对码绑定生成它的电脑。管理员操作必须带目标电脑编号，目标离线时明确失败。会话、草稿、模型目录、提问与授权状态按电脑隔离。审计保存操作人、目标、方法和结果，不保存聊天内容。协议见 [multi-computer.md](docs/design/api/multi-computer.md)。

## 所有人共享 AI 工具 Skill

服务器配置显式设置 `"sharedTools": true` 并重启中转后，每个已登记电脑用户或有效配对用户都能通过 `/api/fleet/computers` 和 `/api/fleet/rpc` 发现并调用所有人的 AI 工具，包括查看历史、选择项目、发送任务、停止、回答提问和仅本次授权／拒绝。默认关闭；开启代表允许互相操作电脑上的项目和文件。邀请登记、管理员配置仍需要管理员权限，原手机 `/api/rpc` 保留配对绑定。

下载 [AI Remote Dispatch Skill](https://101.43.98.18/downloads/AI-Remote-Dispatch-Skill-1.0.0.zip)，将压缩包中的 `ai-remote-dispatch` 文件夹放进 `%USERPROFILE%\.codex\skills\`。在新聊天中使用：`$ai-remote-dispatch 找到所有人的可用 AI 工具，选择合适的工具回答……`；要多工具对比可说“让所有可用工具分别回答并汇总”。源码和完整用法见 [SKILL.md](skills/ai-remote-dispatch/SKILL.md)。

Skill 自动读取每个人自己的 `%USERPROFILE%\.dsh\ai-remote-desktop.json` 登记凭据，不需要管理员密码。运行时使用 Node 22+；电脑端便携包中的 `node.exe` 可直接使用，无需 npm/Python。模型、项目和可执行能力取自目标电脑的实时目录；新任务默认独立聊天，保留任务编号以续查，写入请求不自动重试。调用审计记录发起电脑、目标、方法与结果，不记录聊天正文。

## 测试

在仓库根目录执行，需要 Node.js 22+ 和 Go 1.27：

```powershell
node --test desktop/test
node --test "mobile/tests/*.test.js"
node --test skills/test/remote-ai.test.cjs
Push-Location relay
go test ./... -count=1
Pop-Location
```

源码仓库不含 Android 签名材料。未提供 `mobile/.private/keystore.pass` 时，发布签名口令泄漏检查会明确跳过；其他源码检查仍然运行。本机存在口令文件时，该检查仍严格读取并核对泄漏，不自动生成假口令。

独立验收 `qa/T-relay` 需要为测试机器构建中转二进制。下载白名单用例还需要本地构建的 `mobile/dist/AI-Remote-Android.apk`。Windows 下：

```powershell
Push-Location relay
go build -o dist/ai-remote-relay-windows-amd64.exe ./cmd/ai-remote-relay
Pop-Location
Push-Location qa/T-relay
go test ./... -count=1
Pop-Location
```

## 打包与部署

电脑端使用官方 Windows Node.js 运行时打包：

```powershell
node desktop/scripts/pack.mjs --node C:/path/to/node.exe
```

输出 `desktop/dist/AI-Remote-Windows.zip`，包含运行时和 `Start-AI-Remote.cmd`，按文件白名单打包。

Windows 交叉构建 Linux 中转：

```powershell
$env:GOOS = 'linux'
$env:GOARCH = 'amd64'
$env:CGO_ENABLED = '0'
Push-Location relay
go build -trimpath -o dist/ai-remote-relay-linux-amd64 ./cmd/ai-remote-relay
Pop-Location
Remove-Item Env:GOOS,Env:GOARCH,Env:CGO_ENABLED
```

部署参数见 [install-centos.sh](relay/deploy/install-centos.sh)，配置键见 [relay.json.template](relay/config/relay.json.template)。真实服务器配置用 `--init` 生成，token 不得发布。Caddy 终止 TLS，中转仅监听回环。现有部署脚本面向 `101.43.98.18`，IP 证书由定时器自动续期；部署到其他地址时需一致修改地址与 Origin。

重建 Android 需准备 JDK 17（脚本目前使用 `D:/env/jdk17`，可按本机路径修改）、`mobile/.tools/sdk` 下的 Android platform 35 和 Build Tools 35.0.0，以及 `mobile/.private` 下自有签名密钥和口令。执行 `pwsh -File mobile/android/build-apk.ps1`。SDK 与签名材料不在 Git 中；换用新签名密钥无法覆盖安装其他密钥签名的 APK。

## 当前验证与限制

已在真实桌面会话中验证 Codex 项目新建与聊天内切换模型、DSH 正在运行时的停止，以及原生嵌套问题回填。布局验收使用 360/390/430 像素宽的浏览器画框及短视口模拟。

- Codex 当前 app-tools 提供列表、读取、新建、发送；没有向桥接程序提供停止、问题回填或权限批准工具，界面如实提示限制。
- Codex 读取原生最近 10 轮窗口，另有消息条数与帧预算限制，不是完整历史导出。
- DSH 原生选模型操作同时保存以后会话的默认模型。
- 原生权限提交链路有自动化测试；本机当前审批设置下尚未完成真实手动权限批准验收。
- WorkBuddy 读取当前 Windows 用户的 `.workbuddy/workbuddy.db` 本机会话信息和 `projects` 下的 JSONL 消息。可用 `WORKBUDDY_CONFIG_DIR` 或私密配置中的 `workbuddy.configDir` 指定自己的数据目录；不会修改原库，不会把云端或未知账号目录当成本地历史。读取有字节、条数和帧预算限制，截断会明确标记。
- WorkBuddy 续聊、新建、模型选择、停止、提问和授权暂未接入，手机标注「只读」。需要这些操作时可按[官方手机端说明](https://www.codebuddy.cn/docs/workbuddyapp/features/Multidevice)使用同一账号的官方 App。已用本机 1 条真实会话验证用户消息、AI 回复、公网读取与手机 Markdown 展示；显示遵循原生历史投影规则，自动注入的系统提醒不会混入用户消息正文。其他边界使用隔离的原生格式样例验证，不写入用户原库。
- 尚未在实体 Android 手机上完成安装、软键盘及系统安全区测试。

服务器凭据、本机配置、原生工具提取文件、日志、部署记录、二进制和签名材料均排除在源码仓库之外。浏览器第三方库说明见 [mobile/web/vendor](mobile/web/vendor/README.md)。
