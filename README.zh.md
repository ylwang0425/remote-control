# AI Remote — 手机 AI 工作台

在 Android 手机上统一操作 Windows 电脑中已打开的 Codex Desktop 与 DSH Desktop：继续已有聊天、按已有项目新建会话、选择真实模型、查看任务状态，并处理工具实际提供的待回答事项。

[English](README.md)

## 已实现的功能

- 会话、任务、设置三个视图；搜索、工具和项目筛选、置顶、浅色/深色/跟随系统。
- 接着操作电脑里的原会话。新建时选择工具、已注册项目、模型与思考强度。
- 聊天输入区选择下一条消息的模型，候选来自电脑当前可用的真实目录。
- Markdown 标题、表格、代码块、复制代码；工具活动折叠，轮询保留展开状态。
- DSH 正在执行的任务可停止；原生提问可回填，包括工具执行中嵌套的提问。只有真实待批准事件出现时才提供权限操作。
- 轮询保留草稿、焦点与光标；短视口下可滚动到模型、思考强度与发送控件。

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

在本机创建 `%USERPROFILE%\.dsh\ai-remote-desktop.json`：

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

打开[本机配对页面](http://127.0.0.1:18989/)，生成一次性配对码，在手机输入。使用期间保持桥接程序、电脑和桌面 AI 工具运行。

## 测试

在仓库根目录执行，需要 Node.js 22+ 和 Go 1.27：

```powershell
node --test desktop/test
node --test "mobile/tests/*.test.js"
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
- 尚未在实体 Android 手机上完成安装、软键盘及系统安全区测试。

服务器凭据、本机配置、原生工具提取文件、日志、部署记录、二进制和签名材料均排除在源码仓库之外。浏览器第三方库说明见 [mobile/web/vendor](mobile/web/vendor/README.md)。
