/**
 * `agent-bridge daemon` —— 轻量后台进程管理（不依赖 systemd/launchd）。
 *
 * start/stop/status 是真实实现：detached 子进程 + PID 文件 + 日志文件。
 * install/uninstall（注册系统服务）仍明确提示未实现，避免冒充平台服务管理器。
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { boolFlag, posFlag, strFlag, type Flags } from '../cli/flags.js';
import { out } from '../cli/render.js';
import { stateDir } from '../infra/config.js';

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

export function cmdDaemon(flags: Flags): void {
  const sub = posFlag(flags, 1) || 'status';
  if (sub === 'start') return start(flags);
  if (sub === 'stop') return stop();
  if (sub === 'status') return status();
  if (sub === 'install' || sub === 'uninstall') {
    out.warn(`[agent-bridge] daemon ${sub} 尚未实现（系统服务注册：systemd/launchd/Windows Service）`);
    out.info('可先用 daemon start/stop 管理后台进程。');
    return;
  }
  out.warn(`[agent-bridge] 未知 daemon 子命令：${sub}`);
  out.info('用法：agent-bridge daemon start <platformUrl> | stop | status');
  process.exitCode = 2;
}
