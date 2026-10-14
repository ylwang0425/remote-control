'use strict';
/**
 * Build `dist/AI-Remote-Windows.zip`: a Node runtime, the bridge, and a
 * double-click launcher.
 *
 * The ZIP is written here, in process, with `node:zlib` - no packaging tool is
 * needed on the machine that builds it, and the output is the same everywhere.
 * The archive holds exactly the files listed below; nothing else from the
 * workspace can leak in, because the file list is built from an allow list
 * rather than by walking the tree with exclusions.
 *
 * Usage:
 *   node scripts/pack.mjs [--node <path to node.exe>] [--out <zip path>] [--store-node]
 *     --node        the runtime to bundle (default: D:\env\node.exe, then node on PATH)
 *     --out         output path (default: dist/AI-Remote-Windows.zip)
 *     --store-node  put node.exe in uncompressed (bigger, faster to build)
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const DEFAULT_NODE_CANDIDATES = ['D:\\env\\node.exe', path.join(process.env.ProgramFiles ?? '', 'nodejs', 'node.exe')];

const LAUNCHER_NAME = 'Start-AI-Remote.cmd';
const README_NAME = 'README.txt';
const FULL_CONTROL_LAUNCHER_NAME = 'Start-FullControl.cmd';
const FULL_CONTROL_SCRIPT_NAME = 'Start-FullControl.ps1';
const SOURCE_RUNTIME_FILES = Object.freeze([
  'src/adapters/codex.js',
  'src/adapters/dsh.js',
  'src/adapters/workbuddy.js',
  'src/backoff.js',
  'src/bridge.js',
  'src/codex-context.js',
  'src/codex-native-control.js',
  'src/codex-native-proxy-core.js',
  'src/codex-native-proxy.js',
  'src/config.js',
  'src/creates.js',
  'src/dsh-events.js',
  'src/enrollment.js',
  'src/errors.js',
  'src/framing.js',
  'src/index.js',
  'src/pending.js',
  'src/protocol.js',
  'src/run-stop-request.js',
  'src/ui/server.js',
  'src/workbuddy-native/pending-items.js',
  'src/workbuddy-native/uia-pending-controller.js',
  'src/workbuddy-native/pending-service.js',
  'src/workbuddy-native/history-state.js',
  'src/workbuddy-native/windows-uia.js',
  'src/workbuddy-native/writer.js',
  'src/ws.js',
]);
const FORBIDDEN_PACKAGE_ENTRY = /(?:^|\/)(?:test|tests|private|\.private|\.native-src|\.native-asar|native-asar)(?:\/|$)|(?:^|\/)[^/]*\.test\.[^/]+$|\.asar(?:$|\/)/i;

const LAUNCHER = `@echo off
rem Double-click this file to start the bridge. It lives beside node.exe, so it
rem uses its own folder (%~dp0) and never a fixed path.
setlocal
set "HERE=%~dp0"
if not exist "%HERE%node.exe" (
  echo node.exe is missing from this folder.
  pause
  exit /b 1
)
echo AI Remote desktop bridge
echo Config file: %USERPROFILE%\\.dsh\\ai-remote-desktop.json
echo The local status page opens at http://127.0.0.1:18989
echo Press Ctrl+C in this window to stop.
"%HERE%node.exe" "%HERE%src\\index.js" %*
echo.
echo The bridge stopped.
pause
`;

const README = `AI Remote —— Windows 电脑端桥接程序
====================================

这是什么
--------
这个文件夹里是 AI Remote 的电脑端。它主动连到服务器，并接管这台电脑上**已经打开**
的 Codex Desktop 与 DSH Desktop 会话，让手机可以：

  - 列出并阅读会话（最近 200 条消息；过长历史会截断，并在结果里标注 historyTruncated）；
  - 在**原来那条会话里**继续说话（不新建、不重放历史）；
  - 停止正在执行的一轮（DSH 默认可用；Codex 需要下方明确选择的预览启动）；
  - **新建会话**：先选工具与真实模型（models.list 给的是本机真实目录），再创建；
  - **给下一条消息选模型**：Codex 用发送工具 schema 里写明的模型；DSH 先
    "session/selectModel" 再发送。选模型失败就**不发这条消息**，不会用错模型发出去；
  - **回答会话里等待中的问题**：只呈现后端真实给出的问题和选项；DSH 里 "continued" 的
    提问走原生 "userQuestions/answer"，还开在应用里（"open"）的提问走后端真实转发过来的
    提问事件流；两条路都只在原生状态确认之后才算成功（状态会一起发给手机）。Codex 的原生回答
    仅在下方 FullControl 预览启动下提供；
  - **决定等待中的权限审批**：只有后端真实通过事件流或明确启用的 Codex 原生请求通道发出来的审批请求才会显示，一次点击
    只提交一次"仅此一次允许"或"拒绝"；程序不会自动批准、不会改成“以后都允许”、不会改
    任何策略。手机和电脑同时回答时，以原生先到的那次为准（详见下文）；
  - 手机端把回复按 Markdown 渲染，并把工具调用折叠成活动块（这部分在手机端完成）。

怎么启动
--------
双击 Start-AI-Remote.cmd。会弹出一个命令行窗口，程序一直运行到你在窗口里按 Ctrl+C。

Codex Desktop 原生控制（明确选择的预览功能）
------------------
要让手机停止 Codex 正在执行的一轮、回答 Codex 原生问题或处理真实权限请求，先在 Codex 菜单中正常退出它，
然后双击 Start-FullControl.cmd。它只在确认 Codex 和本地桥接都没有运行时才启动，并为这一轮新建一个
仅当前 Windows 用户、SYSTEM 与 Administrators 可访问的临时控制目录；桥接与新启动的 Codex Desktop
使用同一个目录。目录和运行标识仅在进程环境中传递，不写入普通配置、日志或命令行参数。此启动方式
使用 Codex Desktop 自身版本化的 codex.exe 作为原生 stdio 代理的后端，不会另开 Codex 聊天或重放历史。
Codex 26.1007 的安装路径、app-server 接口及本机源代码已经检查，代理通过了本地协议夹具测试；真实
Codex Desktop 原生激活与端到端操作尚未验收，其他版本也未经验证。这是尚待真实桌面端验收的预览入口，
WorkBuddy 的实测范围见下方说明。正常关闭 Codex Desktop 后，启动器会用该运行私有的一次性
请求让它自己启动的桥接优雅退出，并等待有限时间；若桥接没有响应，只会停止这一个桥接进程，
不会停止 Codex Desktop 或其他桥接。私密控制目录只会在这两个已启动进程都退出、且本次运行创建的
Codex 原生子进程描述符全部消失后删除；若在限定时间内无法确认，不会停止原生子进程，并会保留目录。
也可用
"-CodexDesktopPath" 和 "-CodexCliPath" 参数明确选择安装路径；任何参数都不会绕过现有进程检查。

然后在**这台电脑**的浏览器里打开 http://127.0.0.1:18989 。这个页面显示连接状态，
输入姓名并保存电脑身份；新的电脑输入管理员生成的十分钟一次性登记码后，可生成手机配对码。
它只监听 127.0.0.1，只接受自己的来源与主机名，页面上没有任何执行命令的入口。

服务器配置
----------
本机已有配置时可直接启动，打开本地页面填写或修改姓名。新电脑先由管理员在手机端
生成一次性电脑登记码，再在本地页面填写姓名、https://101.43.98.18 和登记码。
程序会把独立的电脑凭据保存到 "%USERPROFILE%\\.dsh\\ai-remote-desktop.json"，网页不会
显示它。每台电脑有自己的编号与凭据；请不要把第一台电脑的配置复制给其他人。

手机上普通配对只访问生成配对码的电脑。管理员另用独立账号登录，可以按姓名查看电脑、
工具和在线状态，并打开指定电脑的工作台。姓名仅作标签，不会授予管理员权限。

只有在你**自己**要换一台服务器或换 token 时，才需要编辑这个文件：

  %USERPROFILE%\\.dsh\\ai-remote-desktop.json
  {
    "relayUrl": "wss://101.43.98.18/bridge",
    "bridgeToken": "<服务器给的 token>",
    "tools": ["codex", "dsh"]
  }

请把该文件设成只有你自己能读。token 只会发往服务器，出现在连接握手的请求头里；
它不会出现在网址、日志或任何报告里。也可以用环境变量 AI_REMOTE_BRIDGE_TOKEN 代替。

WorkBuddy 本地会话与 UI Automation opt-in
-------------------------------------
默认仍只读 WorkBuddy 本地会话和消息，不会修改 workbuddy.db 或项目 JSONL。自定义数据目录可在
私密配置中设置 workbuddy.configDir，或使用 WORKBUDDY_CONFIG_DIR。

WorkBuddy 5.7.7 已通过原生新建、续聊、下条消息选模型、单题与两题回答、停止任务的公网验收，
自定义文本回答也已读回原生工具结果。
结果已读回它自己的本地消息。模型目录来自实际选择器的 19 个选项；选项在屏幕外时使用标准
ScrollIntoView。发送使用 Windows 原生键盘输入，保护已有草稿，并在模型菜单收起、原会话身份
和精确草稿均确认后点击原生发送。窗口最小化时可恢复；电脑必须保持登录、未锁屏。

允许一次／拒绝只匹配完整原生命令卡及其工作目录，不点击“跳过”或长期允许。本机良性命令
由 WorkBuddy 自动放行，真实审批点击尚未实测；审批路径已通过协议与 C# 夹具检查。
本机版本的新建页未暴露可验证的工作目录选择控件，因此新聊天沿用桌面选定的目录；手机可以
按已有会话的真实目录筛选。未经支持的 projectId/cwd 会在写入消息前被拒绝。

你可以在本机状态页面显式启用 \`workbuddy.uiAutomation.enabled\`，并可选填写绝对
\`WorkBuddy.exe\` 路径。状态页面只保存这台电脑的设置、重新打开本机适配器并更新能力；它不会
启动或关闭 WorkBuddy，也不会改变其他电脑、账号或应用的权限。启用后如需访问 UIA，请先从
WorkBuddy 自身菜单或托盘正常退出，再运行 \`plugins\\workbuddy-native\\Start-WorkBuddy-UIA.cmd\`；
若目标安装仍在运行，启动器会拒绝操作。用 \`Start-WorkBuddy-Standard.cmd\` 可按普通方式启动。
该启动器只给单次进程传入 Chromium 可访问性参数，不修改应用文件或设置，也不开放调试端口。

手机后台查看消息不会恢复最小化窗口，也不会切换电脑上的聊天。本地有效的 WorkBuddy 产品缓存
可直接提供模型列表，避免打开桌面模型选择器；它不代表电脑当前选中的模型。发送前仍重新验证
原生模型选项。独立 CLI 尚未通过桌面登录与同一聊天续聊的兼容性验收，写操作仍采用原生 UIA。

UI Automation 要求 Windows 默认（已解锁）桌面和 WorkBuddy 目标窗口处于前台。状态页中的控件
快照只表示上次观测；每个原生操作都必须在执行前新鲜核验目标进程、窗口、输入桌面和焦点。
会话和消息始终使用 WorkBuddy 原生 ID。提交状态仅表示控件动作已提交；AI 结果由后续原生消息确认。

它能在这台电脑上做什么
----------------------
- Codex Desktop：连接**已经运行**的 Codex 应用自身的 app-tools 命名管道
  （\\\\.\\pipe\\codex-browser-use-<id>）。管道路径由程序自己扫描发现，不写死；
  可以列会话、读会话、往**已有**会话里发消息，也可以用该应用自己的 "create_thread"
  新建一条**真实桌面聊天**（只允许本机 local 项目；不会去开 worktree、不会发到云）。
  模型候选来自该应用实时 schema 里写明的本机可用模型（本机实测 7 个）。
  默认启动仍只使用该命名管道；它没有停止、提问回答或审批工具，所以默认启动不会假装支持这些操作。
  若使用上方明确选择的 FullControl 启动预览，才额外连接到 Codex Desktop 自己启动的 stdio child；
  该通道按会话实际报告的能力逐项启用，并在每次操作时重新核对原生请求。
  给下一条消息选模型：只有当**发送工具自己的 schema** 写明模型目录时才提供，发送时带
  model 与 thinking 两个字段；schema 没写就如实上报“不支持”（"session.send:model:codex"
  为 false），普通的发送完全不受影响。默认启动的命名管道没有回答与审批工具；FullControl 预览只为
  当前确实存在、且完整上下文能安全呈现的 Codex 原生问题或审批显示按钮，答案和决定先标为“已提交”，
  直到原生证据确认。
  从桌面双击启动时，程序只读查询当前用户的 Codex 本机索引，寻找已有的本机用户会话作为
  调用上下文，不会新建聊天、恢复运行或读取消息正文；显式配置仍优先。便携包内的 Node
  支持此发现。索引不兼容或尚未打开本机聊天时，状态页会提示具体设置办法。
- DSH Desktop：通过回环地址连接本机的 DSH 后端，使用这台电脑本来就签发给自己的
  browser-session cookie。cookie 与它背后的密钥只在本机内存中使用，不会离开本机。
  模型候选来自后端真实目录（本机实测 6 个模型 / 3 个 provider，**同一个模型 id 在不同
  provider 下是不同的东西**，所以选模型必须连 provider 一起选）。停止走 "session/cancel"。
  给下一条消息选模型走 "session/selectModel"：先拿**最新**目录核对 provider + 模型 +
  推理档位，任何一项对不上就拒绝并且不发消息。注意 DSH 自己会把这次选择存成**以后新会话
  的默认模型**（后端本来的行为），程序不会去改回来，也不会替你恢复旧值。
  等待回答的问题来自 "session/projections" 里真实的 userQuestions：只呈现原生给出的问题
  和选项，超过能完整显示的数量就**整条拒绝**（绝不截断成一个可以乱答的表单）。
  "continued" 的回答走 "userQuestions/answer"，原生返回 true 才算成功；"open" 的提问走
  后端真实转发的事件流（见下一段），只有在原生 settled 状态里能对上这次答案才算成功。
  失败、过期或无法证实都会明确报错，**不重试、不重复提交**。
  会话当前用的模型同样来自原生状态（modelSelection），读不到就不报，绝不猜。
- DSH 原生事件流（权限审批与"open"提问）：程序用**本机回环**地址连到 DSH 自己的
  WebSocket 事件通道（/api/remote.mux 上的 $events 流），用的是这台电脑本来就发给自己的
  browser-session cookie 与完全相同的来源/主机校验。它**不会**把 DSH 端口暴露到局域网，
  不会改 trustedHosts，不会把任何启动令牌放到手机上，也不会加载 DSH 的前端页面。
  审批请求只从这条原生流里来（原生 eventId 就是唯一身份），回答也只用
  "$events/result" 这一个原生 RPC 提交；不认识的转发事件立刻交还给下一个应答者
  （"next"），绝不私自扣住或自动回答。连接断开/结束/取消时，所有等待中的请求**立即作废**，
  重连后只接受新的事件。
  审批结果分两种，页面必须如实区分：**已提交**（原生传输确认收到，但这**不代表**这次决定
  赢了——手机和电脑可能同时回答，先到的才算）与**已确认**（原生审计里确实记着这次请求就是
  这个结果）。程序绝不会把"HTTP 200"当成"权限已批准"。
  只有真实的一对按钮点击才会提交；没有"全部允许"、没有自动批准、没有策略修改，也没有任何
  通用 RPC 转发入口。原生里等待中的请求超过手机能完整显示的数量时，程序**如实拒绝**，
  而不是给出一个不完整的表单。

新建会话的可靠性
----------------
- 选项目时会拿**本机真实登记的项目**当场核对：Codex 用应用自己的 list_projects
  （只认本机 local 项目，cloud / 其他机器的项目不提供），DSH 用本机只读的
  workspace.json（不写、不改）；不认识的 id 直接拒绝，绝不编一个项目出来。
  项目与目录同时给出却互相矛盾时，在**创建之前**就拒绝。
- 注意 DSH 的原生 session/create 只接受 workspaceId 或 cwd **其中之一**（两个都给会被
  后端拒绝），所以程序核对完只发其中一个。
- "requestId" 用来去重：同一次请求重试**不会**建出第二条会话；
- 如果会话已经建出来、但后续步骤（选模型 / 首条消息）没做完，程序会**把已创建的会话 id
  交给你**，并标注 "partial"，让你直接打开它，而不是再建一条；
- 如果结果未知（例如进程中断），程序**不会**重建，并提示你去会话列表里手动确认 — 这是
  为了避免重复与孤儿会话。

命令行
------
  node.exe src\\index.js --help
  node.exe src\\index.js --self-check
  node.exe src\\index.js --config <路径> --relay <网址> --token-file <路径>
  node.exe src\\index.js --no-bridge

  --help / --version 打印用法与版本
  --self-check 只做本机检查：不联网、不读任何会话
  --no-bridge 只起本地页面，不连服务器
  退出码：0 正常（例如“还没配 token”只是提醒）；1 有硬性检查失败；2 参数写错

运行测试
--------
  node.exe --test test

这个文件夹里的程序**不需要安装任何东西**：只用 Node 自带的模块。
`;

/** CRC-32 as the ZIP format requires it. */
function crc32(buffer) {
  return zlib.crc32(buffer) >>> 0;
}

