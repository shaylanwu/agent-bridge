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
  readSync,
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
  fd?: number;
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

  private sha256File(path: string): string {
    const fd = openSync(path, 'r');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(MAX_CHUNK_SIZE);
    try {
      while (true) {
        const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
      }
    } finally {
      closeSync(fd);
    }
    return hash.digest('hex');
  }

  private readRange(fd: number, length: number, offset: number): { bytes: Buffer; bytesRead: number } {
    const bytes = Buffer.alloc(length);
    let total = 0;
    while (total < length) {
      const read = readSync(fd, bytes, total, length - total, offset + total);
      if (read === 0) break;
      total += read;
    }
    return { bytes, bytesRead: total };
  }

  private closeDownload(transfer: DownloadTransfer): void {
    if (transfer.fd === undefined) return;
    const fd = transfer.fd;
    transfer.fd = undefined;
    closeSync(fd);
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
    if (persisted?.state === 'committed') {
      return {
        transferId: persisted.transferId,
        artifactId: persisted.artifactId,
        nextOffset: persisted.nextOffset,
        chunkSize: persisted.chunkSize,
      };
    }
    if (persisted?.state === 'aborted') {
      throw new ArtifactTransferError('transfer_aborted', '该 operationId 的传输已中止');
    }
    if (persisted?.state === 'uploading' && persisted.tempPath) {
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
    if (!Number.isSafeInteger(input.offset) || input.offset < 0) {
      throw new ArtifactTransferError('invalid_offset', 'chunk offset 必须是非负安全整数');
    }
    if (!/^[0-9a-fA-F]{64}$/.test(input.chunkSha256)) {
      throw new ArtifactTransferError('invalid_hash', 'chunk SHA-256 必须是 64 位十六进制字符串');
    }
    const maxChunkSize = Math.min(transfer.chunkSize, MAX_CHUNK_SIZE);
    if (input.data.length > 4 * Math.ceil(maxChunkSize / 3)) {
      throw new ArtifactTransferError('chunk_too_large', 'chunk 超过协商大小');
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data)) {
      throw new ArtifactTransferError('invalid_base64', 'chunk data 必须是规范 base64');
    }
    const bytes = Buffer.from(input.data, 'base64');
    if (bytes.toString('base64') !== input.data) {
      throw new ArtifactTransferError('invalid_base64', 'chunk data 必须是规范 base64');
    }
    if (bytes.length > maxChunkSize) {
      throw new ArtifactTransferError('chunk_too_large', 'chunk 超过协商大小');
    }
    if (this.sha256Bytes(bytes) !== input.chunkSha256.toLowerCase()) {
      throw new ArtifactTransferError('chunk_hash_mismatch', 'chunk SHA-256 不匹配');
    }
    if (input.offset < transfer.nextOffset) {
      if (bytes.length > transfer.nextOffset - input.offset) {
        throw new ArtifactTransferError('conflict', '重放 chunk 与已确认内容不一致');
      }
      const fd = openSync(transfer.tempPath, 'r');
      let persisted: { bytes: Buffer; bytesRead: number };
      try {
        persisted = this.readRange(fd, bytes.length, input.offset);
      } finally {
        closeSync(fd);
      }
      if (persisted.bytesRead !== bytes.length || !persisted.bytes.equals(bytes)) {
        throw new ArtifactTransferError('conflict', '重放 chunk 与已确认内容不一致');
      }
      return { nextOffset: transfer.nextOffset };
    }
    if (input.offset > transfer.nextOffset) {
      throw new ArtifactTransferError(
        'out_of_order',
        `chunk offset ${input.offset} != expected ${transfer.nextOffset}`,
      );
    }
    if (input.offset > transfer.size || bytes.length > transfer.size - input.offset) {
      throw new ArtifactTransferError('size_exceeded', 'chunk 超出声明的文件大小');
    }
    const fd = openSync(transfer.tempPath, 'r+');
    try {
      writeSync(fd, bytes, 0, bytes.length, transfer.nextOffset);
    } finally {
      closeSync(fd);
    }
    const nextOffset = transfer.nextOffset + bytes.length;
    this.deps.store.updateTransferOffset(transfer.transferId, nextOffset, this.tenant());
    transfer.nextOffset = nextOffset;
    return { nextOffset };
  }

  transferStatus(transferId: string): {
    transferId: string;
    direction: 'upload' | 'download';
    state: string;
    nextOffset: number;
    chunkSize: number;
    artifactId: string;
  } {
    const transfer = this.deps.store.getTransfer(transferId, this.tenant());
    if (!transfer) throw new ArtifactTransferError('transfer_not_found', '传输不存在');
    return {
      transferId: transfer.transferId,
      direction: transfer.direction,
      state: transfer.state,
      nextOffset: transfer.nextOffset,
      chunkSize: transfer.chunkSize,
      artifactId: transfer.artifactId,
    };
  }

  abortTransfer(transferId: string, reason?: string): ReturnType<ArtifactTransferManager['transferStatus']> {
    const persisted = this.deps.store.getTransfer(transferId, this.tenant());
    if (!persisted || persisted.state !== 'uploading') {
      if (persisted?.state === 'aborted') return this.transferStatus(transferId);
      throw new ArtifactTransferError('transfer_not_found', '传输不存在或已结束');
    }
    if (persisted.direction === 'upload') {
      if (persisted.tempPath) rmSync(persisted.tempPath, { force: true });
      this.transfers.delete(transferId);
      this.byOperation.delete(`${persisted.sessionId}:${persisted.operationId}`);
    } else {
      const active = this.downloads.get(transferId);
      if (active) this.closeDownload(active);
      this.downloads.delete(transferId);
    }
    this.deps.store.saveTransfer({ ...persisted, state: 'aborted' });
    const status = this.transferStatus(transferId);
    this.deps.emit({
      type: 'artifact_transfer_status',
      ...status,
      reason,
    });
    return status;
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

  artifactPath(sessionId: string, artifactId: string): { path: string; artifact: { name: string; mimeType: string; size: number } } | undefined {
    const artifact = this.deps.store.getArtifact(artifactId, this.tenant());
    if (!artifact || artifact.sessionId !== sessionId) return undefined;
    const path = join(this.root, artifact.storageKey);
    if (!statSync(path, { throwIfNoEntry: false })) return undefined;
    return {
      path,
      artifact: { name: artifact.name, mimeType: artifact.mimeType, size: artifact.size },
    };
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
    const active = this.downloads.get(transferId);
    if (active) {
      this.closeDownload(active);
      this.downloads.delete(transferId);
    }
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
      fd: openSync(path, 'r'),
    };
    this.downloads.set(transferId, transfer);
    try {
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
        nextOffset: transfer.offset,
        size: artifact.size,
        sha256: artifact.sha256,
        chunkSize,
      });
      if (transfer.offset >= artifact.size) {
        this.closeDownload(transfer);
        this.downloads.delete(transferId);
        this.deps.store.deleteTransfer(transferId, this.tenant());
        this.deps.emit({ type: 'artifact_download_result', transferId, status: 'completed' });
      } else {
        this.sendNextDownloadChunk(transfer);
      }
      return { transferId, size: artifact.size, sha256: artifact.sha256, chunkSize };
    } catch (error) {
      try {
        this.closeDownload(transfer);
      } finally {
        this.downloads.delete(transferId);
      }
      throw error;
    }
  }

  ackDownload(input: { transferId: string; nextOffset: number }): void {
    const transfer = this.downloads.get(input.transferId);
    if (!transfer) throw new ArtifactTransferError('transfer_not_found', '下载传输不存在或已结束');
    const expected = transfer.offset + transfer.lastLength;
    if (input.nextOffset !== expected) {
      try {
        this.closeDownload(transfer);
      } finally {
        this.downloads.delete(transfer.transferId);
      }
      throw new ArtifactTransferError(
        'out_of_order',
        `chunk ack offset ${input.nextOffset} != expected ${expected}`,
      );
    }
    try {
      this.deps.store.updateTransferOffset(transfer.transferId, input.nextOffset, this.tenant());
      transfer.offset = input.nextOffset;
      if (transfer.offset >= transfer.size) {
        this.closeDownload(transfer);
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
    } catch (error) {
      try {
        this.closeDownload(transfer);
      } finally {
        this.downloads.delete(transfer.transferId);
      }
      throw error;
    }
  }

  private sendNextDownloadChunk(transfer: DownloadTransfer): void {
    try {
      if (transfer.fd === undefined) throw new ArtifactTransferError('artifact_read_failed', '附件文件句柄已关闭');
      const length = Math.min(transfer.chunkSize, transfer.size - transfer.offset);
      const { bytes: chunk, bytesRead } = this.readRange(transfer.fd, length, transfer.offset);
      if (bytesRead !== length) throw new ArtifactTransferError('artifact_read_failed', '附件读取长度不足');
      transfer.lastLength = bytesRead;
      this.deps.emit({
        type: 'artifact_download_chunk',
        transferId: transfer.transferId,
        offset: transfer.offset,
        data: chunk.toString('base64'),
        chunkSha256: this.sha256Bytes(chunk),
      });
    } catch (error) {
      try {
        this.closeDownload(transfer);
      } finally {
        this.downloads.delete(transfer.transferId);
      }
      throw error;
    }
  }

  completeUpload(input: { transferId: string; size: number; sha256: string }): {
    committed: boolean;
    artifactId?: string;
    eventSeq?: number;
    sha256?: string;
  } {
    const persisted = this.deps.store.getTransfer(input.transferId, this.tenant());
    if (persisted?.state === 'committed') {
      if (input.size !== persisted.size || input.sha256.toLowerCase() !== persisted.sha256) {
        throw new ArtifactTransferError('conflict', 'committed 重放参数与原传输不一致');
      }
      const artifact = this.deps.store.getArtifact(persisted.artifactId, this.tenant());
      const event = this.deps.store.getArtifactEvent(persisted.sessionId, persisted.artifactId, this.tenant());
      return {
        committed: true,
        artifactId: artifact?.artifactId ?? persisted.artifactId,
        eventSeq: event?.eventSeq,
        sha256: persisted.sha256,
      };
    }
    let transfer = this.transfers.get(input.transferId);
    if (!transfer && persisted?.state === 'uploading' && persisted.direction === 'upload' && persisted.tempPath) {
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
    if (!transfer) throw new ArtifactTransferError('transfer_not_found', '传输不存在或已结束');
    if (input.size !== transfer.size || transfer.nextOffset !== transfer.size) {
      throw new ArtifactTransferError('size_mismatch', '文件大小与声明不一致');
    }
    const storageKey = `${this.tenant()}/sha256/${transfer.sha256.slice(0, 2)}/${transfer.sha256}`;
    const target = join(this.root, storageKey);
    const tempExists = Boolean(statSync(transfer.tempPath, { throwIfNoEntry: false }));
    const targetExists = Boolean(statSync(target, { throwIfNoEntry: false }));
    if (!tempExists && !targetExists) {
      throw new ArtifactTransferError('artifact_missing', '上传临时文件与 CAS 内容均不存在');
    }
    // rename 后崩溃也可恢复：从已存在的 CAS 文件重新流式校验，再补 DB 事务。
    const actual = this.sha256File(targetExists ? target : transfer.tempPath);
    if (actual !== transfer.sha256 || input.sha256.toLowerCase() !== actual) {
      throw new ArtifactTransferError('file_hash_mismatch', '整文件 SHA-256 不匹配');
    }
    mkdirSync(dirname(target), { recursive: true });
    if (!targetExists) renameSync(transfer.tempPath, target);
    else if (tempExists) rmSync(transfer.tempPath, { force: true });
    const { artifact, event } = this.deps.store.commitArtifact(
      {
        tenantId: this.tenant(),
        artifactId: transfer.artifactId,
        sessionId: transfer.sessionId,
        name: transfer.name,
        mimeType: transfer.mimeType,
        size: transfer.size,
        sha256: actual,
        kind: 'attachment',
        storageKey,
      },
      transfer.transferId,
    );
    this.transfers.delete(transfer.transferId);
    this.byOperation.delete(`${transfer.sessionId}:${transfer.operationId}`);
    try {
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
    } catch {
      // DB/CAS 已 committed；发送失败由快照/重试恢复，不能把结果翻转成 failed。
    }
    return { committed: true, artifactId: artifact.artifactId, eventSeq: event.eventSeq, sha256: artifact.sha256 };
  }
}
