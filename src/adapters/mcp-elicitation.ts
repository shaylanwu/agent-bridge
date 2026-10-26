/**
 * Minimal MCP elicitation client (stdio JSON-RPC).
 *
 * MCP servers may ask the client for structured input:
 *   server -> client  elicitation/create { message, requestedSchema }
 *   client -> server  { action: 'accept'|'decline'|'cancel', content? }
 *
 * This module is transport-only: it does not decide policy, persist forms, or wire bridge
 * interactions. Callers provide the elicitation handler (which can map to task_interaction_request).
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';

export interface McpServerSpec {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ElicitationRequest {
  message: string;
  requestedSchema: Record<string, unknown>;
  /** 原始 params，便于保留 MCP 未来字段 */
  raw: Record<string, unknown>;
}

export type ElicitationResponse =
  | { action: 'accept'; content: Record<string, unknown> }
  | { action: 'decline' }
  | { action: 'cancel' };

export type ElicitationHandler = (
  request: ElicitationRequest,
) => Promise<ElicitationResponse> | ElicitationResponse;

export interface McpClientOptions {
  spec: McpServerSpec;
  clientInfo?: { name: string; version: string };
  protocolVersion?: string;
  timeoutMs?: number;
  onElicitation?: ElicitationHandler;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class McpElicitationClient {
  private child?: ChildProcessWithoutNullStreams;
  private rl?: Interface;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;
  private readonly timeoutMs: number;

  constructor(private readonly options: McpClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async start(): Promise<void> {
    if (this.child) return;
    const { spec } = this.options;
    const child = spawn(spec.command, spec.args ?? [], {
      cwd: spec.cwd,
      env: spec.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.rl = createInterface({ input: child.stdout });
    this.rl.on('line', (line) => void this.onLine(line));
    child.on('error', (error) => this.failAll(error));
    child.on('close', () => {
      this.closed = true;
      this.failAll(new Error('MCP 进程已退出'));
    });
    await this.request('initialize', {
      protocolVersion: this.options.protocolVersion ?? '2025-06-18',
      capabilities: { elicitation: {} },
      clientInfo: this.options.clientInfo ?? { name: 'agent-bridge', version: '1.0.0' },
    });
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async listTools(): Promise<Array<Record<string, unknown>>> {
    await this.start();
    const result = (await this.request('tools/list', {})) as { tools?: unknown };
    return Array.isArray(result.tools) ? (result.tools as Array<Record<string, unknown>>) : [];
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    timeoutMs = this.timeoutMs,
  ): Promise<unknown> {
    await this.start();
    return this.request('tools/call', { name, arguments: args }, timeoutMs);
  }

  close(): void {
    this.closed = true;
    this.rl?.close();
    this.child?.kill();
    this.child?.stdin.destroy();
    this.child?.stdout.destroy();
    this.child?.stderr.destroy();
    this.child?.unref();
    this.failAll(new Error('MCP 客户端已关闭'));
  }

  private send(message: Record<string, unknown>): void {
    const child = this.child;
    if (!child || this.closed || !child.stdin.writable) return;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = this.timeoutMs,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private async onLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = message['id'];
    if (typeof id === 'number' && (message['result'] !== undefined || message['error'] !== undefined)) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message['error'] !== undefined) {
        pending.reject(new Error(`MCP 错误：${JSON.stringify(message['error'])}`));
      } else {
        pending.resolve(message['result']);
      }
      return;
    }
    if (message['method'] === 'elicitation/create' && typeof id === 'number') {
      const params = (message['params'] ?? {}) as Record<string, unknown>;
      let response: ElicitationResponse = { action: 'cancel' };
      try {
        response = this.options.onElicitation
          ? await this.options.onElicitation({
              message: String(params['message'] ?? ''),
              requestedSchema:
                typeof params['requestedSchema'] === 'object' && params['requestedSchema'] !== null
                  ? (params['requestedSchema'] as Record<string, unknown>)
                  : {},
              raw: params,
            })
          : { action: 'cancel' };
      } catch {
        response = { action: 'cancel' };
      }
      this.send({ jsonrpc: '2.0', id, result: response });
      return;
    }
    // 其他 server -> client 请求：明确返回 method not found，避免 stdio 对端挂死。
    if (typeof id === 'number' && typeof message['method'] === 'string') {
      this.send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `unsupported client method: ${message['method']}` },
      });
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
