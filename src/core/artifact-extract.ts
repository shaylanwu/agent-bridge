/**
 * 产物提取的路径安全（tasks.md 4.9；spec「附件路径安全」）
 *
 * 规则（design §task_artifact）：
 *  - 只接受 adapter **明确声明**的 artifact 事件读取文件；模型给的 toolCall.location/title
 *    不得作为读取依据；无结构化 artifact 事件时仅从 changedFiles 生成**元数据**，不读取内容
 *    （元数据路径在 dispatch 层，见 emitChangedFileArtifacts）；
 *  - 读取根 = 该任务 cwd 的 **realpath 子树**（allowed_cwd 只决定任务能否启动，不是读取根）；
 *  - realpath 解析后必须仍在根内 —— 拒绝 `..`、绝对路径、目录、符号链接/junction 逃逸、凭据路径；
 *  - 同一 fd 打开 → fstat 定尺寸 → 从该 fd 读取并计算 SHA-256。
 *    POSIX 可用 O_NOFOLLOW；Windows 无对应物，以「realpath 前置检查 + 单 fd 读取」为等价实现
 *    （realpath 已解析全部链接，fd 打开的是解析结果，二者之间不存在二次解析窗口）；
 *  - inline 上限内返回 content；超上限只给 sha256/size —— 内容不塞消息（大文件由
 *    artifact transfer 分块传输，内容存 CAS）。
 */

import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';

/** 凭据路径模式：相对路径任一段命中即拒绝（目录名或文件名） */
const CREDENTIAL_SEGMENTS = new Set([
  '.ssh',
  '.aws',
  '.gcloud',
  '.azure',
  '.kube',
  '.gnupg',
  '.docker',
]);
const CREDENTIAL_FILE_PATTERN =
  /(^|[/\\])(\.env(\..+)?|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|credentials|\.npmrc|\.netrc|\.pypirc|secrets?\.(yaml|yml|json|txt)|service[-_]?account[^/\\]*\.json)$/i;

/** 判定产物相对路径是否落在凭据位置（即使物理上在 cwd 内也不上行） */
export function isCredentialPath(rel: string): boolean {
  const normalized = rel.replaceAll('\\', '/');
  const segments = normalized.split('/').filter((s) => s.length > 0);
  for (const segment of segments) {
    if (CREDENTIAL_SEGMENTS.has(segment.toLowerCase())) return true;
  }
  return CREDENTIAL_FILE_PATTERN.test(normalized);
}

/** 常见扩展名 → MIME（未知给 octet-stream，不做内容嗅探） */
const MIME_BY_EXT: Record<string, string> = {
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  csv: 'text/csv',
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  ts: 'text/javascript',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
};

export function mimeTypeOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return 'application/octet-stream';
  return MIME_BY_EXT[name.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream';
}

export type WithinCwdResult = { ok: true; abs: string } | { ok: false; reason: string };

/**
 * 读取根检查：cwd 的 realpath 子树内的**文件**才允许读取。
 * 检查顺序：相对路径约束 → 凭据路径 → realpath 收敛 → 非目录。
 */
export function resolveWithinCwd(cwd: string, rel: string): WithinCwdResult {
  if (!rel || typeof rel !== 'string') return { ok: false, reason: 'empty_path' };
  // 绝对路径不是「cwd 下的相对产物」——拒绝（避免与根内同名文件的歧义）
  if (isAbsolute(rel)) return { ok: false, reason: 'absolute_path' };
  const normalized = rel.replaceAll('\\', '/');
  const segments = normalized.split('/');
  // `..` 段一律拒绝（不管折返后是否仍在根内 —— 产物路径没有理由包含上跳）
  if (segments.some((s) => s === '..')) return { ok: false, reason: 'parent_escape' };
  if (isCredentialPath(normalized)) return { ok: false, reason: 'credential_path' };

  const root = realpathSync(cwd);
  const target = join(root, normalized);
  let resolved: string;
  let stats: { isFile(): boolean };
  try {
    // realpath 解析所有符号链接/junction：解析结果仍在根内 ⇒ 无链接逃逸
    resolved = realpathSync(target);
    stats = statSync(resolved);
  } catch {
    return { ok: false, reason: 'not_found' };
  }
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    return { ok: false, reason: 'symlink_escape' };
  }
  if (!stats.isFile()) return { ok: false, reason: 'not_a_file' };
  return { ok: true, abs: resolved };
}

export interface ReadArtifactOptions {
  /** inline 上限（字节）：以内带 content，以上只给 size/sha256 */
  inlineMaxBytes: number;
}

export interface ReadArtifactResult {
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  /** 仅 size ≤ inlineMaxBytes 时携带 */
  content?: Buffer;
}

/**
 * 从任务 cwd 子树安全读取一个产物文件：路径检查通过后以同一 fd
 * fstat 定尺寸、逐块读取并计算 SHA-256。文件不存在/被清理时返回 undefined（不是错误）。
 * 调用前提：调用方已确认这是 adapter 明确事件或用户显式指定的文件（见模块注释）。
 */
export function readArtifactFile(cwd: string, rel: string, opts: ReadArtifactOptions): ReadArtifactResult | undefined {
  const within = resolveWithinCwd(cwd, rel);
  if (!within.ok) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(within.abs, 'r');
    const stats = fstatSync(fd);
    if (!stats.isFile()) return undefined;
    const size = stats.size;
    const inline = size <= opts.inlineMaxBytes;
    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    const readBuffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, size)));
    let read = 0;
    while (read < size) {
      const n = readSync(fd, readBuffer, 0, Math.min(readBuffer.length, size - read), read);
      if (n <= 0) break;
      hash.update(readBuffer.subarray(0, n));
      if (inline) chunks.push(Buffer.from(readBuffer.subarray(0, n)));
      read += n;
    }
    return {
      name: rel.replaceAll('\\', '/'),
      mimeType: mimeTypeOf(rel),
      size,
      sha256: hash.digest('hex'),
      ...(inline ? { content: Buffer.concat(chunks) } : {}),
    };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* 已关闭 */
      }
    }
  }
}
