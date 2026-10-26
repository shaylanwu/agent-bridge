import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { McpHost } from '../src/adapters/mcp-host.js';

const FAKE = String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let callId = null;
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { elicitation: {} }, serverInfo: { name: 'fake', version: '1' } } });
    return;
  }
  if (m.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'deploy', description: 'deploy app' }] } });
    return;
  }
  if (m.method === 'tools/call') {
    callId = m.id;
    send({ jsonrpc: '2.0', id: 900, method: 'elicitation/create', params: {
      message: 'Pick env',
      requestedSchema: { type: 'object', properties: { env: { type: 'string' } } },
    }});
    return;
  }
  if (m.id === 900 && m.result) {
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

function fakeServer() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-mcp-host-'));
  dirs.push(dir);
  const script = join(dir, 'fake.cjs');
  writeFileSync(script, FAKE);
  return { command: process.execPath, args: [script], cwd: dir };
}

describe('McpHost', () => {
  it('按配置启动 server，list/call 与 elicitation 都能走通', async () => {
    const host = new McpHost({ fake: fakeServer() });
    try {
      expect(host.names()).toEqual(['fake']);
      const tools = await host.listTools('fake');
      expect(tools[0]).toMatchObject({ name: 'deploy' });

      const result = (await host.callTool('fake', 'deploy', {}, () => ({
        action: 'accept',
        content: { env: 'staging' },
      }))) as { content: Array<{ text: string }> };
      expect(JSON.parse(result.content[0]?.text ?? '{}')).toEqual({
        action: 'accept',
        content: { env: 'staging' },
      });
    } finally {
      host.close();
    }
  });
});
