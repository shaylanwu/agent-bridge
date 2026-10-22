---
name: windows-compat-rules
description: Windows 兼容约束：.cmd/.bat 垫片、路径含空格、where 多行输出、无扩展名 shim、大小写不敏感路径。
priority: P2
applies_to: ['src/**', 'test/**']
enforced_by:
  - scripts/protocol-boundary-check.mjs
  - hooks/post-change-gate.sh
version: 1.0.0
---

# windows-compat-rules.md — Windows 兼容约束

主要开发者与主要故障都在这条线上。以下每一条都对应一个真实踩过的坑，改动前先读。

## 1. 垫片必须整体加引号

- Windows 上 `claude` / `codex` / `qoder` 等是 `.cmd` 垫片，Node 直接 `spawn` 会 `ENOENT` 或参数被 cmd 拆断。
- 唯一正确姿势：`isWinShim()` 判定 → `buildWinCommandLine(bin, argv)` 拼完整命令行 → `shell: true`。
- ⛔ 禁止在 `win-exec.ts` 之外手写引号拼接逻辑；⛔ 禁止用 `spawnSync` 的 `shell: true` 直接传数组（`cmd /c a b c` 的引号规则不同）。
- 引号规则：每个 token 整体双引号包裹，token 内 `"` 翻倍。路径含空格（`C:\Program Files\...`）必须不失真。

## 2. PATH 解析

- `where <name>` 可能返回多行（`grok.cmd` / `grok.exe` / 无扩展名 `grok`）。**无扩展名的那个通常是 bash 风格 shim，Node 起不来** → 必须按 `WIN_EXEC_RE = /\.(exe|cmd|bat)$/i` 过滤。
- 找到可执行文件但 `--version` 失败 → 报 `installedButBroken`，⛔ 不得报 `ready`（「装了但坏了」和「装好了」对用户是两件事）。
- 版本号只从 **stdout** 提取。⛔ 禁止从 stderr 提取：失败时 stderr 常混着 `Node.js v24.x`，会被误显示成工具版本。
- 扫描目录必须去重且大小写不敏感（`toLowerCase()` 后再 `Set`）——Windows 路径大小写不敏感，同一目录会被塞两次。

## 3. 事件循环与阻塞

- 探测使用 `execFileSync`（同步）。单次扫描实测约 12s，期间事件循环被占满 → WS 心跳与入站指令都会延迟。
- ⛔ 禁止在 `onOpen` 之外新增同步全量扫描；新增扫描入口必须走 `scanAgents()` 缓存（30s TTL）。
- 若要把探测改为异步：必须同时保证 `scan_result` 的 `requestId` 能正确配对，且不改协议字段。

## 4. 路径与换行

- 仓库强制 LF（`.gitattributes`），⛔ 禁止提交 CRLF；shell 脚本必须能在 Git Bash 下执行。
- 路径拼接只用 `node:path` 的 `join` / `resolve`；⛔ 禁止手写 `+ '/' +`。
- 目录比较用 `resolve()` 后前缀比较（`isUnder`），⛔ 禁止字符串 `startsWith` 直接比较未规范化的路径。

## 5. 测试要求

- 涉及引号/路径的逻辑必须能在非 Windows 上跑单测：把「拼命令行」做成纯函数（`buildWinCommandLine`），不要依赖真实平台。
- 现有用例：`test/bridge.test.ts` 的「Windows 垫片命令行拼装」两条 —— 改动 `win-exec.ts` 必须保持它们通过。
