/**
 * Claude Code bidirectional stream-json adapter; Qoder uses headless + native resume.
 *
 * Verified against Claude Code:
 *   claude -p --input-format stream-json --output-format stream-json --verbose
 * stdin: {"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
 * stdout: system/assistant/result NDJSON; result ends one turn.
 *
 * The CLI queues additional user frames but does NOT apply them to the active turn (verified:
 * a second frame while a 1..50 task was running did not change the result). So this adapter is a
 * stream-json execution mode only; same-turn steer remains Codex app-server exclusive.
 * It is intentionally opt-in (`claudeStream`); permissions stay with the CLI (`acceptEdits`, no bypass).
 */

import { createInterface } from 'node:readline';
import { killCliProcess, spawnCliProcess } from './agent-adapters.js';

export interface ClaudeStreamOptions {
  command?: string;
  cwd: string;
  prompt: string;
  nativeSessionId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onUpdate?: (event: Record<string, unknown>) => void;
  onSession?: (sessionId: string) => void;
}

export interface ClaudeStreamResult {
  sessionId: string;
  text: string;
  stopReason: string;
}

export function claudeStreamArgs(nativeSessionId?: string): string[] {
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

export function claudeResultError(event: Record<string, unknown>): Error | undefined {
  if (event['type'] !== 'result') return undefined;
  const subtype = typeof event['subtype'] === 'string' ? (event['subtype'] as string) : undefined;
  if (event['is_error'] !== true && (subtype === undefined || subtype === 'success')) return undefined;
  const detail =
    (typeof event['error'] === 'string' && (event['error'] as string)) ||
    (typeof event['result'] === 'string' && (event['result'] as string)) ||
    subtype ||
    '未知终态错误';
  return new Error(`Claude result${subtype ? ` ${subtype}` : ''}：${detail}`);
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

export async function runClaudeStreamPrompt(opts: ClaudeStreamOptions): Promise<ClaudeStreamResult> {
  const child = spawnCliProcess(opts.command ?? 'claude', claudeStreamArgs(opts.nativeSessionId), {
    cwd: opts.cwd,
    env: process.env,
  });

  let sessionId = '';
  let text = '';
  let stopReason = 'unknown';
  let settled = false;
  let closed = false;

  const sendUser = (value: string): void => {
    if (closed || !child.stdin.writable) return;
    child.stdin.write(
      `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: value }] },
      })}\n`,
    );
  };

  let resolveDone!: (result: ClaudeStreamResult) => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<ClaudeStreamResult>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    opts.onUpdate?.(event);
    if (event['type'] === 'system' && typeof event['session_id'] === 'string') {
      sessionId = event['session_id'];
      opts.onSession?.(sessionId);
      return;
    }
    if (event['type'] === 'assistant') {
      const chunk = textOf(event['message']);
      if (chunk) text += chunk;
      return;
    }
    if (event['type'] === 'result') {
      if (typeof event['session_id'] === 'string') sessionId = event['session_id'];
      if (typeof event['result'] === 'string') text = event['result'];
      const resultError = claudeResultError(event);
      if (resultError) {
        if (!settled) {
          settled = true;
          rejectDone(resultError);
        }
        return;
      }
      stopReason = typeof event['stop_reason'] === 'string' ? event['stop_reason'] : 'end_turn';
      if (!settled) {
        settled = true;
        resolveDone({ sessionId, text, stopReason });
      }
    }
  });

  const fail = (error: Error): void => {
    if (settled) return;
    settled = true;
    rejectDone(error);
  };
  child.on('error', fail);
  child.on('close', (code) => {
    closed = true;
    if (!settled) fail(new Error(`Claude stream 进程退出（code ${code ?? 'null'}）`));
  });

  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const timer = setTimeout(() => {
    killCliProcess(child, opts.command ?? 'claude');
    fail(new Error(`Claude stream 超时（${timeoutMs}ms）`));
  }, timeoutMs);
  const onAbort = (): void => {
    killCliProcess(child, opts.command ?? 'claude');
    fail(new Error('Claude stream 已取消'));
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  sendUser(opts.prompt);

  try {
    return await done;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    rl.close();
    killCliProcess(child, opts.command ?? 'claude');
    child.stdin.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
  }
}
