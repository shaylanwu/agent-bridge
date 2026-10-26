/**
 * 终端常驻任务面板 v2（CLI 支撑件，C 批次设计评审后重写）
 *
 * 形态（2026-10-25 用户确认的设计稿）：
 *  ┌─ 细边框引导区（主题绿边框、标签列对齐、行间留白）
 *  ├─ 真表格：主题绿表头/分隔线 + 固定列宽 + 四态圆点行
 *  └─ 底部状态栏（四态着色 + 操作提示）
 *
 * 实现约束：
 *  - 仅 TTY 启用；非 TTY 返回 null 退化逐行日志；
 *  - 重绘用 CUU（\x1b[<n>A）+ \r——`\x1b[<n>F`（CPL）在 Git Bash/winpty 下不生效，
 *    实测会导致状态行重复打印（2026-10-24 用户截图事故）；
 *  - 对齐一律「先按纯文本算宽度，再整体套色」（色码不参与列宽计算，永不失真）；
 *  - CJK 宽度按 2 计；
 *  - 渲染异常绝不影响任务（全部包 try/catch）。
 */

import type { CapacitySnapshot } from '../core/task-supervisor.js';
import type { SessionLog } from '../app/session-log.js';
import type { TaskRegistry, TaskView } from '../app/task-registry.js';
import { C } from './render.js';

export interface PanelOptions {
  registry: TaskRegistry;
  capacity: () => CapacitySnapshot;
  platformUrl: string;
  /** 展示用设备名称（配置 label；缺省为主机名），不是 deviceId */
  deviceName: string;
  /** serve 启动控制面后给出 Web 面板地址（已内嵌只读令牌）；缺省时显示未启用提示 */
  webUrl?: string;
}

export interface PanelHandle {
  /** 面板存在期间的日志出口：先让出面板区域、打印、再重绘 */
  printLine: (line: string) => void;
  stop: () => void;
}

const MAX_SETTLED_ROWS = 5;

// ---------- 显示宽度（CJK=2，状态符号=1）与对齐（全部作用于纯文本） ----------

const SINGLE_WIDTH_SYMBOLS = '●◷✓✗○';

function charWidth(ch: string): number {
  // 这些符号虽超出 ASCII，但在 Windows Terminal / Git Bash 中按单宽显示
  if (SINGLE_WIDTH_SYMBOLS.includes(ch)) return 1;
  return ch.charCodeAt(0) > 0xff ? 2 : 1;
}

function dispWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch);
  return w;
}

