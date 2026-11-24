import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { isCredentialPath, mimeTypeOf, readArtifactFile, resolveWithinCwd } from '../src/core/artifact-extract.js';
import { Emitter } from '../src/core/emitter.js';
import { SessionStore } from '../src/core/session-store.js';
import { TaskRegistry } from '../src/app/task-registry.js';
import type { ClientMessage } from '../src/protocol.js';

/**
 * 产物提取的路径安全（tasks.md 4.9；spec「附件路径安全」）：
 *
 *  - 读取根 = 该任务 cwd 的 **realpath 子树**（不是 allowed_cwd —— 它只决定任务能否启动）；
 *  - 拒绝 `..`、绝对路径逃逸、目录、凭据路径（.ssh/.aws/.env/id_rsa…）；
 *  - realpath 解析后必须仍在根内（符号链接/junction 逃逸在解析后暴露）；
 *  - 同一 fd 打开 → fstat 定尺寸 → 从该 fd 读取并计算 SHA-256（Windows 无 O_NOFOLLOW，
 *    以 realpath 前置检查 + 单 fd 读取为等价实现）；
 *  - inline 上限内返回 content；超上限只给 sha256/size（内容走 CAS/transfer，不塞消息）。
 *  - 「无 adapter 明确 artifact 事件时不读取内容」由 dispatch 层的元数据路径保证（见集成测试）。
 */
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* Windows 句柄释放滞后 */
    }
  }
});

function workdir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-artifact-'));
  dirs.push(dir);
  return dir;
}

describe('凭据路径判定', () => {
  it('常见的凭据文件/目录被拒绝', () => {
    expect(isCredentialPath('.ssh/id_rsa')).toBe(true);
    expect(isCredentialPath('.aws/credentials')).toBe(true);
    expect(isCredentialPath('.env')).toBe(true);
    expect(isCredentialPath('config/.env.local')).toBe(true);
    expect(isCredentialPath('deploy/id_ed25519')).toBe(true);
    expect(isCredentialPath('src/app.ts')).toBe(false);
    expect(isCredentialPath('README.md')).toBe(false);
    expect(isCredentialPath('.gitignore')).toBe(false);
  });
});

describe('resolveWithinCwd：读取根限制', () => {
  it('根内正常相对路径解析成功', () => {
    const dir = workdir();
    writeFileSync(join(dir, 'out.txt'), 'x');
    const result = resolveWithinCwd(dir, 'out.txt');
    expect(result.ok).toBe(true);
  });

  it('拒绝 .. 逃逸、绝对路径、目录', () => {
    const dir = workdir();
    mkdirSync(join(dir, 'sub'), { recursive: true });
    expect(resolveWithinCwd(dir, '../outside.txt')).toMatchObject({ ok: false });
    expect(resolveWithinCwd(dir, 'sub/../../escape.txt')).toMatchObject({ ok: false });
    // 绝对路径：不是「cwd 下的相对产物」，直接拒绝（避免歧义）
    expect(resolveWithinCwd(dir, join(dir, 'out.txt'))).toMatchObject({ ok: false });
    writeFileSync(join(dir, 'file.txt'), 'x');
    expect(resolveWithinCwd(dir, 'sub')).toMatchObject({ ok: false });
  });

  it('拒绝凭据路径（即使物理上在根内）', () => {
    const dir = workdir();
    mkdirSync(join(dir, '.ssh'), { recursive: true });
    writeFileSync(join(dir, '.ssh', 'id_rsa'), 'private');
    expect(resolveWithinCwd(dir, '.ssh/id_rsa')).toMatchObject({ ok: false });
  });

  it('realpath 后落在根外的符号链接被拒绝（可创建 symlink 的平台）', () => {
    const dir = workdir();
    const outside = mkdtempSync(join(tmpdir(), 'agent-bridge-artifact-out-'));
    dirs.push(outside);
    writeFileSync(join(outside, 'secret.txt'), 'outside');
    let linked = false;
    try {
      symlinkSync(join(outside, 'secret.txt'), join(dir, 'leak.txt'), 'file');
      linked = true;
    } catch {
      // Windows 无特权创建 file symlink 会失败 —— 该断言在本机跳过，等价检查由 realpath 逻辑覆盖
    }
    if (linked) {
      expect(resolveWithinCwd(dir, 'leak.txt')).toMatchObject({ ok: false });
    }
  });
});

