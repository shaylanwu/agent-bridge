/**
 * 常驻 Claude/Qoder stream-json 会话。
 *
 * 每个 conversation session 一个进程：Turn 结束（result）只结算 Turn，不退出进程；
 * 下一条 send_message 继续写 user 帧。这样省掉每轮 CLI 冷启动，并保留原生 session。
 *
 * 注意：CLI 会把 active Turn 期间的第二个 user 帧排队，因此这里不声明 same-turn steer。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import type { TaskFinishInfo } from '../core/task-supervisor.js';
import type { TaskHooks } from '../core/task-supervisor.js';

export interface ClaudeResidentOptions {
  command: string;
  /** 仅测试/自定义入口使用；默认 claudeResidentArgs() */
  args?: string[];
  cwd: string;
  nativeSessionId?: string;
  timeoutMs?: number;
  /** Turn 结束后空闲多久关闭进程；默认 10 分钟，0 表示不回收 */
  idleMs?: number;
}

interface ActiveTurn {
  hooks: TaskHooks;
  text: string;
  timer: NodeJS.Timeout;
  resolve: (info: TaskFinishInfo) => void;
  reject: (error: Error) => void;
}

export function claudeResidentArgs(nativeSessionId?: string): string[] {
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'acceptEdits',
  ];
  if (nativeSessionId) args.push('--resume', nativeSessionId);
  return args;
}

function textOf(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: string; text?: string } => Boolean(block && typeof block === 'object'))
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('');
}

export class ClaudeResident {
  private child?: ChildProcessWithoutNullStreams;
  private rl?: Interface;
  private active?: ActiveTurn;
  private stepSeq = 0;
  private stepRefs = new Map<string, number>();
  private sessionId = '';
  private closed = false;
  private idleTimer?: NodeJS.Timeout;

  constructor(private readonly options: ClaudeResidentOptions) {}

  get nativeSessionId(): string {
    return this.sessionId;
  }

  get isRunning(): boolean {
    return Boolean(this.child && !this.closed);
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.child && !this.closed) return this.child;
    const args =
      this.options.args ?? claudeResidentArgs(this.sessionId || this.options.nativeSessionId);
    const child = spawn(this.options.command, args, {
      cwd: this.options.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.closed = false;
    this.rl = createInterface({ input: child.stdout });
    this.rl.on('line', (line) => this.onLine(line));
    child.on('error', (error) => this.fail(error));
    child.on('close', () => {
      this.closed = true;
      this.fail(new Error('Claude 常驻进程已退出'));
    });
    return child;
  }

  send(prompt: string, hooks: TaskHooks, timeoutMs = 10 * 60_000): Promise<TaskFinishInfo> {
    if (this.active) return Promise.reject(new Error('Claude 会话正忙'));
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    const child = this.ensureStarted();
    if (!child.stdin.writable) return Promise.reject(new Error('Claude 会话 stdin 不可写'));
    this.stepSeq = 0;
    this.stepRefs.clear();
    return new Promise<TaskFinishInfo>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error('Claude 常驻会话超时'));
      }, timeoutMs);
      this.active = { hooks, text: '', timer, resolve, reject };
      child.stdin.write(
        `${JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: prompt }] },
        })}\n`,
      );
    });
  }

  close(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    this.closed = true;
    this.rl?.close();
    this.child?.kill();
    this.child?.stdin.destroy();
    this.child?.stdout.destroy();
    this.child?.stderr.destroy();
    this.child?.unref();
    this.active?.reject(new Error('Claude 常驻会话已关闭'));
    this.active = undefined;
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    const turn = this.active;
    if (event['type'] === 'system' && typeof event['session_id'] === 'string') {
      this.sessionId = event['session_id'];
      turn?.hooks.onSession?.(this.sessionId);
      return;
    }
    if (!turn) return;
    if (event['type'] === 'assistant') {
      const message = event['message'] as { content?: unknown } | undefined;
      const text = textOf(message);
      if (text) {
        turn.text += text;
        turn.hooks.onLog('stdout', text);
      }
      const blocks = Array.isArray(message?.content) ? message.content : [];
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        const item = block as Record<string, unknown>;
        if (item['type'] !== 'tool_use' || typeof item['name'] !== 'string') continue;
        this.stepSeq += 1;
        const ref = typeof item['id'] === 'string' ? item['id'] : undefined;
        if (ref) this.stepRefs.set(ref, this.stepSeq);
        turn.hooks.onStep?.({
          action: item['name'],
          label: typeof item['input'] === 'object' ? JSON.stringify(item['input']).slice(0, 200) : undefined,
          state: 'started',
          ref,
          seq: this.stepSeq,
        });
      }
      return;
    }
    if (event['type'] === 'result') {
      if (typeof event['session_id'] === 'string') this.sessionId = event['session_id'];
      const result = typeof event['result'] === 'string' ? event['result'] : turn.text;
      clearTimeout(turn.timer);
      this.active = undefined;
      turn.resolve({ exitCode: 0, result });
      const idleMs = this.options.idleMs ?? 10 * 60_000;
      if (idleMs > 0) {
        this.idleTimer = setTimeout(() => {
          this.idleTimer = undefined;
          this.close();
        }, idleMs);
        this.idleTimer.unref?.();
      }
    }
  }

  private fail(error: Error): void {
    const turn = this.active;
    this.active = undefined;
    if (turn) {
      clearTimeout(turn.timer);
      turn.reject(error);
    }
  }
}