function dosDateTime(date) {
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
  const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  return { time, day };
}

/**
 * One ZIP entry.
 * @param {{name: string, data: Buffer, store?: boolean}} entry
 */
function buildEntry(entry, when) {
  const { time, day } = dosDateTime(when);
  const nameBytes = Buffer.from(entry.name.replaceAll('\\', '/'), 'utf8');
  const raw = entry.data;
  const method = entry.store === true ? 0 : 8;
  const payload = method === 0 ? raw : zlib.deflateRawSync(raw, { level: raw.length > 8 * 1024 * 1024 ? 1 : 6 });
  const crc = crc32(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(day, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt16LE(0, 28);
  return { local, payload, nameBytes, raw, crc, method, time, day };
}

/**
 * Write a ZIP archive.
 * @param {{path: string, entries: {name: string, data: Buffer, store?: boolean}[], when?: Date}} options
 */
function writeZip({ path: target, entries, when = new Date() }) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const built = buildEntry(entry, when);
    chunks.push(built.local, built.nameBytes, built.payload);
    central.push(
      (() => {
        const header = Buffer.alloc(46);
        header.writeUInt32LE(0x02014b50, 0);
        header.writeUInt16LE(20, 4); // version made by
        header.writeUInt16LE(20, 6); // version needed
        header.writeUInt16LE(0x0800, 8);
        header.writeUInt16LE(built.method, 10);
        header.writeUInt16LE(built.time, 12);
        header.writeUInt16LE(built.day, 14);
        header.writeUInt32LE(built.crc, 16);
        header.writeUInt32LE(built.payload.length, 20);
        header.writeUInt32LE(built.raw.length, 24);
        header.writeUInt16LE(built.nameBytes.length, 28);
        header.writeUInt16LE(0, 30);
        header.writeUInt16LE(0, 32);
        header.writeUInt16LE(0, 34);
        header.writeUInt16LE(0, 36);
        header.writeUInt32LE(0, 38);
        header.writeUInt32LE(offset, 42);
        return { header, nameBytes: built.nameBytes };
      })(),
    );
    offset += built.local.length + built.nameBytes.length + built.payload.length;
  }

  let centralSize = 0;
  for (const item of central) {
    chunks.push(item.header, item.nameBytes);
    centralSize += item.header.length + item.nameBytes.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  chunks.push(end);

  const archive = Buffer.concat(chunks);
  fs.writeFileSync(target, archive);
  return { path: target, bytes: archive.length, entries: entries.length };
}

function collectFiles(dir, prefix, filter = () => true) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      out.push(...collectFiles(full, `${prefix}${name}/`, filter));
    } else if (filter(full)) {
      out.push({ name: `${prefix}${name}`, data: fs.readFileSync(full), path: full, size: stat.size });
    }
  }
  return out;
}

