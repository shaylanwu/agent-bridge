import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { ArtifactTransferManager, ArtifactTransferError } from '../src/core/artifact-transfer.js';
import { SessionStore } from '../src/core/session-store.js';
import type { ClientMessage } from '../src/protocol.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-artifact-'));
  const store = new SessionStore(join(dir, 'state.db'));
  store.createSession({ sessionId: 'bt_art', mode: 'task', agentType: 'codex', cwd: dir });
  const sent: ClientMessage[] = [];
  const manager = new ArtifactTransferManager({
    store,
    rootDir: join(dir, 'artifacts'),
    emit: (msg) => sent.push(msg),
  });
  cleanups.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store, manager, sent };
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

describe('ArtifactTransferManager', () => {
  it('分块上传、校验并提交到 CAS', () => {
    const { manager, store, sent } = setup();
    const body = Buffer.from('hello artifact', 'utf8');
    const whole = sha(body);
    const ready = manager.startUpload({
      sessionId: 'bt_art',
      operationId: 'op_1',
      name: 'hello.txt',
      mimeType: 'text/plain',
      size: body.length,
      sha256: whole,
      chunkSize: 4,
    });
    expect(ready.nextOffset).toBe(0);

    const first = body.subarray(0, 4);
    expect(
      manager.writeChunk({
        transferId: ready.transferId,
        offset: 0,
        data: first.toString('base64'),
        chunkSha256: sha(first),
      }),
    ).toEqual({ nextOffset: 4 });

    const rest = body.subarray(4);
    manager.writeChunk({
      transferId: ready.transferId,
      offset: 4,
      data: rest.toString('base64'),
      chunkSha256: sha(rest),
    });
    const result = manager.completeUpload({ transferId: ready.transferId, size: body.length, sha256: whole });

    expect(result.committed).toBe(true);
    expect(store.getArtifact(result.artifactId ?? '')).toMatchObject({
      name: 'hello.txt',
      size: body.length,
      sha256: whole,
    });
    expect(sent.some((m) => m.type === 'task_artifact')).toBe(true);
  });

  it('chunk hash 不符/乱序拒绝', () => {
    const { manager } = setup();
    const body = Buffer.from('abc');
    const ready = manager.startUpload({
      sessionId: 'bt_art',
      operationId: 'op_2',
      name: 'a.txt',
      mimeType: 'text/plain',
      size: body.length,
      sha256: sha(body),
    });

    expect(() =>
      manager.writeChunk({
        transferId: ready.transferId,
        offset: 0,
        data: body.toString('base64'),
        chunkSha256: 'bad',
      }),
    ).toThrowError(ArtifactTransferError);

    expect(() =>
      manager.writeChunk({
        transferId: ready.transferId,
        offset: 999,
        data: body.toString('base64'),
        chunkSha256: sha(body),
      }),
    ).toThrowError(ArtifactTransferError);
  });
});