/** 按显示宽度截断（超出补 …） */
function truncTo(s: string, max: number): string {
  if (dispWidth(s) <= max) return s;
  let w = 0;
  let out = '';
  for (const ch of s) {
    const cw = charWidth(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

/** 按显示宽度右补空格到 width */
function padTo(s: string, width: number): string {
  const d = width - dispWidth(s);
  return d > 0 ? s + ' '.repeat(d) : truncTo(s, width);
}

// ---------- 行模型 ----------

const DOT = { running: '●', queued: '◷', success: '✓', failed: '✗', cancelled: '○' } as const;

function stateColor(v: TaskView): (s: string) => string {
  if (v.status === 'running') return v.phase === 'queued' ? C.yellow : C.blue;
  if (v.status === 'success') return C.green;
  if (v.status === 'cancelled') return C.dim;
  return C.red;
}

function dotOf(v: TaskView): string {
  if (v.status === 'running') return v.phase === 'queued' ? DOT.queued : DOT.running;
  if (v.status === 'success') return DOT.success;
  if (v.status === 'cancelled') return DOT.cancelled;
  return DOT.failed;
}

function statusText(v: TaskView): string {
  if (v.status === 'running') return v.phase === 'queued' ? '排队中' : '执行中';
  if (v.status === 'success') return '成功';
  if (v.status === 'failed') return '失败';
  if (v.status === 'timeout') return '超时';
  return '已取消';
}

function fmtElapsed(v: TaskView, now: number): string {
  const from = v.startedAt ?? v.createdAt;
  const to = v.settledAt ?? now;
  const s = Math.max(0, Math.round((to - from) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function stepText(v: TaskView): string {
  if (v.status === 'running' && v.phase === 'queued') return `第 ${v.queuePosition ?? '-'} 位 · 等待空位`;
  if (v.status === 'running') {
    return v.currentStep
      ? `#${v.currentStep.seq} ${v.currentStep.action}${v.currentStep.label ? ` ${v.currentStep.label}` : ''}`
      : '运行中（等待首个步骤事件）';
  }
  if (v.status === 'success') return v.stepCount > 0 ? `完成 · 共 ${v.stepCount} 步` : '完成';
  return `${v.error ?? '失败'}${v.stepCount > 0 ? `（止于步骤 ${v.stepCount}）` : ''}`;
}

function stepColor(v: TaskView): (s: string) => string {
  if (v.status === 'running' && v.phase !== 'queued') return C.blue;
  if (v.status === 'failed' || v.status === 'timeout') return C.red;
  return C.dim;
}

/**
 * 面板模式的日志口径：任务输出（[stdout]/[stderr]/▶ 行）不上主窗口；
 * 运行信息照常、告警/错误经面板让位打印（printLine 会先擦面板再重绘）。
 */
export function panelLog(panel: PanelHandle): SessionLog {
  return (level, line) => {
    if (level === 'info') {
      const t = line.trim();
      if (t.startsWith('[stdout]') || t.startsWith('[stderr]') || t.startsWith('▶')) return;
      panel.printLine(C.dim(line));
      return;
    }
    panel.printLine(level === 'error' ? C.red(line) : C.yellow(line));
  };
}

export function startPanel(opts: PanelOptions): PanelHandle | null {
  if (!process.stdout.isTTY) return null;

  let lastLines = 0;
  let stopped = false;
  const cols = (): number => process.stdout.columns || 100;

  const render = (): void => {
    if (stopped) return;
    try {
      const now = Date.now();
      const cap = opts.capacity();
      const counts = opts.registry.counts();
      const views = opts.registry.list();
      const active = views.filter((v) => v.status === 'running');
      const settled = views.filter((v) => v.status !== 'running').slice(-MAX_SETTLED_ROWS);
      const W = Math.min(cols() - 2, 92); // 边框盒总宽（顶/底/内容行严格同宽）

      const lines: string[] = [];
      const accent = (s: string): string => `\x1b[38;2;23;166;127m${s}\x1b[0m`;
      const boxBlank = (): string => accent(`│${' '.repeat(W - 2)}│`);
      // —— 细边框引导区（主题绿边框、无底色、上下及行间留白） ——
      lines.push(accent(`╭${'─'.repeat(W - 2)}╮`));
      lines.push(boxBlank());
      // 分段着色：宽度按纯文本算；未截断时逐段套色，截断时整体素色（保证不错位）
      const boxRow = (label: string, segs: Array<[string, ((s: string) => string) | null]>): string => {
        const plain = segs.map((s) => s[0]).join('');
        const t = truncTo(plain, W - 10);
        const body = t === plain ? segs.map(([txt, fn]) => (fn ? fn(txt) : txt)).join('') : t;
        return `${accent('│')} ${accent(label)}  ${body}${' '.repeat(Math.max(0, W - 10 - dispWidth(t)))} ${accent('│')}`;
      };
      lines.push(
        boxRow('平台', [
          [opts.platformUrl || '（未配置）', C.blue],
          ...(opts.deviceName
            ? ([[' · 设备 ', C.dim], [opts.deviceName, null]] as Array<[string, ((s: string) => string) | null]>)
            : []),
        ]),
      );
      lines.push(boxBlank());
      lines.push(
        boxRow('容量', [
          [`运行 ${cap.running}/${cap.maxTasks} · 排队 ${cap.queued} · 会话 成功 `, null],
          [String(counts.success), C.green],
          [' · 失败 ', null],
          [String(counts.failed), counts.failed > 0 ? C.red : null],
        ]),
      );
      // 面板行始终显示：没有地址时明确告诉用户怎么开，不能靠猜。
      lines.push(boxBlank());
      lines.push(
        boxRow('面板', [
          opts.webUrl
            ? [opts.webUrl, C.blue]
            : ['未启用 · serve --port=8787 开启', C.dim],
        ]),
      );
      lines.push(boxBlank());
      lines.push(accent(`╰${'─'.repeat(W - 2)}╯`));
      lines.push('');

      // —— 表格（主题绿表头/分隔线 + 固定列宽；任务行间留白） ——
      const CW = { status: 9, task: 20, agent: 16, elapsed: 6 };
      const stepW = Math.max(16, W - CW.status - CW.task - CW.agent - CW.elapsed - 6);
      const tableW = CW.status + CW.task + CW.agent + stepW + CW.elapsed + 4;
      lines.push(
        C.bold(accent(padTo('状态', CW.status) + ' ' + padTo('任务', CW.task) + ' ' + padTo('工具', CW.agent) + ' ' + padTo('当前步骤', stepW) + ' ' + ' '.repeat(Math.max(0, CW.elapsed - dispWidth('耗时'))) + '耗时')),
      );
      lines.push(accent('─'.repeat(tableW)));
      lines.push('');
      for (const [i, v] of [...active, ...settled].entries()) {
        if (i > 0) lines.push('');
        // 逐格上色：色码只包住各自格子（补齐的空格无色相，不可见），宽度计算永不失真
        const line =
          stateColor(v)(padTo(`${dotOf(v)} ${statusText(v)}`, CW.status)) +
          ' ' + padTo(truncTo(v.taskId, 8), CW.task) +
          ' ' + padTo(v.agentType, CW.agent) +
          ' ' + stepColor(v)(padTo(stepText(v), stepW)) +
          ' ' + C.dim(fmtElapsed(v, now).padStart(CW.elapsed));
        lines.push(line);
      }
      if (views.length === 0) lines.push(C.dim('（暂无任务）'));
      lines.push('');

      // —— 底部状态栏 ——
      lines.push(accent('─'.repeat(tableW)));
      lines.push('');
      const left = [
        C.blue(`运行 ${counts.running}`),
        C.yellow(`排队 ${counts.queued}`),
        C.green(`成功 ${counts.success}`),
        C.red(`失败 ${counts.failed}`),
      ].join(' · ');
      const right = C.dim('Ctrl+C 退出 · 日志不进此窗口');
      const gap = Math.max(1, tableW - dispWidth(`运行 ${counts.running} · 排队 ${counts.queued} · 成功 ${counts.success} · 失败 ${counts.failed}`) - dispWidth('Ctrl+C 退出 · 日志不进此窗口'));
      lines.push(left + ' '.repeat(gap) + right);

      // 区域重绘：CUU 回移（winpty 兼容）+ 行首 + 清行
      if (lastLines > 0) process.stdout.write(`\x1b[${lastLines}A\r`);
      process.stdout.write(lines.map((l) => `\x1b[2K${l}`).join('\n') + '\n');
      lastLines = lines.length;
    } catch {
      /* 少画一帧而已 */
    }
  };

  const erase = (): void => {
    if (lastLines > 0) {
      try {
        process.stdout.write(`\x1b[${lastLines}A\r` + '\x1b[2K\n'.repeat(lastLines) + `\x1b[${lastLines}A\r`);
      } catch {
        /* ignore */
      }
    }
  };

  const unsubscribe = opts.registry.subscribe(render);
  // 耗时每秒走字：仅在 TTY 面板存活期运行
  const tick = setInterval(render, 1000);
  process.stdout.write('\x1b[?25l'); // 隐藏光标
  render();

  return {
    printLine: (line) => {
      if (stopped) return;
      try {
        erase();
        process.stdout.write(`${line}\n`);
        lastLines = 0;
        render();
      } catch {
        /* ignore */
      }
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      clearInterval(tick);
      try {
        process.stdout.write('\x1b[?25h'); // 恢复光标
      } catch {
        /* ignore */
      }
    },
  };
}
