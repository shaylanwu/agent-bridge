import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactTransferManager, ArtifactTransferError } from '../src/core/artifact-transfer.js';
import { SessionStore } from '../src/core/session-store.js';
import type { ClientMessage } from '../src/protocol.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    closeSync: vi.fn(actual.closeSync),
    openSync: vi.fn(actual.openSync),
    readFileSync: vi.fn(actual.readFileSync),
    readSync: vi.fn(actual.readSync),
  };
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  vi.clearAllMocks();
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

function expectTransferError(fn: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ArtifactTransferError);
  expect((thrown as ArtifactTransferError).code).toBe(code);
}

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

    for (let offset = 4; offset < body.length; offset += ready.chunkSize) {
      const chunk = body.subarray(offset, Math.min(offset + ready.chunkSize, body.length));
      manager.writeChunk({
        transferId: ready.transferId,
        offset,
        data: chunk.toString('base64'),
        chunkSha256: sha(chunk),
      });
    }
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
    expect(store.getTransfer(ready.transferId)).toMatchObject({ state: 'committed' });
  });

  it('GC 回收超时上传但保留已提交附件', () => {
    const { manager, store } = setup();
    const body = Buffer.from('stale', 'utf8');
    const ready = manager.startUpload({
      sessionId: 'bt_art',
      operationId: 'op_stale',
      name: 'stale.txt',
      mimeType: 'text/plain',
      size: body.length,
      sha256: sha(body),
    });
    const persisted = store.getTransfer(ready.transferId);
    expect(persisted).toBeDefined();
    if (persisted) {
      store.saveTransfer({
        ...persisted,
        updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      });
    }
    expect(manager.cleanupStaleTransfers(24 * 60 * 60 * 1000)).toBe(1);
    expect(store.getTransfer(ready.transferId)).toBeUndefined();
    if (persisted?.tempPath) expect(existsSync(persisted.tempPath)).toBe(false);
  });

  it('TTL 清理按 CAS 引用计数，只删最后一个引用', () => {
    const { manager, store } = setup();
    const body = Buffer.from('same content', 'utf8');
    const whole = sha(body);
    const upload = (op: string) => {
      const ready = manager.startUpload({
        sessionId: 'bt_art',
        operationId: op,
        name: `${op}.txt`,
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
      return manager.completeUpload({ transferId: ready.transferId, size: body.length, sha256: whole });
    };
    upload('op_ttl_1');
    upload('op_ttl_2');
    expect(store.listAllArtifacts()).toHaveLength(2);

    const preview = manager.cleanupArtifacts({ olderThanMs: 0, dryRun: true });
    expect(preview).toMatchObject({ deleted: 2, filesRemoved: 1 });
    expect(store.listAllArtifacts()).toHaveLength(2);

    const actual = manager.cleanupArtifacts({ olderThanMs: 0 });
    expect(actual).toMatchObject({ deleted: 2, filesRemoved: 1 });
    expect(store.listAllArtifacts()).toHaveLength(0);
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

    manager.startDownload({
      sessionId: 'bt_art',
      artifactId: uploaded.artifactId ?? '',
      operationId: 'op_dl_download',
    });
    const downloadReady = sent.find((m) => m.type === 'artifact_download_ready');
    const chunk = sent.find((m) => m.type === 'artifact_download_chunk');
    expect(downloadReady).toBeDefined();
    expect(chunk).toMatchObject({ offset: 0, data: body.toString('base64') });
    if (downloadReady?.type === 'artifact_download_ready') {
      manager.ackDownload({ transferId: downloadReady.transferId, nextOffset: body.length });
    }
    expect(sent.at(-1)).toMatchObject({ type: 'artifact_download_result', status: 'completed' });
  });

  it('下载重启后从 nextOffset 续传', () => {
    const { dir, store, manager, sent } = setup();
    const body = Buffer.from('abcdefgh', 'utf8');
    const whole = sha(body);
    const up = manager.startUpload({
      sessionId: 'bt_art',
      operationId: 'op_dl_resume_up',
      name: 'resume-dl.txt',
      mimeType: 'text/plain',
      size: body.length,
      sha256: whole,
    });
    manager.writeChunk({
      transferId: up.transferId,
      offset: 0,
      data: body.toString('base64'),
      chunkSha256: sha(body),
    });
    const uploaded = manager.completeUpload({ transferId: up.transferId, size: body.length, sha256: whole });

    manager.startDownload({
      sessionId: 'bt_art',
      artifactId: uploaded.artifactId ?? '',
      operationId: 'op_dl_resume',
      chunkSize: 4,
    });
    const ready = sent.find((m) => m.type === 'artifact_download_ready');
    expect(ready).toBeDefined();
    if (ready?.type === 'artifact_download_ready') {
      manager.ackDownload({ transferId: ready.transferId, nextOffset: 4 });
    }

    const restartedSent: ClientMessage[] = [];
    const restarted = new ArtifactTransferManager({
      store,
      rootDir: join(dir, 'artifacts'),
      emit: (msg) => restartedSent.push(msg),
    });
    restarted.startDownload({
      sessionId: 'bt_art',
      artifactId: uploaded.artifactId ?? '',
      operationId: 'op_dl_resume',
      chunkSize: 4,
    });
    const resumedReady = restartedSent.find((m) => m.type === 'artifact_download_ready');
    const resumedChunk = restartedSent.find((m) => m.type === 'artifact_download_chunk');
    expect(resumedChunk).toMatchObject({ offset: 4 });
    if (resumedReady?.type === 'artifact_download_ready') {
      restarted.ackDownload({ transferId: resumedReady.transferId, nextOffset: 8 });
    }
    expect(restartedSent.at(-1)).toMatchObject({ type: 'artifact_download_result', status: 'completed' });
    if (ready?.type === 'artifact_download_ready') {
      expect(store.getTransfer(ready.transferId)).toBeUndefined(); // 下载完成后仍释放下载记录
    }
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

  it('complete 分段计算整文件 SHA-256，不调用 readFileSync', () => {
    const { manager } = setup();
    const body = Buffer.from('hash without loading the whole file');
    const ready = manager.startUpload({
      sessionId: 'bt_art',
      operationId: 'op_stream_hash',
      name: 'stream.txt',
      mimeType: 'text/plain',
      size: body.length,
      sha256: sha(body),
    });
    manager.writeChunk({
      transferId: ready.transferId,
      offset: 0,
      data: body.toString('base64'),
      chunkSha256: sha(body),
    });
    vi.mocked(readFileSync).mockClear();

    expect(manager.completeUpload({ transferId: ready.transferId, size: body.length, sha256: sha(body) }).committed).toBe(true);
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it('下载用同一 file handle 按 offset/length 读取，并在完成后关闭', () => {
    const { manager } = setup();
    const body = Buffer.from('abcdefghij');
    const upload = manager.startUpload({
      sessionId: 'bt_art',
      operationId: 'op_bounded_download_up',
      name: 'bounded.txt',
      mimeType: 'text/plain',
      size: body.length,
      sha256: sha(body),
    });
    manager.writeChunk({
      transferId: upload.transferId,
      offset: 0,
      data: body.toString('base64'),
      chunkSha256: sha(body),
    });
    const artifact = manager.completeUpload({ transferId: upload.transferId, size: body.length, sha256: sha(body) });
    vi.mocked(readFileSync).mockClear();
    vi.mocked(openSync).mockClear();
    vi.mocked(closeSync).mockClear();
    vi.mocked(readSync).mockClear();

    const download = manager.startDownload({
      sessionId: 'bt_art',
      artifactId: artifact.artifactId ?? '',
      operationId: 'op_bounded_download',
      chunkSize: 4,
    });
    const openIndex = vi.mocked(openSync).mock.calls.findIndex(([, flags]) => flags === 'r');
    const fd = vi.mocked(openSync).mock.results[openIndex]?.value as number;
    expect(openIndex).toBeGreaterThanOrEqual(0);
    expect(readFileSync).not.toHaveBeenCalled();
    expect(readSync).toHaveBeenCalledWith(fd, expect.any(Buffer), 0, 4, 0);

    const retry = manager.startDownload({
      sessionId: 'bt_art',
      artifactId: artifact.artifactId ?? '',
      operationId: 'op_bounded_download',
      chunkSize: 4,
    });
    expect(retry.transferId).toBe(download.transferId);
    expect(closeSync).toHaveBeenCalledWith(fd);
    const retryOpenIndex = vi.mocked(openSync).mock.calls.findLastIndex(([, flags]) => flags === 'r');
    const retryFd = vi.mocked(openSync).mock.results[retryOpenIndex]?.value as number;
    vi.mocked(closeSync).mockClear();
    expect(readSync).toHaveBeenCalledWith(retryFd, expect.any(Buffer), 0, 4, 0);
    manager.ackDownload({ transferId: retry.transferId, nextOffset: 4 });
    expect(readSync).toHaveBeenCalledWith(retryFd, expect.any(Buffer), 0, 4, 4);
    manager.ackDownload({ transferId: retry.transferId, nextOffset: 8 });
    expect(readSync).toHaveBeenCalledWith(retryFd, expect.any(Buffer), 0, 2, 8);
    expect(closeSync).not.toHaveBeenCalledWith(retryFd);
    manager.ackDownload({ transferId: retry.transferId, nextOffset: 10 });
    expect(closeSync).toHaveBeenCalledWith(retryFd);
  });

  it('下载发送或 ack 失败时关闭 file handle', () => {
    const { dir, store, manager } = setup();
    const body = Buffer.from('close on failure');
    const upload = manager.startUpload({
      sessionId: 'bt_art',
      operationId: 'op_failed_download_up',
      name: 'failed.txt',
      mimeType: 'text/plain',
      size: body.length,
      sha256: sha(body),
    });
    manager.writeChunk({
      transferId: upload.transferId,
      offset: 0,
      data: body.toString('base64'),
      chunkSha256: sha(body),
    });
    const artifact = manager.completeUpload({ transferId: upload.transferId, size: body.length, sha256: sha(body) });
    const failing = new ArtifactTransferManager({
      store,
      rootDir: join(dir, 'artifacts'),
      emit: (msg) => {
        if (msg.type === 'artifact_download_chunk') throw new Error('socket closed');
      },
    });
    vi.mocked(openSync).mockClear();
    vi.mocked(closeSync).mockClear();

    expect(() =>
      failing.startDownload({
        sessionId: 'bt_art',
        artifactId: artifact.artifactId ?? '',
        operationId: 'op_failed_download',
      }),
    ).toThrow('socket closed');
    const openIndex = vi.mocked(openSync).mock.calls.findIndex(([, flags]) => flags === 'r');
    const fd = vi.mocked(openSync).mock.results[openIndex]?.value as number;
    expect(openIndex).toBeGreaterThanOrEqual(0);
    expect(closeSync).toHaveBeenCalledWith(fd);

    vi.mocked(openSync).mockClear();
    vi.mocked(closeSync).mockClear();
    const retry = manager.startDownload({
      sessionId: 'bt_art',
      artifactId: artifact.artifactId ?? '',
      operationId: 'op_failed_download',
    });
    const retryOpenIndex = vi.mocked(openSync).mock.calls.findIndex(([, flags]) => flags === 'r');
    const retryFd = vi.mocked(openSync).mock.results[retryOpenIndex]?.value as number;
    expectTransferError(() => manager.ackDownload({ transferId: retry.transferId, nextOffset: 1 }), 'out_of_order');
    expect(closeSync).toHaveBeenCalledWith(retryFd);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, Number.NaN])(
    '拒绝非安全整数 offset：%s',
    (offset) => {
      const { manager, store } = setup();
      const body = Buffer.from('abc');
      const ready = manager.startUpload({
        sessionId: 'bt_art',
        operationId: `op_offset_${String(offset)}`,
        name: 'offset.txt',
        mimeType: 'text/plain',
        size: body.length,
        sha256: sha(body),
      });
      expectTransferError(
        () => manager.writeChunk({ transferId: ready.transferId, offset, data: body.toString('base64'), chunkSha256: sha(body) }),
        'invalid_offset',
      );
      expect(store.getTransfer(ready.transferId)?.nextOffset).toBe(0);
    },
  );

  it.each(['', 'bad', 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)])('拒绝非法 chunk hash 形状：%s', (chunkSha256) => {
    const { manager } = setup();
    const body = Buffer.from('abc');
    const ready = manager.startUpload({
      sessionId: 'bt_art',
      operationId: 'op_hash_shape',
      name: 'hash.txt',
      mimeType: 'text/plain',
      size: body.length,
      sha256: sha(body),
    });
    expectTransferError(
      () => manager.writeChunk({ transferId: ready.transferId, offset: 0, data: body.toString('base64'), chunkSha256 }),
      'invalid_hash',
    );
  });

  it.each(['YQ', 'YQ=', 'YQ===', 'YQ==\n', 'YR=='])('拒绝非规范 base64：%s', (data) => {
    const { manager } = setup();
    const body = Buffer.from('a');
    const ready = manager.startUpload({
      sessionId: 'bt_art',
      operationId: 'op_base64',
      name: 'base64.txt',
      mimeType: 'text/plain',
      size: body.length,
      sha256: sha(body),
    });
    expectTransferError(
      () => manager.writeChunk({ transferId: ready.transferId, offset: 0, data, chunkSha256: sha(body) }),
      'invalid_base64',
    );
  });

  it.each([
    { length: 5, chunkSize: 4 },
    { length: 1024 * 1024 + 1, chunkSize: 2 * 1024 * 1024 },
  ])('拒绝实际字节数超过协商或全局上限的 chunk：%o', ({ length, chunkSize }) => {
    const { manager, store } = setup();
    const body = Buffer.alloc(length, 1);
    const ready = manager.startUpload({
      sessionId: 'bt_art',
      operationId: 'op_chunk_limit',
      name: 'limit.bin',
      mimeType: 'application/octet-stream',
      size: body.length,
      sha256: sha(body),
      chunkSize,
    });
    expectTransferError(
      () => manager.writeChunk({ transferId: ready.transferId, offset: 0, data: body.toString('base64'), chunkSha256: sha(body) }),
      'chunk_too_large',
    );
    expect(store.getTransfer(ready.transferId)?.nextOffset).toBe(0);
  });

  it('旧 offset 内容一致时重放当前 ack，不写文件', () => {
    const { manager } = setup();
    const body = Buffer.from('abcdef');
    const first = body.subarray(0, 3);
    const ready = manager.startUpload({
      sessionId: 'bt_art',
      operationId: 'op_replay_same',
      name: 'replay.txt',
      mimeType: 'text/plain',
      size: body.length,
      sha256: sha(body),
      chunkSize: 3,
    });
    const input = { transferId: ready.transferId, offset: 0, data: first.toString('base64'), chunkSha256: sha(first) };
    expect(manager.writeChunk(input)).toEqual({ nextOffset: 3 });
    vi.mocked(openSync).mockClear();

    expect(manager.writeChunk(input)).toEqual({ nextOffset: 3 });
    expect(openSync).not.toHaveBeenCalledWith(expect.anything(), 'r+');
    const rest = body.subarray(3);
    manager.writeChunk({ transferId: ready.transferId, offset: 3, data: rest.toString('base64'), chunkSha256: sha(rest) });
    expect(manager.completeUpload({ transferId: ready.transferId, size: body.length, sha256: sha(body) }).committed).toBe(true);
  });

  it('旧 offset 内容不一致时 conflict 且不污染已确认内容', () => {
    const { manager } = setup();
    const body = Buffer.from('abcdef');
    const first = body.subarray(0, 3);
    const wrong = Buffer.from('xyz');
    const ready = manager.startUpload({
      sessionId: 'bt_art',
      operationId: 'op_replay_conflict',
      name: 'conflict.txt',
      mimeType: 'text/plain',
      size: body.length,
      sha256: sha(body),
      chunkSize: 3,
    });
    manager.writeChunk({ transferId: ready.transferId, offset: 0, data: first.toString('base64'), chunkSha256: sha(first) });

    expectTransferError(
      () => manager.writeChunk({ transferId: ready.transferId, offset: 0, data: wrong.toString('base64'), chunkSha256: sha(wrong) }),
      'conflict',
    );
    const rest = body.subarray(3);
    manager.writeChunk({ transferId: ready.transferId, offset: 3, data: rest.toString('base64'), chunkSha256: sha(rest) });
    expect(manager.completeUpload({ transferId: ready.transferId, size: body.length, sha256: sha(body) }).committed).toBe(true);
  });

  it('上传 status/abort 后迟到 chunk 和 complete 不会复活传输', () => {
    const { manager, store, sent } = setup();
    const body = Buffer.from('abort upload');
    const first = body.subarray(0, 4);
    const ready = manager.startUpload({
      sessionId: 'bt_art', operationId: 'op_abort_up', name: 'abort.txt', mimeType: 'text/plain',
      size: body.length, sha256: sha(body), chunkSize: 4,
    });
    manager.writeChunk({ transferId: ready.transferId, offset: 0, data: first.toString('base64'), chunkSha256: sha(first) });
    expect(manager.transferStatus(ready.transferId)).toMatchObject({
      direction: 'upload', state: 'uploading', nextOffset: 4, artifactId: ready.artifactId,
    });
    const tempPath = store.getTransfer(ready.transferId)?.tempPath;
    expect(manager.abortTransfer(ready.transferId, 'user cancelled')).toMatchObject({ state: 'aborted', nextOffset: 4 });
    expect(tempPath && existsSync(tempPath)).toBe(false);
    expect(sent.at(-1)).toMatchObject({ type: 'artifact_transfer_status', state: 'aborted' });
    expectTransferError(
      () => manager.writeChunk({ transferId: ready.transferId, offset: 4, data: body.subarray(4).toString('base64'), chunkSha256: sha(body.subarray(4)) }),
      'transfer_not_found',
    );
    expectTransferError(() => manager.completeUpload({ transferId: ready.transferId, size: body.length, sha256: sha(body) }), 'transfer_not_found');
  });

  it('下载 abort 关闭 fd，迟到 ack 不复活', () => {
    const { manager, store } = setup();
    const body = Buffer.from('abort download');
    const up = manager.startUpload({
      sessionId: 'bt_art', operationId: 'op_abort_dl_up', name: 'abort-dl.txt', mimeType: 'text/plain',
      size: body.length, sha256: sha(body),
    });
    manager.writeChunk({ transferId: up.transferId, offset: 0, data: body.toString('base64'), chunkSha256: sha(body) });
    const artifact = manager.completeUpload({ transferId: up.transferId, size: body.length, sha256: sha(body) });
    const download = manager.startDownload({ sessionId: 'bt_art', artifactId: artifact.artifactId!, operationId: 'op_abort_dl', chunkSize: 4 });
    expect(manager.transferStatus(download.transferId)).toMatchObject({ direction: 'download', state: 'uploading', nextOffset: 0 });
    vi.mocked(closeSync).mockClear();
    expect(manager.abortTransfer(download.transferId, 'cancel')).toMatchObject({ direction: 'download', state: 'aborted' });
    expect(closeSync).toHaveBeenCalled();
    expectTransferError(() => manager.ackDownload({ transferId: download.transferId, nextOffset: 4 }), 'transfer_not_found');
    expect(store.getTransfer(download.transferId)?.state).toBe('aborted');
  });

  it('Manager 重建后无需重复 start 即可 complete 已收齐上传', () => {
    const { dir, store, manager } = setup();
    const body = Buffer.from('complete after restart');
    const ready = manager.startUpload({
      sessionId: 'bt_art', operationId: 'op_complete_restart', name: 'restart.txt', mimeType: 'text/plain',
      size: body.length, sha256: sha(body),
    });
    manager.writeChunk({ transferId: ready.transferId, offset: 0, data: body.toString('base64'), chunkSha256: sha(body) });
    const restarted = new ArtifactTransferManager({ store, rootDir: join(dir, 'artifacts'), emit: () => undefined });
    expect(restarted.completeUpload({ transferId: ready.transferId, size: body.length, sha256: sha(body) })).toMatchObject({
      committed: true,
      artifactId: ready.artifactId,
    });
  });

  it('committed 后可查询 status 并重放 complete，不新增 canonical 事件', () => {
    const { manager, store, sent } = setup();
    const body = Buffer.from('committed replay');
    const input = {
      sessionId: 'bt_art', operationId: 'op_committed_replay', name: 'committed.txt', mimeType: 'text/plain',
      size: body.length, sha256: sha(body),
    };
    const ready = manager.startUpload(input);
    manager.writeChunk({ transferId: ready.transferId, offset: 0, data: body.toString('base64'), chunkSha256: sha(body) });
    const first = manager.completeUpload({ transferId: ready.transferId, size: body.length, sha256: sha(body) });
    expect(manager.transferStatus(ready.transferId)).toMatchObject({ state: 'committed', nextOffset: body.length });
    const events = store.listEvents('bt_art').length;
    const replay = manager.completeUpload({ transferId: ready.transferId, size: body.length, sha256: sha(body) });
    expect(replay).toEqual(first);
    expect(store.listEvents('bt_art')).toHaveLength(events);
    expect(manager.startUpload(input)).toMatchObject({ transferId: ready.transferId, nextOffset: body.length });
    expect(sent.filter((msg) => msg.type === 'task_artifact')).toHaveLength(1);
    expectTransferError(
      () => manager.completeUpload({ transferId: ready.transferId, size: body.length, sha256: '0'.repeat(64) }),
      'conflict',
    );
    const other = Buffer.from('other artifact');
    const second = manager.startUpload({
      sessionId: 'bt_art', operationId: 'op_other_artifact', name: 'other.txt', mimeType: 'text/plain',
      size: other.length, sha256: sha(other),
    });
    manager.writeChunk({ transferId: second.transferId, offset: 0, data: other.toString('base64'), chunkSha256: sha(other) });
    manager.completeUpload({ transferId: second.transferId, size: other.length, sha256: sha(other) });
    expect(manager.completeUpload({ transferId: ready.transferId, size: body.length, sha256: sha(body) })).toMatchObject({
      artifactId: ready.artifactId,
      eventSeq: first.eventSeq,
    });
  });

  it('rename 后 DB 尚未提交时可从 CAS 继续 complete', () => {
    const { dir, manager, store } = setup();
    const body = Buffer.from('renamed before db commit');
    const whole = sha(body);
    const ready = manager.startUpload({
      sessionId: 'bt_art', operationId: 'op_rename_crash', name: 'rename.txt', mimeType: 'text/plain',
      size: body.length, sha256: whole,
    });
    manager.writeChunk({ transferId: ready.transferId, offset: 0, data: body.toString('base64'), chunkSha256: sha(body) });
    const persisted = store.getTransfer(ready.transferId)!;
    const target = join(dir, 'artifacts', `default/sha256/${whole.slice(0, 2)}/${whole}`);
    mkdirSync(dirname(target), { recursive: true });
    renameSync(persisted.tempPath!, target);

    const restarted = new ArtifactTransferManager({ store, rootDir: join(dir, 'artifacts'), emit: () => undefined });
    expect(restarted.completeUpload({ transferId: ready.transferId, size: body.length, sha256: whole })).toMatchObject({
      committed: true,
      artifactId: ready.artifactId,
    });
    expect(store.getTransfer(ready.transferId)).toMatchObject({ state: 'committed', tempPath: undefined });
  });

  it('DB 推进成功前不改变内存 nextOffset', () => {
    const { manager, store } = setup();
    const body = Buffer.from('abc');
    const input = {
      sessionId: 'bt_art',
      operationId: 'op_db_order',
      name: 'db.txt',
      mimeType: 'text/plain',
      size: body.length,
      sha256: sha(body),
    };
    const ready = manager.startUpload(input);
    const update = vi.spyOn(store, 'updateTransferOffset').mockImplementationOnce(() => {
      throw new Error('database unavailable');
    });
    expect(() =>
      manager.writeChunk({ transferId: ready.transferId, offset: 0, data: body.toString('base64'), chunkSha256: sha(body) }),
    ).toThrow('database unavailable');

    expect(manager.startUpload(input).nextOffset).toBe(0);
    update.mockRestore();
    manager.writeChunk({ transferId: ready.transferId, offset: 0, data: body.toString('base64'), chunkSha256: sha(body) });
    expect(manager.completeUpload({ transferId: ready.transferId, size: body.length, sha256: sha(body) }).committed).toBe(true);
  });
});
