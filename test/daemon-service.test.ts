import { describe, expect, it } from 'vitest';
import {
  renderLaunchdPlist,
  renderSystemdUnit,
  schtasksCreateArgs,
  serviceArgs,
  windowsTaskCommand,
} from '../src/commands/daemon-service.js';

const cmd = {
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  cliPath: 'C:\\repo\\dist\\cli.js',
  platformUrl: 'http://127.0.0.1:5173',
};

describe('daemon 服务定义', () => {
  it('systemd 使用绝对路径与转义参数', () => {
    const unit = renderSystemdUnit(cmd);
    expect(unit).toContain('ExecStart="C:\\\\Program Files\\\\nodejs\\\\node.exe"');
    expect(unit).toContain('"C:\\\\repo\\\\dist\\\\cli.js" "connect" "http://127.0.0.1:5173"');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('launchd plist 转义 XML 且参数完整', () => {
    const plist = renderLaunchdPlist({ ...cmd, platformUrl: 'http://x/?a=1&b=2' });
    expect(plist).toContain('com.agent-bridge');
    expect(plist).toContain('http://x/?a=1&amp;b=2');
    expect(plist.match(/<string>/g)?.length).toBe(serviceArgs(cmd).length + 1);
  });

  it('Windows 计划任务参数是单条命令行', () => {
    const args = schtasksCreateArgs(cmd);
    expect(args).toContain('/SC');
    expect(args).toContain('ONLOGON');
    expect(windowsTaskCommand(cmd)).toContain('"C:\\\\Program Files\\\\nodejs\\\\node.exe"');
  });
});
