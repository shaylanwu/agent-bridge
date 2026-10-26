import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskRegistry } from '../src/app/task-registry';
import { startPanel } from '../src/cli/panel';

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const originalTty = process.stdout.isTTY;
const originalColumns = process.stdout.columns;

function columnOf(line: string, text: string): number {
  const at = line.indexOf(text);
  expect(at).toBeGreaterThanOrEqual(0);
  let width = 0;
  for (const ch of line.slice(0, at)) width += '●◷✓✗○'.includes(ch) ? 1 : ch.charCodeAt(0) > 0xff ? 2 : 1;
  return width;
}

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process.stdout, 'isTTY', { value: originalTty, configurable: true });
  Object.defineProperty(process.stdout, 'columns', { value: originalColumns, configurable: true });
});

describe('终端任务面板', () => {
  it('控制面未启用时仍显示面板行并给出开启方式', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const registry = new TaskRegistry();

    const panel = startPanel({
      registry,
      capacity: () => ({ running: 0, queued: 0, maxTasks: 30, maxQueued: 30 }),
      platformUrl: 'http://localhost:5173',
      deviceName: 'dev-machine',
    });
    panel?.stop();

    const raw = write.mock.calls.map((call) => String(call[0])).join('');
    expect(raw.replace(ANSI, '')).toContain('│ 面板  未启用 · serve --port=8787 开启');
  });

  it('按主题绿与状态色渲染，地址无下划线且信息/列表行保留间距', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const registry = new TaskRegistry();
    registry.register('bt_123456789', { agentType: 'codex', cwd: '/repo', source: 'platform' });
    registry.register('bt_987654321', { agentType: 'gemini', cwd: '/repo', source: 'platform' });
    const webUrl = 'http://127.0.0.1:8787/?token=abs_ui_test';

    const panel = startPanel({
      registry,
      capacity: () => ({ running: 0, queued: 2, maxTasks: 30, maxQueued: 30 }),
      platformUrl: 'http://localhost:5173',
      deviceName: 'dev-machine',
      webUrl,
    });
    panel?.stop();

    const raw = write.mock.calls.map((call) => String(call[0])).join('');
    const lines = raw.replace(ANSI, '').split('\n');
    lines.pop();

    expect(raw).toContain('\x1b[34mhttp://localhost:5173\x1b[0m');
    expect(raw).toContain(`\x1b[34m${webUrl}\x1b[0m`);
    expect(raw).toContain('\x1b[38;2;23;166;127m╭');
    expect(raw).toContain('\x1b[1m\x1b[38;2;23;166;127m状态');
    expect(raw).toContain('\x1b[34m运行 0\x1b[0m');
    expect(raw).toContain('\x1b[33m排队 2\x1b[0m');
    expect(raw).toContain('\x1b[32m成功 0\x1b[0m');
    expect(raw).toContain('\x1b[31m失败 0\x1b[0m');
    expect(raw).not.toContain('\x1b[4m');
    expect(raw).not.toContain('48;2;24;24;27');
    expect(raw).not.toContain('点开即用');
    expect(raw).not.toContain('令牌');
    expect(lines).toHaveLength(20);
    expect(lines[0]).toMatch(/^╭─+╮$/);
    expect(lines[1]).toMatch(/^│ +│$/);
    expect(lines[2]).toContain('│ 平台  http://localhost:5173 · 设备 dev-machine');
    expect(lines[2]).not.toContain('bd_test');
    expect(lines[3]).toMatch(/^│ +│$/);
    expect(lines[4]).toContain('│ 容量  运行 0/30 · 排队 2 · 会话 成功 0 · 失败 0');
    expect(lines[5]).toMatch(/^│ +│$/);
    expect(lines[6]).toContain(`│ 面板  ${webUrl}`);
    expect(lines[7]).toMatch(/^│ +│$/);
    expect(lines[8]).toMatch(/^╰─+╯$/);
    expect(lines[10]).toContain('状态');
    expect(lines[11]).toMatch(/^─+$/);
    expect(lines[12]).toBe('');
    expect(lines[13]).toContain('排队中');
    expect(lines[14]).toBe('');
    expect(lines[15]).toContain('排队中');
    expect(lines[16]).toBe('');
    expect(lines[17]).toMatch(/^─+$/);
    expect(lines[18]).toBe('');
    expect(lines[19]).toContain('运行 0 · 排队 2 · 成功 0 · 失败 0');
    for (const row of [lines[13]!, lines[15]!]) {
      expect(columnOf(row, row.includes('bt_1234') ? 'bt_1234…' : 'bt_9876…')).toBe(columnOf(lines[10]!, '任务'));
      expect(columnOf(row, row.includes('codex') ? 'codex' : 'gemini')).toBe(columnOf(lines[10]!, '工具'));
      expect(columnOf(row, '第 - 位')).toBe(columnOf(lines[10]!, '当前步骤'));
    }
  });
});
