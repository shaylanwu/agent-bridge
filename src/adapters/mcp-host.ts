/**
 * 本机 MCP server 宿主：按 config.toml 的 [mcp.servers.*] 启动 stdio server，
 * 复用 McpElicitationClient 完成 tools/list、tools/call 与 elicitation。
 *
 * 这是“配置入口 + 宿主”，不是平台 Form 的完整链路；平台交互仍由调用方注入 handler。
 */

import type { BridgeConfig } from '../infra/config.js';
import { McpElicitationClient, type ElicitationHandler } from './mcp-elicitation.js';

export type McpServerConfig = NonNullable<BridgeConfig['mcp']>['servers'][string];

export class McpHost {
  private readonly clients = new Map<string, McpElicitationClient>();

  constructor(private readonly servers: Record<string, McpServerConfig>) {}

  names(): string[] {
    return Object.keys(this.servers).sort();
  }

  private client(name: string): McpElicitationClient {
    const spec = this.servers[name];
    if (!spec) throw new Error(`未配置 MCP server：${name}`);
    const cached = this.clients.get(name);
    if (cached) return cached;
    const client = new McpElicitationClient({
      spec: {
        command: spec.command,
        args: spec.args ?? [],
        cwd: spec.cwd ?? process.cwd(),
        env: { ...process.env, ...(spec.env ?? {}) },
      },
    });
    this.clients.set(name, client);
    return client;
  }

  async listTools(name: string): Promise<Array<Record<string, unknown>>> {
    return this.client(name).listTools();
  }

  async callTool(
    name: string,
    tool: string,
    args: Record<string, unknown> = {},
    onElicitation?: ElicitationHandler,
  ): Promise<unknown> {
    if (!this.servers[name]) throw new Error(`未配置 MCP server：${name}`);
    if (onElicitation) {
      const existing = this.clients.get(name);
      if (existing) {
        existing.close();
        this.clients.delete(name);
      }
      return this.createWithHandler(name, onElicitation).callTool(tool, args);
    }
    return this.client(name).callTool(tool, args);
  }

  private createWithHandler(name: string, onElicitation?: ElicitationHandler): McpElicitationClient {
    const spec = this.servers[name]!;
    const client = new McpElicitationClient({
      spec: {
        command: spec.command,
        args: spec.args ?? [],
        cwd: spec.cwd ?? process.cwd(),
        env: { ...process.env, ...(spec.env ?? {}) },
      },
      ...(onElicitation ? { onElicitation } : {}),
    });
    this.clients.set(name, client);
    return client;
  }

  close(): void {
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
  }
}
