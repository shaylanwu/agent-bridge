/**
 * 帮助文本（CLI 支撑件）
 *
 * 命令清单与 `dispatch.ts` 的注册表必须一致 —— README 由 `doc:check` 机检，
 * 这里则是给人看的第一份说明，未实现的能力必须当场写清（daemon install/uninstall 仍是 stub）。
 */

import { existsSync } from 'node:fs';
import { configPath } from '../infra/config.js';
import { version } from './meta.js';
import { C } from './render.js';

export function help(): void {
  console.log(`
${C.bold('agent-bridge')} ${version()} —— 把本机 AI 编码 CLI 接入你的编排平台

用法：
  agent-bridge connect <platformUrl> [--token=xxx] [--device-id=bd_xxx] [--no-browser] [--label=name]
      [--max-tasks=30] [--max-queue=60]
      绑定本机设备并保持长连接（浏览器授权；SSH 场景加 --no-browser 走设备码）
      --token 模式必须提供可迁移/显式 ID（--device-id 或 AGENT_BRIDGE_DEVICE_ID）；缺 ID 拒绝连接且不随机生成
      凭证吊销或换账号：先 agent-bridge logout，再 agent-bridge connect <platformUrl>，设备 ID 保持不变
      --max-tasks/--max-queue 覆盖本次会话的并发/排队上限（优先于环境变量与 config.toml）
  agent-bridge status [--json] [--fresh]
      扫描并打印本机 12 个 AI 编码 CLI 的安装/凭据状态
  agent-bridge serve <platformUrl> [--port=8787] [--max-tasks=30] [--max-queue=60]
      与 connect 相同的主流程，额外开一个**本地回环控制面**（默认关闭；带 --port 本次启用）
      服务对象是本机其它程序（IDE 插件 / 脚本 / MCP server / CI），远程平台仍走出站 WebSocket
  agent-bridge logout
      清除本地设备凭证，保留设备身份、平台地址与业务设置
  agent-bridge services issue|list|revoke|rotate
      服务令牌（scoped service token）：给外部系统/后端服务签发可轮换的最小权限身份
      --label=<name> --scopes=task:create,task:cancel,task:read,device:read,task:approve,task:respond [--ttl-days=90]
      rotate 可带 --grace-hours=24（旧令牌宽限期，期间仍然有效）
  agent-bridge daemon start <platformUrl> | stop | status | install <platformUrl> | uninstall
      轻量后台进程管理（detached + PID + daemon.log）；install/uninstall 注册当前用户服务
      Linux systemd user / macOS LaunchAgent / Windows 计划任务；均支持 --dry-run
  agent-bridge --version | help

配置文件：${configPath()}${existsSync(configPath()) ? '' : C.dim('（尚未创建）')}
`);
}
