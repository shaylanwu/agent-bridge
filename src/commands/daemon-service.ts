/**
 * daemon 系统服务定义（纯函数，便于测试与 --dry-run）。
 *
 * 范围（2026-10-26 决策）：
 *  - Linux: systemd --user（不要求 root）
 *  - macOS: LaunchAgent（当前用户）
 *  - Windows: 当前用户计划任务（ONLOGON；Windows Service 需要管理员，先不选）
 */

export interface ServiceCommand {
  nodePath: string;
  cliPath: string;
  platformUrl: string;
}

export const SERVICE_NAME = 'agent-bridge';

function quoted(value: string): string {
  return `"${value.replace(/(["\\])/g, '\\$1')}"`;
}

export function serviceArgs(cmd: ServiceCommand): string[] {
  return [cmd.nodePath, cmd.cliPath, 'connect', cmd.platformUrl];
}

export function renderSystemdUnit(cmd: ServiceCommand): string {
  return [
    '[Unit]',
    'Description=Agent Bridge Service',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${serviceArgs(cmd).map(quoted).join(' ')}`,
    'Restart=on-failure',
    'RestartSec=3',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderLaunchdPlist(cmd: ServiceCommand): string {
  const args = serviceArgs(cmd)
    .map((arg) => `    <string>${xml(arg)}</string>`)
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>com.${SERVICE_NAME}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    args,
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** schtasks /TR 需要的是“一条命令行字符串”，不是 argv 数组 */
export function windowsTaskCommand(cmd: ServiceCommand): string {
  return serviceArgs(cmd).map(quoted).join(' ');
}

export function schtasksCreateArgs(cmd: ServiceCommand): string[] {
  return [
    '/Create',
    '/TN',
    SERVICE_NAME,
    '/TR',
    windowsTaskCommand(cmd),
    '/SC',
    'ONLOGON',
    '/RL',
    'LIMITED',
    '/F',
  ];
}
