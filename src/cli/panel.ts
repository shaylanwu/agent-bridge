/**
 * 终端常驻任务面板 v2（CLI 支撑件，C 批次设计评审后重写）
 *
 * 形态（2026-10-25 设计稿，2026-10-29 按用户要求定稿）：
 *  ┌─ 细边框引导区（主题绿边框、标签列对齐、行间留白）
 *  ├─ 真表格：圆角外框 + 表头列分隔线 + 行间分隔线 ／ 表头加粗绿、行内容按状态着色、
 *  │   数据行只留左右外框竖线、空态提示水平居中
 *  └─ 底部状态栏（四态着色 + 操作提示）——三块之间不留空行
 *
 * 实现约束：
 *  - 仅 TTY 启用；非 TTY 返回 null 退化逐行日志；
 *  - 重绘用 CUU（\x1b[<n>A）+ \r——`\x1b[<n>F`（CPL）在 Git Bash/winpty 下不生效，
 *    实测会导致状态行重复打印（2026-10-24 用户截图事故）；
 *  - 对齐一律「先按纯文本算宽度，再整体套色」（色码不参与列宽计算，永不失真）；
 *  - 表格与引导区线框同宽同起止（第 0..W-1 列），两端绝对对齐；
 *    留白由格内左右各 1 空格提供（表头文字与 `│ 平台` 同列）；
 *  - 列宽按「文字宽度」定，每格另有左右各 1 空格 + 1 根竖线；截断时省略号宽度也算进去，
 *    否则带截断的行会比列宽多出 1 格、把右边框顶歪（2026-10-29 实测修过）；
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

const SINGLE_WIDTH_SYMBOLS = '●◷✓✗○…';

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

/** 按显示宽度截断（超出补 …）；省略号自身的宽度也从 max 里扣掉，结果永不超宽 */
function truncTo(s: string, max: number): string {
  if (dispWidth(s) <= max) return s;
  const ell = charWidth('…');
  let w = 0;
  let out = '';
  for (const ch of s) {
    const cw = charWidth(ch);
    if (w + cw > max - ell) break;
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

/** 引导区行标签（表格首列与标签列同列，改文案时只影响这里） */
const ROW_LABEL = { platform: '平台', capacity: '容量', panel: '面板' } as const;

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
  if (v.status === 'cancelled') return v.stepCount > 0 ? `已取消 · 共 ${v.stepCount} 步` : '已取消';
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
  let lastW = 0;
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
      // 终端宽度变了：旧帧的行宽与新帧不同，CUU 回移会落错行、新旧内容叠在一起（用户看到的「窄框 + 宽表格」）。
      // 这种情况直接另起一帧，宁可留一屏旧内容，也不要两帧互相穿插。
      if (lastW !== 0 && lastW !== W && lastLines > 0) {
        process.stdout.write('\n');
        lastLines = 0;
      }
      lastW = W;
      // 表格与引导区线框同宽（第 0..W-1 列），两端绝对对齐；格内左右各 1 空格自带留白
      const innerW = W;

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
        boxRow(ROW_LABEL.platform, [
          [opts.platformUrl || '（未配置）', C.blue],
          ...(opts.deviceName
            ? ([[' · 设备 ', C.dim], [opts.deviceName, null]] as Array<[string, ((s: string) => string) | null]>)
            : []),
        ]),
      );
      lines.push(boxBlank());
      lines.push(
        boxRow(ROW_LABEL.capacity, [
          // 数值一律素色（与运行/排队一致）；失败仅在 >0 时标红
          [`运行 ${cap.running}/${cap.maxTasks} · 排队 ${cap.queued} · 成功 `, null],
          [String(counts.success), null],
          [' · 失败 ', null],
          [String(counts.failed), counts.failed > 0 ? C.red : null],
        ]),
      );
      // 面板行始终显示：没有地址时明确告诉用户怎么开，不能靠猜。
      lines.push(boxBlank());
      lines.push(
        boxRow(ROW_LABEL.panel, [
          opts.webUrl
            ? [opts.webUrl, C.blue]
            : ['未启用 · serve --port=8787 开启', C.dim],
        ]),
      );
      lines.push(boxBlank());
      lines.push(accent(`╰${'─'.repeat(W - 2)}╯`));
      // 引导区与表格之间不留空行（用户：小间距）

      // —— 表格（圆角外框 + 列分隔线 + 行间分隔线；表头加粗绿，行内容按状态着色） ——
      // 与引导区线框同宽同起止（第 0..W-1 列）。列宽指「文字宽度」，
      // 每格另有左右各 1 空格；表头保留列竖线，数据行只留左右外框竖线（行间分隔线仍有列刻度）。
      const HEAD = { status: '状态', task: '任务', agent: '工具', step: '当前步骤', elapsed: '耗时' };
      const COL = { status: 9, task: 18, agent: 14, step: 25, elapsed: 6 };
      const NCOL = 5;
      const textBudget = innerW - (3 * NCOL + 1); // 扣掉竖线与每格左右空格
      // 「当前步骤」吃掉剩余宽度；不够时按 步骤 → 工具 → 任务 → 状态 → 耗时 依次压列
      COL.step = Math.max(8, textBudget - (COL.status + COL.task + COL.agent + COL.elapsed));
      const SHRINK: Array<[keyof typeof COL, number]> = [
        ['step', 12],
        ['agent', 8],
        ['task', 10],
        ['status', 7],
        ['elapsed', 5],
        ['step', 8],
      ];
      let budget = COL.status + COL.task + COL.agent + COL.step + COL.elapsed;
      for (const [key, min] of SHRINK) {
        while (budget > textBudget && COL[key] > min) {
          COL[key] -= 1;
          budget -= 1;
        }
      }
      COL.step = Math.max(8, COL.step + (textBudget - budget)); // 差额补回步骤列，整表宽度恒等于 innerW
      const ORDER: Array<keyof typeof COL> = ['status', 'task', 'agent', 'step', 'elapsed'];
      const gridBar = (l: string, m: string, r: string): string => accent(l + ORDER.map((k) => '─'.repeat(COL[k] + 2)).join(m) + r);
      const cell = (k: keyof typeof COL, text: string, color?: (s: string) => string): string => {
        const padded = padTo(truncTo(text, COL[k]), COL[k]);
        return ` ${color ? color(padded) : padded} `;
      };
      const joinCells = (cells: string[]): string => accent('│') + cells.join(accent('│')) + accent('│');
      // 数据行：列间不画竖线（用空格代替，列位与表头完全一致），只保留左右外框
      const joinRowCells = (cells: string[]): string => accent('│') + cells.join(' ') + accent('│');
      // 表体横线（表头分隔线/行间分隔线/底框）一律不带列刻度：列竖线只在表头行与顶框出现
      const flatBar = (l: string, r: string): string => accent(l + '─'.repeat(innerW - 2) + r);

      lines.push(gridBar('╭', '┬', '╮'));
      lines.push(
        joinCells(
          ORDER.map((k) => {
            // 耗时表头右对齐，与行内的右对齐数值同末端
            const text = k === 'elapsed' ? ' '.repeat(Math.max(0, COL[k] - dispWidth(HEAD[k]))) + HEAD[k] : HEAD[k];
            return cell(k, text, (s) => C.bold(accent(s)));
          }),
        ),
      );
      lines.push(flatBar('├', '┤'));
      const rows = [...active, ...settled];
      for (const [i, v] of rows.entries()) {
        // 行间分隔线：表格网格完整，每行都有下边线（不带列刻度）
        if (i > 0) lines.push(flatBar('├', '┤'));
        lines.push(
          joinRowCells([
            // 状态格整体随状态着色；耗时右对齐；其余朴素
            cell('status', `${dotOf(v)} ${statusText(v)}`, stateColor(v)),
            cell('task', v.taskId),
            cell('agent', v.agentType),
            cell('step', stepText(v), stepColor(v)),
            ` ${C.dim(fmtElapsed(v, now).padStart(COL.elapsed))} `,
          ]),
        );
      }
      if (rows.length === 0) {
        // 空态：提示文字水平居中于整行
        const hint = '（暂无任务）';
        const room = innerW - 2 - dispWidth(hint);
        const lead = Math.max(0, Math.floor(room / 2));
        lines.push(`${accent('│')}${' '.repeat(lead)}${C.dim(hint)}${' '.repeat(Math.max(0, room - lead))}${accent('│')}`);
      }
      lines.push(flatBar('╰', '╯'));

      // —— 底部状态栏（与表格下边框之间不留空行） ——
      const left = [
        C.blue(`运行 ${counts.running}`),
        C.yellow(`排队 ${counts.queued}`),
        C.green(`成功 ${counts.success}`),
        C.red(`失败 ${counts.failed}`),
      ].join(' · ');
      const leftPlain = `运行 ${counts.running} · 排队 ${counts.queued} · 成功 ${counts.success} · 失败 ${counts.failed}`;
      const rightPlain = 'Ctrl+C 退出 · 日志不进此窗口';
      const right = C.dim(rightPlain);
      const gap = innerW - dispWidth(leftPlain) - dispWidth(rightPlain);
      // 窄终端放不下右侧提示就只留计数，避免整行超宽把面板顶乱
      lines.push(gap >= 1 ? left + ' '.repeat(gap) + right : left);

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
  // 终端尺寸变化（拖窗口/IDE 面板宽度）立刻重画，靠 render 里的宽度比较另起一帧
  const onResize = (): void => render();
  process.stdout.on('resize', onResize);
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
      process.stdout.off('resize', onResize);
      clearInterval(tick);
      try {
        process.stdout.write('\x1b[?25h'); // 恢复光标
      } catch {
        /* ignore */
      }
    },
  };
}
