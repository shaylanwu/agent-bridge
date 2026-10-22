#!/usr/bin/env node
/**
 * agent-bridge 入口
 *
 *   agent-bridge connect <platformUrl> [--token=xxx] [--label=name] [--no-browser]
 *   agent-bridge status [--json] [--fresh]
 *   agent-bridge logout
 *   agent-bridge daemon start|stop|install|uninstall
 *   agent-bridge --version
 */

import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { clearConfig, configPath, loadConfig, saveConfig, tokenTail } from './config.js';
import { authorizeWithBrowser, authorizeWithDeviceCode, AuthError } from './auth.js';
import { createBridgeClient, resolveDeviceId } from './bridge-client.js';
import { assertServerMessage, ProtocolError, type AgentListItem } from './protocol.js';
import { scanAgents } from './scan.js';
import { startTask, type TaskHandle } from './runner.js';

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const C = {
  dim: (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s),
  green: (s: string) => (process.stdout.isTTY ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (process.stdout.isTTY ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s: string) => (process.stdout.isTTY ? `\x1b[31m${s}\x1b[0m` : s),
  bold: (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s),
};

interface Flags {
  _: string[];
  [k: string]: string | boolean | string[];
}

function parseFlags(argv: string[]): Flags {
  const out: Flags = { _: [] };
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
      else out[a.slice(2)] = true;
    } else {
      (out._ as string[]).push(a);
    }
  }
  return out;
}

const STATUS_LABEL: Record<AgentListItem['status'], string> = {
  ready: '就绪',
  installed_no_cred: '缺凭据',
  not_installed: '未装',
};

function printAgents(items: AgentListItem[]): void {
  const rows = items.map((a) => {
    const name = a.display.padEnd(18);
    const ver = (a.version ?? (a.path?.startsWith('npx ') ? 'npx 免安装' : '-')).padEnd(20);
    // 找到二进制但执行失败时，「就绪」是假象，直接标「装坏」
    const label = a.installedButBroken ? '装坏' : STATUS_LABEL[a.status];
    const painted = a.installedButBroken
      ? C.red(label)
      : a.status === 'ready'
        ? C.green(label)
        : a.status === 'installed_no_cred'
          ? C.yellow(label)
          : C.dim(label);
    return `${name} ${ver} ${painted}`;
  });
  console.log(C.bold('\n工具                 版本                 状态'));
  console.log(C.dim('─'.repeat(58)));
  for (const r of rows) console.log(r);
  const ready = items.filter((a) => a.status === 'ready' && !a.installedButBroken).length;
  console.log(C.dim(`\n共 ${items.length} 个工具，可用 ${ready} 个\n`));
}

async function cmdStatus(flags: Flags): Promise<void> {
  const items = await scanAgents({ fresh: flags['fresh'] === true });
  if (flags['json'] === true) {
    console.log(JSON.stringify({ agents: items, scannedAt: new Date().toISOString() }, null, 2));
    return;
  }
  printAgents(items);
}

