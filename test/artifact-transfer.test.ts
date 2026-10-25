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

  it('重启后按 operationId 恢复上传进度', () => {
    const { dir, store, manager } = setup();
    const body = Buffer.from('resume me', 'utf8');
    const whole = sha(body);
    const first = body.subarray(0, 5);
    const ready = manager.startUpload({
      sessionId: 'bt_art',
      operationId: 'op_resume',
      name: 'resume.txt',
      mimeType: 'text/plain',
      size: body.length,
      sha256: whole,
      chunkSize: 5,
    });
    manager.writeChunk({
      transferId: ready.transferId,
      offset: 0,
      data: first.toString('base64'),
      chunkSha256: sha(first),
    });

    const restarted = new ArtifactTransferManager({
      store,
      rootDir: join(dir, 'artifacts'),
      emit: () => undefined,
    });
    const resumed = restarted.startUpload({
      sessionId: 'bt_art',
      operationId: 'op_resume',
      name: 'resume.txt',
      mimeType: 'text/plain',
      size: body.length,
      sha256: whole,
      chunkSize: 5,
    });
    expect(resumed.transferId).toBe(ready.transferId);
    expect(resumed.nextOffset).toBe(5);

    restarted.writeChunk({
      transferId: resumed.transferId,
      offset: 5,
      data: body.subarray(5).toString('base64'),
      chunkSha256: sha(body.subarray(5)),
    });
    const result = restarted.completeUpload({
      transferId: resumed.transferId,
      size: body.length,
      sha256: whole,
    });
    expect(result.committed).toBe(true);
    expect(store.getTransfer(ready.transferId)).toBeUndefined();
  });

  it('下载按 ready/chunk/ack/result 推送', () => {
    const { manager, sent } = setup();
    const body = Buffer.from('download me', 'utf8');
    const whole = sha(body);
    const ready = manager.startUpload({
      sessionId: 'bt_art',
      operationId: 'op_dl',
      name: 'download.txt',
      mimeType: 'text/plain',
      size: body.length,
      sha256: whole,
    });
    manager.writeChunk({
      transferId: ready.transferId,
      offset: 0,
      data: body.toString('base64'),
      chunkSha256: sha(body),
    });
    const uploaded = manager.completeUpload({
      transferId: ready.transferId,
      size: body.length,
      sha256: whole,
    });

    manager.startDownload({ sessionId: 'bt_art', artifactId: uploaded.artifactId ?? '' });
    const downloadReady = sent.find((m) => m.type === 'artifact_download_ready');
    const chunk = sent.find((m) => m.type === 'artifact_download_chunk');
    expect(downloadReady).toBeDefined();
    expect(chunk).toMatchObject({ offset: 0, data: body.toString('base64') });
    if (downloadReady?.type === 'artifact_download_ready') {
      manager.ackDownload({ transferId: downloadReady.transferId, nextOffset: body.length });
    }
    expect(sent.at(-1)).toMatchObject({ type: 'artifact_download_result', status: 'completed' });
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