function collectRuntimeFiles() {
  return SOURCE_RUNTIME_FILES.map((name) => {
    const filePath = path.join(ROOT, ...name.split('/'));
    let stat;
    try {
      stat = fs.lstatSync(filePath);
    } catch {
      throw new Error(`required runtime module ${name} is missing`);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`required runtime module ${name} is not a regular file`);
    return { name, data: fs.readFileSync(filePath), path: filePath, size: stat.size };
  });
}

function findNode(override) {
  if (override !== undefined) {
    if (!fs.existsSync(override)) throw new Error(`--node ${override} does not exist`);
    return override;
  }
  for (const candidate of [...DEFAULT_NODE_CANDIDATES, process.execPath]) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  throw new Error('no node.exe found; pass --node <path>');
}

function parseArgs(argv) {
  const args = { storeNode: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--node') args.node = argv[(index += 1)];
    else if (argv[index] === '--out') args.out = argv[(index += 1)];
    else if (argv[index] === '--store-node') args.storeNode = true;
  }
  return args;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const nodePath = findNode(args.node);
  const out = args.out ?? path.join(ROOT, 'dist', 'AI-Remote-Windows.zip');
  const codexNativeProxyPath = path.join(ROOT, 'dist', 'AI-Remote-Windows', 'codex-native', 'codex-native-proxy.exe');
  if (!fs.existsSync(codexNativeProxyPath)) {
    throw new Error('Codex native proxy shim is missing; build the reviewed codex-native-proxy.exe before packaging.');
  }

  const files = [
    ...collectRuntimeFiles(),
    ...collectFiles(path.join(ROOT, 'ui'), 'ui/'),
    { name: 'src/workbuddy-native/windows-uia.ps1', data: fs.readFileSync(path.join(ROOT, 'src', 'workbuddy-native', 'windows-uia.ps1')) },
    { name: 'src/workbuddy-native/windows-uia-com.cs', data: fs.readFileSync(path.join(ROOT, 'src', 'workbuddy-native', 'windows-uia-com.cs')) },
    { name: 'src/workbuddy-native/windows-uia-pending.cs', data: fs.readFileSync(path.join(ROOT, 'src', 'workbuddy-native', 'windows-uia-pending.cs')) },
    { name: 'src/workbuddy-native/model-popup.cs', data: fs.readFileSync(path.join(ROOT, 'src', 'workbuddy-native', 'model-popup.cs')) },
    { name: 'src/workbuddy-native/pending-actions.cs', data: fs.readFileSync(path.join(ROOT, 'src', 'workbuddy-native', 'pending-actions.cs')) },
    { name: 'src/workbuddy-native/native-input.cs', data: fs.readFileSync(path.join(ROOT, 'src', 'workbuddy-native', 'native-input.cs')) },
    { name: 'plugins/workbuddy-native/README.md', data: fs.readFileSync(path.join(ROOT, 'plugins', 'workbuddy-native', 'README.md')) },
    { name: 'plugins/workbuddy-native/Start-WorkBuddy.ps1', data: fs.readFileSync(path.join(ROOT, 'plugins', 'workbuddy-native', 'Start-WorkBuddy.ps1')) },
    { name: 'plugins/workbuddy-native/Start-WorkBuddy-UIA.cmd', data: fs.readFileSync(path.join(ROOT, 'plugins', 'workbuddy-native', 'Start-WorkBuddy-UIA.cmd')) },
    { name: 'plugins/workbuddy-native/Start-WorkBuddy-Standard.cmd', data: fs.readFileSync(path.join(ROOT, 'plugins', 'workbuddy-native', 'Start-WorkBuddy-Standard.cmd')) },
    { name: 'scripts/codex-fullcontrol-ready.js', data: fs.readFileSync(path.join(ROOT, 'scripts', 'codex-fullcontrol-ready.js')) },
    { name: 'package.json', data: fs.readFileSync(path.join(ROOT, 'package.json')) },
    { name: LAUNCHER_NAME, data: Buffer.from(LAUNCHER, 'utf8') },
    { name: README_NAME, data: Buffer.from(README, 'utf8') },
    { name: FULL_CONTROL_LAUNCHER_NAME, data: fs.readFileSync(path.join(ROOT, 'scripts', FULL_CONTROL_LAUNCHER_NAME)) },
    { name: FULL_CONTROL_SCRIPT_NAME, data: fs.readFileSync(path.join(ROOT, 'scripts', FULL_CONTROL_SCRIPT_NAME)) },
    { name: 'codex-native/codex-native-proxy.exe', data: fs.readFileSync(codexNativeProxyPath) },
    { name: 'node.exe', data: fs.readFileSync(nodePath) },
  ];

  const forbiddenFiles = files.filter((file) => FORBIDDEN_PACKAGE_ENTRY.test(file.name));
  if (forbiddenFiles.length > 0) {
    throw new Error(`private or test files cannot be packaged: ${forbiddenFiles.map((file) => file.name).join(', ')}`);
  }

  const entries = files.map((file) => ({
    name: file.name,
    data: file.data,
    store: file.name === 'node.exe' && args.storeNode,
  }));

  const result = writeZip({ path: out, entries });
  const nodeBytes = files.find((file) => file.name === 'node.exe').data.length;
  process.stdout.write(`node runtime : ${nodePath} (${nodeBytes} bytes)\n`);
  process.stdout.write(`entries      : ${result.entries}\n`);
  for (const entry of entries) {
    process.stdout.write(`  ${entry.name} (${entry.data.length} bytes)\n`);
  }
  process.stdout.write(`archive      : ${result.path}\n`);
  process.stdout.write(`bytes        : ${result.bytes}\n`);
  process.stdout.write(`sha256       : ${crypto.createHash('sha256').update(fs.readFileSync(result.path)).digest('hex')}\n`);
  return result;
}

try {
  main();
} catch (error) {
  process.stderr.write(`pack failed: ${error.message}\n`);
  process.exit(1);
}

export { main, writeZip, collectFiles, collectRuntimeFiles, SOURCE_RUNTIME_FILES, findNode, LAUNCHER, README };
