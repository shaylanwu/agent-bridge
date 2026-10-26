import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { McpElicitationClient } from '../src/adapters/mcp-elicitation.js';

const FAKE = String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
let callId = null;
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { elicitation: {} }, serverInfo: { name: 'fake', version: '1' } } });
    return;
  }
  if (m.method === 'tools/call') {
    callId = m.id;
    send({ jsonrpc: '2.0', id: 700, method: 'elicitation/create', params: {
      message: 'Pick an environment',
      requestedSchema: { type: 'object', properties: { env: { type: 'string' } }, required: ['env'] },
    }});
    return;
  }
  if (m.id === 700 && m.result) {
    send({ jsonrpc: '2.0', id: callId, result: { content: [{ type: 'text', text: JSON.stringify(m.result) }] } });
  }
});
`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* Windows 句柄释放滞后 */
    }
  }
});

function fakeSpec(): { command: string; args: string[]; cwd: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-mcp-'));
  dirs.push(dir);
  const script = join(dir, 'fake-mcp.cjs');
  writeFileSync(script, FAKE);
  return { command: process.execPath, args: [script], cwd: dir };
}

describe('MCP elicitation client', () => {
  it('accept：elicitation/create 回传 content 并继续 tools/call', async () => {
    const client = new McpElicitationClient({
      spec: fakeSpec(),
      onElicitation: (request) => {
        expect(request.message).toBe('Pick an environment');
        expect(request.requestedSchema).toMatchObject({ type: 'object' });
        return { action: 'accept', content: { env: 'staging' } };
      },
    });
    const result = (await client.callTool('deploy', { app: 'demo' })) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(result.content[0]?.text ?? '{}')).toEqual({
      action: 'accept',
      content: { env: 'staging' },
    });
    client.close();
  });

  it('decline：回传 decline，不伪造 content', async () => {
    const client = new McpElicitationClient({
      spec: fakeSpec(),
      onElicitation: () => ({ action: 'decline' }),
    });
    const result = (await client.callTool('deploy')) as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0]?.text ?? '{}')).toEqual({ action: 'decline' });
    client.close();
  });

  it('close 立即拒绝挂起请求，不等超时', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-mcp-close-'));
    dirs.push(dir);
    const script = join(dir, 'fake-mcp.cjs');
    writeFileSync(
      script,
      String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18' } }) + '\n');
});
`,
    );
    const client = new McpElicitationClient({
      spec: { command: process.execPath, args: [script], cwd: dir },
      timeoutMs: 30_000,
    });
    const pending = client.callTool('hang');
    setTimeout(() => client.close(), 50);
    await expect(pending).rejects.toThrow(/已关闭/);
  });

  it('没有 handler 时默认 cancel', async () => {
    const client = new McpElicitationClient({ spec: fakeSpec() });
    const result = (await client.callTool('deploy')) as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0]?.text ?? '{}')).toEqual({ action: 'cancel' });
    client.close();
  });
});