describe('readArtifactFile：同 fd 读取与 SHA-256', () => {
  it('根内文件：size/sha256 与内容一致；inline 上限内带 content', () => {
    const dir = workdir();
    const body = 'hello artifact';
    writeFileSync(join(dir, 'result.md'), body);
    const artifact = readArtifactFile(dir, 'result.md', { inlineMaxBytes: 1024 });
    expect(artifact).toMatchObject({
      name: 'result.md',
      mimeType: 'text/markdown',
      size: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
    });
    expect(artifact?.content?.toString()).toBe(body);
  });

  it('超过 inline 上限：sha256/size 仍给，content 不带（内容不塞消息）', () => {
    const dir = workdir();
    const big = 'y'.repeat(4096);
    writeFileSync(join(dir, 'big.bin'), big);
    const artifact = readArtifactFile(dir, 'big.bin', { inlineMaxBytes: 1024 });
    expect(artifact?.size).toBe(4096);
    expect(artifact?.sha256).toBe(createHash('sha256').update(big).digest('hex'));
    expect(artifact?.content).toBeUndefined();
  });

  it('mime 推断：常见扩展名与缺省', () => {
    expect(mimeTypeOf('a.txt')).toBe('text/plain');
    expect(mimeTypeOf('b.md')).toBe('text/markdown');
    expect(mimeTypeOf('c.json')).toBe('application/json');
    expect(mimeTypeOf('d.png')).toBe('image/png');
    expect(mimeTypeOf('e.log')).toBe('text/plain');
    expect(mimeTypeOf('noext')).toBe('application/octet-stream');
  });

  it('文件消失（已被任务清理）返回 undefined 而不是抛', () => {
    const dir = workdir();
    expect(readArtifactFile(dir, 'gone.txt', { inlineMaxBytes: 1024 })).toBeUndefined();
  });

  it('stat 尺寸与 fd 读取一致（同一 fd 的 fstat）', () => {
    const dir = workdir();
    writeFileSync(join(dir, 'exact.txt'), '12345');
    const artifact = readArtifactFile(dir, 'exact.txt', { inlineMaxBytes: 1024 });
    expect(artifact?.size).toBe(statSync(join(dir, 'exact.txt')).size);
  });
});

// —— dispatch 集成：changedFiles 只生成元数据（不读内容）——
const runnerMocks = vi.hoisted(() => ({ startTask: vi.fn() }));
vi.mock('../src/runner.js', () => ({ startTask: runnerMocks.startTask }));

describe('dispatch：changedFiles → task_artifact 元数据（无 adapter 事件不读内容）', () => {
  it('终态的 changedFiles 逐个发元数据事件：无 sha256、带 contentUnavailableReason', async () => {
    const { dispatchRunTask } = await import('../src/app/task-dispatch.js');
    const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-artifact-d-'));
    dirs.push(dir);
    // changedFiles 必须真实存在（不存在的文件按「已被任务清理」如实跳过）
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;');
    writeFileSync(join(dir, 'docs', 'b.md'), '# b');
    const store = new SessionStore(join(dir, 'state.db'));
    const sent: ClientMessage[] = [];
    const emitter = new Emitter({ sink: (msg) => sent.push(msg as ClientMessage) });
    runnerMocks.startTask.mockImplementation((req, hooks) => {
      hooks.onStatus('success', { exitCode: 0, changedFiles: ['src/a.ts', 'docs/b.md'] });
      return { taskId: req.taskId, cancel: () => undefined, done: Promise.resolve('success' as const) };
    });
    dispatchRunTask(
      { type: 'run_task', taskId: 't_af', agentType: 'kimi-code', cwd: dir, args: [], prompt: 'hi', captureDiff: true },
      {
        emitter,
        tasks: new Map(),
        registry: new TaskRegistry(),
        maxConcurrent: 5,
        maxQueued: 5,
        diffMaxBytes: 1024,
        captureDiffByDefault: false,
        requireServiceToken: false,
        store,
        log: () => undefined,
      },
    );
    const artifacts = sent.filter(
      (m): m is Extract<ClientMessage, { type: 'task_artifact' }> => m.type === 'task_artifact',
    );
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]).toMatchObject({ taskId: 't_af', name: 'src/a.ts', kind: 'output' });
    // 元数据路径不读内容：sha256 省略 + 原因显式给出
    expect(artifacts[0]?.sha256).toBeUndefined();
    expect(artifacts[0]?.contentUnavailableReason).toBe('no_adapter_artifact_event');
    // 事件也落了 canonical feed（eventSeq 分配）
    const events = store.listEvents('t_af').filter((e) => e.type === 'task_artifact');
    expect(events).toHaveLength(2);
    store.close();
  });

  it('无 captureDiff / 无 changedFiles 时不产生 artifact 事件', async () => {
    const { dispatchRunTask } = await import('../src/app/task-dispatch.js');
    const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-artifact-e-'));
    dirs.push(dir);
    const store = new SessionStore(join(dir, 'state.db'));
    const sent: ClientMessage[] = [];
    const emitter = new Emitter({ sink: (msg) => sent.push(msg as ClientMessage) });
    runnerMocks.startTask.mockImplementation((req, hooks) => {
      hooks.onStatus('success', { exitCode: 0 });
      return { taskId: req.taskId, cancel: () => undefined, done: Promise.resolve('success' as const) };
    });
    dispatchRunTask(
      { type: 'run_task', taskId: 't_af2', agentType: 'kimi-code', cwd: dir, args: [], prompt: 'hi' },
      {
        emitter,
        tasks: new Map(),
        registry: new TaskRegistry(),
        maxConcurrent: 5,
        maxQueued: 5,
        diffMaxBytes: 1024,
        captureDiffByDefault: false,
        requireServiceToken: false,
        store,
        log: () => undefined,
      },
    );
    expect(sent.filter((m) => m.type === 'task_artifact')).toHaveLength(0);
    store.close();
  });
});
