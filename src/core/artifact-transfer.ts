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
    this.transfers.set(transferId, {
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
    });
    this.byOperation.set(key, transferId);
    return { transferId, artifactId, nextOffset: 0, chunkSize };
  }

  writeChunk(input: {
    transferId: string;
    offset: number;
    data: string;
    chunkSha256: string;
  }): { nextOffset: number } {
    const transfer = this.transfers.get(input.transferId);
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
    return { nextOffset: transfer.nextOffset };
  }

  startDownload(input: {
    sessionId: string;
    artifactId: string;
    chunkSize?: number;
  }): { transferId: string; size: number; sha256: string; chunkSize: number } {
    const artifact = this.deps.store.getArtifact(input.artifactId);
    if (!artifact || artifact.sessionId !== input.sessionId) {
      throw new ArtifactTransferError('artifact_not_found', `附件不存在：${input.artifactId}`);
    }
    const path = join(this.root, artifact.storageKey);
    if (!statSync(path, { throwIfNoEntry: false })) {
      throw new ArtifactTransferError('artifact_missing', '附件内容不在 CAS 中');
    }
    const transferId = `dt_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const chunkSize = Math.min(
      MAX_CHUNK_SIZE,
      Math.max(1, Math.floor(input.chunkSize ?? DEFAULT_CHUNK_SIZE)),
    );
    const transfer: DownloadTransfer = {
      transferId,
      artifactId: artifact.artifactId,
      sessionId: input.sessionId,
      path,
      size: artifact.size,
      sha256: artifact.sha256,
      chunkSize,
      offset: 0,
      lastLength: 0,
    };
    this.downloads.set(transferId, transfer);
    this.deps.emit({
      type: 'artifact_download_ready',
      transferId,
      artifactId: artifact.artifactId,
      size: artifact.size,
      sha256: artifact.sha256,
      chunkSize,
    });
    if (artifact.size === 0) {
      this.downloads.delete(transferId);
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
    if (transfer.offset >= transfer.size) {
      this.downloads.delete(transfer.transferId);
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
      return { committed: true, artifactId: artifact.artifactId, eventSeq: event.eventSeq };
    } catch (error) {
      this.transfers.delete(transfer.transferId);
      this.byOperation.delete(`${transfer.sessionId}:${transfer.operationId}`);
      rmSync(transfer.tempPath, { force: true });
      throw error;
    }
  }
}
