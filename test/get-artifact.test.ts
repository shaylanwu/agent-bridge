/**
 * get_artifact 的行为契约（1.0）：越权、超限、CAS 缺失三条路径必须各回各的码，
 * 不能一律「找不到」—— 平台靠这些码决定是重试、改走分块下载、还是放弃。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../src/core/session-store.js';
import { dispatchGetArtifact, type TaskDispatchOptions } from '../src/app/task-dispatch.js';
import { ARTIFACT_INLINE_MAX_BYTES, type ClientMessage } from '../src/protocol.js';

const stores: SessionStore[] = [];
const dirs: string[] = [];

function setup(): { store: SessionStore; root: string; emitted: ClientMessage[] } {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-art-'));
  dirs.push(dir);
  const root = join(dir, 'artifacts');
  mkdirSync(join(root, 'default', 'sha256'), { recursive: true });
  const store = new SessionStore(join(dir, 'state.db'));
  stores.push(store);
  store.createSession({ sessionId: 'bt_a', mode: 'task', agentType: 'codex', cwd: dir });
  store.createSession({ sessionId: 'bt_b', mode: 'task', agentType: 'codex', cwd: dir });
  return { store, root, emitted: [] };
}

function opts(store: SessionStore, root: string, emitted: ClientMessage[]): TaskDispatchOptions {
  return {
    emitter: { emit: (msg: ClientMessage) => emitted.push(msg) },
    store,
    requireServiceToken: false,
    artifactRootDir: root,
    log: () => {},
  } as unknown as TaskDispatchOptions;
}

function put(store: SessionStore, sessionId: string, artifactId: string, size: number, key: string): void {
  store.putArtifact({
    tenantId: 'default',
    artifactId,
    sessionId,
    name: `${artifactId}.txt`,
    mimeType: 'text/plain',
    size,
    sha256: 'a'.repeat(64),
    kind: 'attachment',
    storageKey: key,
  });
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('get_artifact', () => {
  it('正常内联：回 base64 内容与元数据', () => {
    const { store, root, emitted } = setup();
    const key = 'default/sha256/aa/abc';
    mkdirSync(join(root, 'default/sha256/aa'), { recursive: true });
    writeFileSync(join(root, key), 'hello');
    put(store, 'bt_a', 'art_1', 5, key);

    dispatchGetArtifact(
      { type: 'get_artifact', taskId: 'bt_a', artifactId: 'art_1', requestId: 'r1' },
      opts(store, root, emitted),
    );

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: 'artifact_content', found: true, requestId: 'r1', size: 5 });
    expect((emitted[0] as { data?: string }).data).toBe(Buffer.from('hello').toString('base64'));
  });

  it('换个任务 id 读同一附件 → artifact_not_found（不泄露存在性）', () => {
    const { store, root, emitted } = setup();
    put(store, 'bt_a', 'art_1', 5, 'default/sha256/aa/abc');

    dispatchGetArtifact(
      { type: 'get_artifact', taskId: 'bt_b', artifactId: 'art_1' },
      opts(store, root, emitted),
    );

    expect(emitted[0]).toMatchObject({ found: false, errorCode: 'artifact_not_found' });
  });

  it('超过内联上限只回元数据 + too_large', () => {
    const { store, root, emitted } = setup();
    put(store, 'bt_a', 'art_big', ARTIFACT_INLINE_MAX_BYTES + 1, 'default/sha256/aa/big');

    dispatchGetArtifact(
      { type: 'get_artifact', taskId: 'bt_a', artifactId: 'art_big' },
      opts(store, root, emitted),
    );

    const msg = emitted[0] as { found: boolean; contentUnavailableReason?: string; data?: string };
    expect(msg.found).toBe(true);
    expect(msg.contentUnavailableReason).toBe('too_large');
    expect(msg.data).toBeUndefined();
  });

  it('元数据在但 CAS 文件已回收 → not_readable（不是 not_found）', () => {
    const { store, root, emitted } = setup();
    put(store, 'bt_a', 'art_gone', 5, 'default/sha256/aa/gone');

    dispatchGetArtifact(
      { type: 'get_artifact', taskId: 'bt_a', artifactId: 'art_gone' },
      opts(store, root, emitted),
    );

    expect(emitted[0]).toMatchObject({ found: true, contentUnavailableReason: 'not_readable' });
  });
});
