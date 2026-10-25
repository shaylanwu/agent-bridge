/**
 * Inbound artifact upload (1.0, first slice).
 *
 * Flow: start → ready → chunk/ack … → complete → task_artifact + result.
 * Contents go to a tenant-partitioned content-addressed store; SQLite stores metadata only.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { ClientMessage } from '../protocol.js';
import type { SessionStore } from './session-store.js';

const DEFAULT_CHUNK_SIZE = 256 * 1024;
const MAX_CHUNK_SIZE = 1024 * 1024;

interface Transfer {
  transferId: string;
  operationId: string;
  sessionId: string;
  artifactId: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  chunkSize: number;
  nextOffset: number;
  tempPath: string;
}

export class ArtifactTransferError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ArtifactTransferError';
  }
}

interface DownloadTransfer {
  transferId: string;
  artifactId: string;
  sessionId: string;
  operationId: string;
  path: string;
  size: number;
  sha256: string;
  chunkSize: number;
  offset: number;
  lastLength: number;
}

export class ArtifactTransferManager {
  private readonly transfers = new Map<string, Transfer>();
  private readonly byOperation = new Map<string, string>();
  private readonly downloads = new Map<string, DownloadTransfer>();
  private readonly root: string;

  constructor(
    private readonly deps: {
      store: SessionStore;
      emit: (msg: ClientMessage) => void;
      rootDir: string;
      tenantId?: string;
    },
  ) {
    this.root = deps.rootDir;
  }

  private tenant(): string {
    return this.deps.tenantId ?? 'default';
  }

  private sha256Bytes(data: Buffer): string {
    return createHash('sha256').update(data).digest('hex');
  }

  startUpload(input: {
    sessionId: string;
    operationId: string;
    name: string;
    mimeType: string;
    size: number;
    sha256: string;
    chunkSize?: number;
  }): { transferId: string; artifactId: string; nextOffset: number; chunkSize: number } {
    const key = `${input.sessionId}:${input.operationId}`;
    const existingId = this.byOperation.get(key);
    if (existingId) {
      const existing = this.transfers.get(existingId);
      if (existing) {
        return {
          transferId: existing.transferId,
          artifactId: existing.artifactId,
          nextOffset: existing.nextOffset,
          chunkSize: existing.chunkSize,
        };
      }
    }
    const persisted = this.deps.store.getTransferByOperation(
      input.sessionId,
      input.operationId,
      this.tenant(),
    );
    if (persisted?.state === 'uploading' && persisted.tempPath && statSync(persisted.tempPath, { throwIfNoEntry: false })) {
      const restored: Transfer = {
        transferId: persisted.transferId,
        operationId: persisted.operationId,
        sessionId: persisted.sessionId,
        artifactId: persisted.artifactId,
        name: persisted.name,
        mimeType: persisted.mimeType,
        size: persisted.size,
        sha256: persisted.sha256,
        chunkSize: persisted.chunkSize,
        nextOffset: persisted.nextOffset,
        tempPath: persisted.tempPath,
      };
      this.transfers.set(restored.transferId, restored);
      this.byOperation.set(key, restored.transferId);
      return {
        transferId: restored.transferId,
        artifactId: restored.artifactId,
        nextOffset: restored.nextOffset,
        chunkSize: restored.chunkSize,
      };
    }
    if (!this.deps.store.getSession(input.sessionId)) {
      throw new ArtifactTransferError('session_not_found', `会话不存在：${input.sessionId}`);
    }
    const chunkSize = Math.min(
      MAX_CHUNK_SIZE,
      Math.max(1, Math.floor(input.chunkSize ?? DEFAULT_CHUNK_SIZE)),
    );
    const transferId = `tr_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const artifactId = `art_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const tempDir = join(this.root, '.tmp');
    mkdirSync(tempDir, { recursive: true });
    const tempPath = join(tempDir, transferId);
    closeSync(openSync(tempPath, 'w'));
    const transfer: Transfer = {
      transferId,
      operationId: input.operationId,
      sessionId: input.sessionId,
      artifactId,
      name: input.name,
      mimeType: input.mimeType,
      size: input.size,
      sha256: input.sha256.toLowerCase(),
      chunkSize,
      nextOffset: 0,
      tempPath,
    };
    this.transfers.set(transferId, transfer);
    this.byOperation.set(key, transferId);
    this.deps.store.saveTransfer({
      tenantId: this.tenant(),
      transferId,
      sessionId: input.sessionId,
      operationId: input.operationId,
      artifactId,
      direction: 'upload',
      name: input.name,
      mimeType: input.mimeType,
      size: input.size,
      sha256: transfer.sha256,
      chunkSize,
      nextOffset: 0,
      tempPath,
      state: 'uploading',
    });
    return { transferId, artifactId, nextOffset: 0, chunkSize };
  }

  writeChunk(input: {
    transferId: string;
    offset: number;
    data: string;
    chunkSha256: string;
  }): { nextOffset: number } {
    let transfer = this.transfers.get(input.transferId);
    if (!transfer) {
      const persisted = this.deps.store.getTransfer(input.transferId, this.tenant());
      if (
        persisted?.state === 'uploading' &&
        persisted.tempPath &&
        statSync(persisted.tempPath, { throwIfNoEntry: false })
      ) {
        transfer = {
          transferId: persisted.transferId,
          operationId: persisted.operationId,
          sessionId: persisted.sessionId,
          artifactId: persisted.artifactId,
          name: persisted.name,
          mimeType: persisted.mimeType,
          size: persisted.size,
          sha256: persisted.sha256,
          chunkSize: persisted.chunkSize,
          nextOffset: persisted.nextOffset,
          tempPath: persisted.tempPath,
        };
        this.transfers.set(transfer.transferId, transfer);
        this.byOperation.set(`${transfer.sessionId}:${transfer.operationId}`, transfer.transferId);
      }
    }
    if (!transfer) throw new ArtifactTransferError('transfer_not_found', '传输不存在或已结束');
    const bytes = Buffer.from(input.data, 'base64');
    if (this.sha256Bytes(bytes) !== input.chunkSha256.toLowerCase()) {
      throw new ArtifactTransferError('chunk_hash_mismatch', 'chunk SHA-256 不匹配');
    }
    if (input.offset !== transfer.nextOffset) {
      throw new ArtifactTransferError(
        'out_of_order',
        `chunk offset ${input.offset} != expected ${transfer.nextOffset}`,
      );
    }
    if (transfer.nextOffset + bytes.length > transfer.size) {
      throw new ArtifactTransferError('size_exceeded', 'chunk 超出声明的文件大小');
    }
    const fd = openSync(transfer.tempPath, 'r+');
    try {
      writeSync(fd, bytes, 0, bytes.length, transfer.nextOffset);
    } finally {
      closeSync(fd);
    }
    transfer.nextOffset += bytes.length;
    this.deps.store.updateTransferOffset(transfer.transferId, transfer.nextOffset, this.tenant());
    return { nextOffset: transfer.nextOffset };
  }

  /**
   * 回收超时未完成的上传：只删临时文件与 transfer 记录，已提交 artifact 不受影响。
   */
  cleanupStaleTransfers(olderThanMs = 24 * 60 * 60 * 1000, now = Date.now()): number {
    const cutoff = now - olderThanMs;
    let removed = 0;
    for (const transfer of this.deps.store.listTransfers('uploading', this.tenant())) {
      if (Date.parse(transfer.updatedAt) > cutoff) continue;
      if (transfer.tempPath) rmSync(transfer.tempPath, { force: true });
      this.deps.store.deleteTransfer(transfer.transferId, this.tenant());
      this.transfers.delete(transfer.transferId);
      this.byOperation.delete(`${transfer.sessionId}:${transfer.operationId}`);
      removed += 1;
    }
    return removed;
  }

  /**
   * 显式 artifact TTL 清理（不自动执行）。同一 CAS 文件仍被其他 artifact 引用时保留文件。
   */
  cleanupArtifacts(input: {
    olderThanMs: number;
    dryRun?: boolean;
    now?: number;
  }): { scanned: number; deleted: number; filesRemoved: number } {
    const cutoff = (input.now ?? Date.now()) - input.olderThanMs;
    const all = this.deps.store.listAllArtifacts(this.tenant());
    const expired = all.filter((artifact) => Date.parse(artifact.createdAt) <= cutoff);
    if (expired.length === 0) return { scanned: all.length, deleted: 0, filesRemoved: 0 };

    const expiredKeys = new Set(expired.map((artifact) => artifact.storageKey));
    if (!input.dryRun) {
      for (const artifact of expired) {
        this.deps.store.deleteArtifact(artifact.artifactId, this.tenant());
      }
    }
    const remaining = input.dryRun
      ? all.filter((artifact) => !expiredKeys.has(artifact.storageKey))
      : this.deps.store.listAllArtifacts(this.tenant());
    const remainingKeys = new Set(remaining.map((artifact) => artifact.storageKey));
    let filesRemoved = 0;
    for (const key of expiredKeys) {
      if (remainingKeys.has(key)) continue;
      filesRemoved += 1;
      if (!input.dryRun) rmSync(join(this.root, key), { force: true });
    }
    return { scanned: all.length, deleted: expired.length, filesRemoved };
  }

  startDownload(input: {
    sessionId: string;
    artifactId: string;
    operationId: string;
    chunkSize?: number;
  }): { transferId: string; size: number; sha256: string; chunkSize: number } {
    const persisted = this.deps.store.getTransferByOperation(
      input.sessionId,
      input.operationId,
      this.tenant(),
    );
    const artifact = this.deps.store.getArtifact(input.artifactId);
    if (!artifact || artifact.sessionId !== input.sessionId) {
      throw new ArtifactTransferError('artifact_not_found', `附件不存在：${input.artifactId}`);
    }
    const path = join(this.root, artifact.storageKey);
    if (!statSync(path, { throwIfNoEntry: false })) {
      throw new ArtifactTransferError('artifact_missing', '附件内容不在 CAS 中');
    }
    const transferId =
      persisted?.state === 'uploading' &&
      persisted.direction === 'download' &&
      persisted.artifactId === input.artifactId
        ? persisted.transferId
        : `dt_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const chunkSize = Math.min(
      MAX_CHUNK_SIZE,
      Math.max(1, Math.floor(persisted?.chunkSize ?? input.chunkSize ?? DEFAULT_CHUNK_SIZE)),
    );
    const transfer: DownloadTransfer = {
      transferId,
      artifactId: artifact.artifactId,
      sessionId: input.sessionId,
      operationId: input.operationId,
      path,
      size: artifact.size,
      sha256: artifact.sha256,
      chunkSize,
      offset:
        persisted?.state === 'uploading' && persisted.direction === 'download'
          ? Math.min(persisted.nextOffset, artifact.size)
          : 0,
      lastLength: 0,
    };
    this.downloads.set(transferId, transfer);
    this.deps.store.saveTransfer({
      tenantId: this.tenant(),
      transferId,
      sessionId: input.sessionId,
      operationId: input.operationId,
      artifactId: artifact.artifactId,
      direction: 'download',
      name: artifact.name,
      mimeType: artifact.mimeType,
      size: artifact.size,
      sha256: artifact.sha256,
      chunkSize,
      nextOffset: transfer.offset,
      state: 'uploading',
    });
    this.deps.emit({
      type: 'artifact_download_ready',
      transferId,
      artifactId: artifact.artifactId,
      size: artifact.size,
      sha256: artifact.sha256,
      chunkSize,
    });
    if (transfer.offset >= artifact.size) {
      this.downloads.delete(transferId);
      this.deps.store.deleteTransfer(transferId, this.tenant());
      this.deps.emit({ type: 'artifact_download_result', transferId, status: 'completed' });
    } else {
      this.sendNextDownloadChunk(transfer);
    }
    return { transferId, size: artifact.size, sha256: artifact.sha256, chunkSize };
  }

  ackDownload(input: { transferId: string; nextOffset: number }): void {
    const transfer = this.downloads.get(input.transferId);
    if (!transfer) throw new ArtifactTransferError('transfer_not_found', '下载传输不存在或已结束');
    const expected = transfer.offset + transfer.lastLength;
    if (input.nextOffset !== expected) {
      throw new ArtifactTransferError(
        'out_of_order',
        `chunk ack offset ${input.nextOffset} != expected ${expected}`,
      );
    }
    transfer.offset = input.nextOffset;
    this.deps.store.updateTransferOffset(transfer.transferId, transfer.offset, this.tenant());
    if (transfer.offset >= transfer.size) {
      this.downloads.delete(transfer.transferId);
      this.deps.store.deleteTransfer(transfer.transferId, this.tenant());
      this.deps.emit({
        type: 'artifact_download_result',
        transferId: transfer.transferId,
        status: 'completed',
      });
      return;
    }
    this.sendNextDownloadChunk(transfer);
  }

  private sendNextDownloadChunk(transfer: DownloadTransfer): void {
    const content = readFileSync(transfer.path);
    const end = Math.min(transfer.size, transfer.offset + transfer.chunkSize);
    const chunk = content.subarray(transfer.offset, end);
    transfer.lastLength = chunk.length;
    this.deps.emit({
      type: 'artifact_download_chunk',
      transferId: transfer.transferId,
      offset: transfer.offset,
      data: chunk.toString('base64'),
      chunkSha256: this.sha256Bytes(chunk),
    });
  }

  completeUpload(input: { transferId: string; size: number; sha256: string }): {
    committed: boolean;
    artifactId?: string;
    eventSeq?: number;
  } {
    const transfer = this.transfers.get(input.transferId);
    if (!transfer) throw new ArtifactTransferError('transfer_not_found', '传输不存在或已结束');
    try {
      if (input.size !== transfer.size || transfer.nextOffset !== transfer.size) {
        throw new ArtifactTransferError('size_mismatch', '文件大小与声明不一致');
      }
      const content = readFileSync(transfer.tempPath);
      const actual = this.sha256Bytes(content);
      if (actual !== transfer.sha256 || input.sha256.toLowerCase() !== actual) {
        throw new ArtifactTransferError('file_hash_mismatch', '整文件 SHA-256 不匹配');
      }
      const storageKey = `${this.tenant()}/sha256/${actual.slice(0, 2)}/${actual}`;
      const target = join(this.root, storageKey);
      mkdirSync(dirname(target), { recursive: true });
      if (!statSync(target, { throwIfNoEntry: false })) {
        renameSync(transfer.tempPath, target);
      } else {
        rmSync(transfer.tempPath, { force: true });
      }
      const artifact = this.deps.store.putArtifact({
        tenantId: this.tenant(),
        artifactId: transfer.artifactId,
        sessionId: transfer.sessionId,
        name: transfer.name,
        mimeType: transfer.mimeType,
        size: transfer.size,
        sha256: actual,
        kind: 'attachment',
        storageKey,
      });
      const event = this.deps.store.appendEvent({
        sessionId: transfer.sessionId,
        type: 'task_artifact',
        payload: {
          artifactId: artifact.artifactId,
          name: artifact.name,
          mimeType: artifact.mimeType,
          size: artifact.size,
          sha256: artifact.sha256,
          kind: artifact.kind,
        },
      });
      this.deps.emit({
        type: 'task_artifact',
        taskId: transfer.sessionId,
        artifactId: artifact.artifactId,
        name: artifact.name,
        mimeType: artifact.mimeType,
        size: artifact.size,
        sha256: artifact.sha256,
        kind: artifact.kind,
        eventSeq: event.eventSeq,
      });
      this.transfers.delete(transfer.transferId);
      this.byOperation.delete(`${transfer.sessionId}:${transfer.operationId}`);
      this.deps.store.deleteTransfer(transfer.transferId, this.tenant());
      return { committed: true, artifactId: artifact.artifactId, eventSeq: event.eventSeq };
    } catch (error) {
      this.transfers.delete(transfer.transferId);
      this.byOperation.delete(`${transfer.sessionId}:${transfer.operationId}`);
      this.deps.store.deleteTransfer(transfer.transferId, this.tenant());
      rmSync(transfer.tempPath, { force: true });
      throw error;
    }
  }
}