async function cmdConnect(flags: Flags): Promise<void> {
  const platformUrl = String((flags._ as string[])[1] ?? '');
  if (!platformUrl) {
    console.error('用法：agent-bridge connect <platformUrl> [--token=xxx] [--no-browser]');
    process.exit(2);
  }
  const saved = loadConfig();
  let deviceToken = typeof flags['token'] === 'string' ? flags['token'] : undefined;
  // 只在授权/复用配置时被赋值；--token 模式下由下面的 resolveDeviceId 解析
  let deviceId = '';
  let boundUrl = saved?.platformUrl ?? '';

  if (!deviceToken) {
    if (saved?.platformUrl === platformUrl.replace(/\/+$/, '') && saved.deviceToken) {
      deviceToken = saved.deviceToken;
      deviceId = saved.deviceId;
      boundUrl = saved.platformUrl;
      console.log(C.dim(`复用已保存的设备凭证（${deviceId}，token ${tokenTail(deviceToken)}）`));
    } else {
      console.log('[agent-bridge] 开始设备授权…');
      const useBrowser = flags['no-browser'] !== true;
      try {
        const res = useBrowser
          ? await authorizeWithBrowser(platformUrl, {
              onPrompt: (url) =>
                console.log(`[agent-bridge] 已打开浏览器，若无反应请手动访问：\n  ${url}`),
            })
          : await authorizeWithDeviceCode(platformUrl, {
              onPrompt: (uri, code) =>
                console.log(`[agent-bridge] 请在浏览器打开 ${uri} 并输入验证码：${C.bold(code)}`),
            });
        deviceToken = res.deviceToken;
        deviceId = res.deviceId;
        boundUrl = res.platformUrl;
        saveConfig({
          platformUrl: res.platformUrl,
          deviceId: res.deviceId,
          deviceToken: res.deviceToken,
          refreshToken: res.refreshToken,
          label: typeof flags['label'] === 'string' ? flags['label'] : hostname(),
          boundAt: new Date().toISOString(),
        });
        console.log(C.green(`✅ 设备绑定成功（${deviceId}），配置已写入 ${configPath()}`));
      } catch (e) {
        if (e instanceof AuthError) {
          console.error(C.red(`❌ 授权失败：${e.message}`));
          process.exit(1);
        }
        throw e;
      }
    }
  }

  // deviceId 解析优先级：授权响应 > --device-id > AGENT_BRIDGE_DEVICE_ID > 已保存配置（同平台）
  const targetUrl = (boundUrl || platformUrl).replace(/\/+$/, '');
  const savedId = saved && saved.platformUrl === targetUrl ? saved.deviceId : '';
  deviceId = resolveDeviceId({
    fromAuth: deviceId,
    flag: typeof flags['device-id'] === 'string' ? String(flags['device-id']) : '',
    env: process.env['AGENT_BRIDGE_DEVICE_ID'] ?? '',
    saved: savedId,
  });
  if (!deviceId) {
    console.log(
      C.yellow(
        '[agent-bridge] 未提供 deviceId（--device-id / AGENT_BRIDGE_DEVICE_ID）：' +
          '连接将不带 deviceId 参数，平台需按 Bearer token 反查设备',
      ),
    );
  }

  // 上报初值 + 长连接
  if (saved?.allowedCwd?.length) {
    console.log(
      C.dim(`[agent-bridge] 目录白名单已启用（${saved.allowedCwd.length} 个条目），越界任务将被拒绝`),
    );
  }
  const tasks = new Map<string, TaskHandle>();
  const client = createBridgeClient({
    platformUrl: boundUrl || platformUrl,
    deviceToken,
    deviceId,
    cliVersion: version(),
    hostname: hostname(),
    log: (l) => console.log(C.dim(l)),
    onOpen: async () => {
      const items = await scanAgents({ fresh: true });
      client.send({ type: 'agent_list', agents: items, scannedAt: new Date().toISOString() });
      console.log(C.green(`[agent-bridge] 已上报 ${items.length} 个工具状态，等待平台任务…`));
    },
    onMessage: (raw) => {
      let msg;
      try {
        msg = assertServerMessage(raw);
      } catch (e) {
        if (e instanceof ProtocolError) {
          console.error(C.red(`[agent-bridge] 指令非法：${e.message}`));
          return;
        }
        throw e;
      }
      if (msg.type === 'ping') {
        client.send({ type: 'pong', at: Date.now() });
        return;
      }
      if (msg.type === 'scan') {
        void scanAgents({ fresh: true }).then((agents) =>
          client.send({
            type: 'scan_result',
            requestId: msg.requestId,
            agents,
            scannedAt: new Date().toISOString(),
          }),
        );
        return;
      }
      if (msg.type === 'cancel_task') {
        tasks.get(msg.taskId)?.cancel();
        return;
      }
      // run_task
      console.log(C.bold(`\n▶ 执行任务 ${msg.taskId}：${msg.agentType}`));
      const handle = startTask(
        {
          taskId: msg.taskId,
          agentType: msg.agentType,
          cwd: msg.cwd,
          args: msg.args,
          prompt: msg.prompt,
          env: msg.env,
          timeoutMs: msg.timeoutMs,
          allowedCwd: saved?.allowedCwd,
        },
        {
          onLog: (stream, data) => {
            const text = data.replace(/\x1b\[[0-9;]*m/g, '');
            if (text.trim()) console.log(C.dim(`[${stream}] ${text.trimEnd()}`));
            client.send({ type: 'task_log', taskId: msg.taskId, stream, data, isAnsi: true });
          },
          onStatus: (status, info) =>
            client.send({
              type: 'task_status',
              taskId: msg.taskId,
              status,
              exitCode: info?.exitCode,
              error: info?.error,
            }),
        },
      );
      tasks.set(msg.taskId, handle);
      void handle.done.then(() => tasks.delete(msg.taskId));
    },
  });

  const bye = (): void => {
    client.close();
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  // 保活：不退出
  await new Promise<void>(() => undefined);
}

function cmdLogout(): void {
  const cfg = loadConfig();
  if (!cfg) {
    console.log('[agent-bridge] 未绑定任何平台');
    return;
  }
  clearConfig();
  console.log(C.green(`✅ 已清除本地设备凭证（${cfg.deviceId}）`));
  console.log(C.dim('提示：如需让平台侧同步下线，请到「设备管理」里吊销该设备。'));
}

function cmdDaemon(args: string[]): void {
  const sub = args[0] ?? 'status';
  console.log(
    C.yellow(`[agent-bridge] daemon ${sub} 尚未实现（Phase 3：systemd/launchd/Windows 服务）`),
  );
  console.log(C.dim('当前请用前台模式：agent-bridge connect <platformUrl>'));
}

function help(): void {
  console.log(`
${C.bold('agent-bridge')} ${version()} —— 把本机 AI 编码 CLI 接入你的编排平台

用法：
  agent-bridge connect <platformUrl> [--token=xxx] [--device-id=bd_xxx] [--no-browser] [--label=name]
      绑定本机设备并保持长连接（浏览器授权；SSH 场景加 --no-browser 走设备码）
      --token 模式建议同时给 --device-id（或设 AGENT_BRIDGE_DEVICE_ID），否则平台需按 token 反查设备
  agent-bridge status [--json] [--fresh]
      扫描并打印本机 11 个 AI 编码 CLI 的安装/凭据状态
  agent-bridge logout
      清除本地设备凭证
  agent-bridge daemon start|stop|install|uninstall
      后台常驻（Phase 3）
  agent-bridge --version | help

配置文件：${configPath()}${existsSync(configPath()) ? '' : C.dim('（尚未创建）')}
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const flags = parseFlags(argv);

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return help();
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    console.log(version());
    return;
  }
  if (cmd === 'status') return cmdStatus(flags);
  if (cmd === 'connect') return cmdConnect(flags);
  if (cmd === 'logout') return cmdLogout();
  if (cmd === 'daemon') return cmdDaemon((flags._ as string[]).slice(1));

  console.error(C.red(`未知命令：${cmd}`));
  help();
  process.exit(2);
}

void main().catch((e: unknown) => {
  console.error(C.red(`❌ ${(e as Error).message}`));
  process.exit(1);
});
