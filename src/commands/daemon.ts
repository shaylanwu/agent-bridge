/**
 * `agent-bridge daemon` —— 轻量后台进程管理（不依赖 systemd/launchd）。
 *
 * start/stop/status 是真实实现：detached 子进程 + PID 文件 + 日志文件。
 * install/uninstall（注册系统服务）仍明确提示未实现，避免冒充平台服务管理器。
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { boolFlag, posFlag, strFlag, type Flags } from '../cli/flags.js';
import { out } from '../cli/render.js';
import { stateDir } from '../infra/config.js';
import {
  renderLaunchdPlist,
  renderSystemdUnit,
  schtasksCreateArgs,
  SERVICE_NAME,
  type ServiceCommand,
} from './daemon-service.js';

function pidPath(): string {
  return join(stateDir(), 'daemon.pid');
}

function logPath(): string {
  return join(stateDir(), 'daemon.log');
}

export function readDaemonPid(path = pidPath()): number | undefined {
  try {
    const raw = readFileSync(path, 'utf8').trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function forwardFlags(flags: Flags): string[] {
  const keys = ['token', 'label', 'max-tasks', 'max-queue', 'diff-max-bytes', 'allowed-cwd'];
  const args: string[] = [];
  for (const key of keys) {
    const value = strFlag(flags, key);
    if (value !== undefined) args.push(`--${key}=${value}`);
  }
  if (boolFlag(flags, 'no-browser')) args.push('--no-browser');
  return args;
}

function start(flags: Flags): void {
  const existing = readDaemonPid();
  if (existing && isPidAlive(existing)) {
    out.warn(`[agent-bridge] daemon 已在运行（pid ${existing}）`);
    return;
  }
  if (existsSync(pidPath())) rmSync(pidPath(), { force: true });

  const platformUrl = posFlag(flags, 2);
  if (!platformUrl) {
    out.error('[agent-bridge] daemon start 需要 platformUrl（或先在配置中写入 platformUrl）');
    process.exitCode = 2;
    return;
  }
  mkdirSync(stateDir(), { recursive: true });
  const logFd = openSync(logPath(), 'a');
  const argv = [process.argv[1] ?? '', 'connect', platformUrl, ...forwardFlags(flags)];
  const child = spawn(process.execPath, argv, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    env: process.env,
  });
  closeSync(logFd);
  child.unref();
  if (!child.pid) {
    out.error('[agent-bridge] daemon 启动失败：没有拿到 pid');
    process.exitCode = 1;
    return;
  }
  writeFileSync(pidPath(), `${child.pid}\n`, 'utf8');
  out.ok(`[agent-bridge] daemon 已启动（pid ${child.pid}）`);
  out.info(`日志：${logPath()}`);
}

function stop(): void {
  const pid = readDaemonPid();
  if (!pid) {
    out.warn('[agent-bridge] daemon 未运行（没有 pid 文件）');
    return;
  }
  if (!isPidAlive(pid)) {
    rmSync(pidPath(), { force: true });
    out.warn(`[agent-bridge] daemon 已不在运行（陈旧 pid ${pid}，已清理）`);
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
    out.ok(`[agent-bridge] 已发送停止信号（pid ${pid}）`);
  } catch (error) {
    out.error(`[agent-bridge] 停止失败：${(error as Error).message}`);
    process.exitCode = 1;
    return;
  }
  rmSync(pidPath(), { force: true });
}

function status(): void {
  const pid = readDaemonPid();
  if (!pid) {
    out.info('[agent-bridge] daemon 未运行');
    return;
  }
  if (isPidAlive(pid)) {
    out.ok(`[agent-bridge] daemon 运行中（pid ${pid}）`);
    out.info(`日志：${logPath()}`);
  } else {
    out.warn(`[agent-bridge] pid ${pid} 已失效（陈旧 pid 文件）`);
    process.exitCode = 1;
  }
}

function serviceCommand(flags: Flags): ServiceCommand | undefined {
  const platformUrl = posFlag(flags, 2);
  if (!platformUrl) {
    out.error(`[agent-bridge] daemon ${posFlag(flags, 1)} 需要 platformUrl`);
    process.exitCode = 2;
    return undefined;
  }
  const cliPath = process.argv[1];
  if (!cliPath) {
    out.error('[agent-bridge] 无法确定 CLI 路径（process.argv[1] 为空）');
    process.exitCode = 1;
    return undefined;
  }
  return { nodePath: process.execPath, cliPath, platformUrl };
}

function systemdPath(): string {
  return join(homedir(), '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);
}

function launchdPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `com.${SERVICE_NAME}.plist`);
}

function install(flags: Flags): void {
  const cmd = serviceCommand(flags);
  if (!cmd) return;
  const dryRun = boolFlag(flags, 'dry-run');

  if (process.platform === 'win32') {
    const args = schtasksCreateArgs(cmd);
    if (dryRun) {
      out.info(`schtasks ${args.join(' ')}`);
      return;
    }
    try {
      execFileSync('schtasks', args, { stdio: 'inherit' });
      out.ok(`[agent-bridge] 已注册当前用户登录任务：${SERVICE_NAME}`);
      out.info('卸载：agent-bridge daemon uninstall');
    } catch (error) {
      out.error(`[agent-bridge] 计划任务注册失败：${(error as Error).message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (process.platform === 'darwin') {
    const content = renderLaunchdPlist(cmd);
    const target = launchdPath();
    if (dryRun) {
      out.info(`# ${target}\n${content}`);
      return;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
    try {
      execFileSync('launchctl', ['load', '-w', target], { stdio: 'inherit' });
      out.ok(`[agent-bridge] 已注册 LaunchAgent：${target}`);
    } catch (error) {
      out.error(`[agent-bridge] LaunchAgent 注册失败：${(error as Error).message}`);
      process.exitCode = 1;
    }
    return;
  }

  const content = renderSystemdUnit(cmd);
  const target = systemdPath();
  if (dryRun) {
    out.info(`# ${target}\n${content}`);
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
  try {
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
    execFileSync('systemctl', ['--user', 'enable', '--now', `${SERVICE_NAME}.service`], {
      stdio: 'inherit',
    });
    out.ok(`[agent-bridge] 已注册 systemd user 服务：${target}`);
  } catch (error) {
    out.error(`[agent-bridge] systemd 服务注册失败：${(error as Error).message}`);
    process.exitCode = 1;
  }
}

function uninstall(flags: Flags): void {
  const dryRun = boolFlag(flags, 'dry-run');
  if (process.platform === 'win32') {
    const args = ['/Delete', '/TN', SERVICE_NAME, '/F'];
    if (dryRun) {
      out.info(`schtasks ${args.join(' ')}`);
      return;
    }
    try {
      execFileSync('schtasks', args, { stdio: 'inherit' });
      out.ok(`[agent-bridge] 已删除计划任务：${SERVICE_NAME}`);
    } catch (error) {
      out.error(`[agent-bridge] 计划任务删除失败：${(error as Error).message}`);
      process.exitCode = 1;
    }
    return;
  }
  if (process.platform === 'darwin') {
    const target = launchdPath();
    if (dryRun) {
      out.info(`launchctl unload -w ${target}\nrm ${target}`);
      return;
    }
    try {
      execFileSync('launchctl', ['unload', '-w', target], { stdio: 'inherit' });
    } catch {
      /* 未加载时继续删文件 */
    }
    rmSync(target, { force: true });
    out.ok(`[agent-bridge] 已移除 LaunchAgent：${target}`);
    return;
  }
  const target = systemdPath();
  if (dryRun) {
    out.info(`systemctl --user disable --now ${SERVICE_NAME}.service\nrm ${target}`);
    return;
  }
  try {
    execFileSync('systemctl', ['--user', 'disable', '--now', `${SERVICE_NAME}.service`], {
      stdio: 'inherit',
    });
  } catch {
    /* 未启用时继续删文件 */
  }
  rmSync(target, { force: true });
  try {
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
  } catch {
    /* daemon-reload 失败不阻塞卸载 */
  }
  out.ok(`[agent-bridge] 已移除 systemd user 服务：${target}`);
}

export function cmdDaemon(flags: Flags): void {
  const sub = posFlag(flags, 1) || 'status';
  if (sub === 'start') return start(flags);
  if (sub === 'stop') return stop();
  if (sub === 'status') return status();
  if (sub === 'install') return install(flags);
  if (sub === 'uninstall') return uninstall(flags);
  out.warn(`[agent-bridge] 未知 daemon 子命令：${sub}`);
  out.info('用法：agent-bridge daemon start <platformUrl> | stop | status | install <platformUrl> | uninstall');
  process.exitCode = 2;
}
