import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskRegistry } from '../src/app/task-registry';
import { startPanel } from '../src/cli/panel';

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
/** 终端里按单宽显示的符号：状态圆点 + 边框线 */
const SINGLE_WIDTH = '●◷✓✗○…│─╭╮╰╯┌┬┐├┼┤└┴┘';
const originalTty = process.stdout.isTTY;
const originalColumns = process.stdout.columns;

/** 按显示列宽计（CJK=2、状态符号/边框=1） */
function widthOf(line: string): number {
  let width = 0;
  for (const ch of line) width += SINGLE_WIDTH.includes(ch) ? 1 : ch.charCodeAt(0) > 0xff ? 2 : 1;
  return width;
}

function columnOf(line: string, text: string): number {
  const at = line.indexOf(text);
  expect(at).toBeGreaterThanOrEqual(0);
  return widthOf(line.slice(0, at));
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
    registry.register('bt_987654321', { agentType: 'agy', cwd: '/repo', source: 'platform' });
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
    expect(lines).toHaveLength(17);
    expect(lines[0]).toMatch(/^╭─+╮$/);
    expect(lines[1]).toMatch(/^│ +│$/);
    expect(lines[2]).toContain('│ 平台  http://localhost:5173 · 设备 dev-machine');
    expect(lines[2]).not.toContain('bd_test');
    expect(lines[3]).toMatch(/^│ +│$/);
    // 容量行：不带「会话」字段，成功/失败数值与其它状态数值同为素色
    expect(lines[4]).toContain('│ 容量  运行 0/30 · 排队 2 · 成功 0 · 失败 0');
    expect(lines[4]).not.toContain('会话');
    expect(lines[5]).toMatch(/^│ +│$/);
    expect(lines[6]).toContain(`│ 面板  ${webUrl}`);
    expect(lines[7]).toMatch(/^│ +│$/);
    expect(lines[8]).toMatch(/^╰─+╯$/);
    // 表格：圆角外框 + 表头列竖线 + 表头/行间分隔线；与引导区之间无空行
    expect(lines[9]).toMatch(/^╭─+(┬─+)+╮$/);
    expect(lines[10]).toContain('状态');
    expect(lines[10]).toMatch(/^│.*│$/);
    expect(lines[11]).toMatch(/^├─+┤$/);
    expect(lines[12]).toContain('排队中');
    expect(lines[13]).toMatch(/^├─+┤$/); // 行间下边线
    expect(lines[14]).toContain('排队中');
    expect(lines[15]).toMatch(/^╰─+╯$/);
    // 与表格下边框之间也无空行，状态栏紧跟其后
    expect(lines[16]).toContain('运行 0 · 排队 2 · 成功 0 · 失败 0');
    // 数据行剔除列竖线（只剩左右外框），表头保留；表体横线一律不带列刻度
    for (const row of [lines[12]!, lines[14]!]) {
      expect(row.match(/│/g)).toHaveLength(2);
    }
    const frame = lines.join('\n');
    expect(frame).not.toContain('┼');
    expect(frame).not.toContain('┴');
    // 表头与行内容共用同一套列位置
    for (const row of [lines[12]!, lines[14]!]) {
      expect(columnOf(row, row.includes('bt_1234') ? 'bt_1234' : 'bt_9876')).toBe(columnOf(lines[10]!, '任务'));
      expect(columnOf(row, row.includes('codex') ? 'codex' : 'agy')).toBe(columnOf(lines[10]!, '工具'));
      expect(columnOf(row, '第 - 位')).toBe(columnOf(lines[10]!, '当前步骤'));
    }
    // 每个列分隔符与表头分隔线的 ┬ 同列（列边界对齐）
    const barsOf = (line: string): number[] => [...line].map((ch, i) => (ch === '│' ? widthOf(line.slice(0, i)) : -1)).filter((n) => n >= 0);
    const headsOf = (line: string): number[] => [...line].map((ch, i) => ('┬┼┴'.includes(ch) ? widthOf(line.slice(0, i)) : -1)).filter((n) => n >= 0);
    expect(barsOf(lines[10]!).slice(1, -1)).toEqual(headsOf(lines[9]!));

    // 表格/状态栏与引导区线框两端绝对对齐：都从第 0 列起、到第 W-1 列止
    const boxWidth = widthOf(lines[8]!); // ╰─…─╯
    expect(columnOf(lines[9]!, '╭')).toBe(0);
    expect(columnOf(lines[9]!, '╮')).toBe(boxWidth - 1);
    expect(columnOf(lines[10]!, '状态')).toBe(2); // '│ ' —— 与 `│ 平台` 同列
    for (const line of lines.slice(9, 17)) {
      expect(widthOf(line)).toBe(boxWidth);
    }
  });

  it('空态提示在整行内水平居中', () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true });
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
    const line = raw.replace(ANSI, '').split('\n').find((l) => l.includes('暂无任务'));
    expect(line).toBeDefined();
    const inner = line!.replace(/^│/, '').replace(/│$/, '');
    const left = inner.length - inner.trimStart().length;
    const right = inner.length - inner.trimEnd().length;
    expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
  });

  it('终端宽度变化时另起一帧，不用 CUU 覆盖旧帧', () => {
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
    const before = write.mock.calls.length;

    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
    process.stdout.emit('resize');
    const frame = write.mock.calls.slice(before).map((call) => String(call[0]));
    panel?.stop();

    // 先换行另起一帧（旧帧行宽与新帧不同，CUU 回移会落错行 → 新旧内容互相穿插）
    expect(frame[0]).toBe('\n');
    expect(frame[1]).not.toMatch(/\x1b\[\d+A/);
    expect(frame[1]!.replace(ANSI, '').split('\n')[0]).toHaveLength(78); // 新宽度 = 80 - 2
  });
});
