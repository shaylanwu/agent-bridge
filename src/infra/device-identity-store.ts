import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parse as parseToml } from 'smol-toml';
import {
  assertDeviceId,
  resolveDeviceIdCandidate,
  type DeviceIdCandidate,
  type DeviceIdentity,
} from '../core/device-identity.js';
import { writeAtomicFile } from './atomic-file.js';

export interface EnsureDeviceIdentityOptions {
  identityPath: string;
  legacyDeviceId?: string;
  explicitDeviceId?: string;
  envDeviceId?: string;
  allowCreate: boolean;
  hasReusableCredential: boolean;
}

function codeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'UNKNOWN';
}

async function readStoredDeviceId(identityPath: string): Promise<string | undefined> {
  let content: string;
  try {
    content = await readFile(identityPath, 'utf8');
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return undefined;
    throw new Error(`无法读取设备身份文件（${codeOf(error)}）：${identityPath}；请检查权限，禁止以新身份替代。`);
  }

  let raw: unknown;
  try {
    raw = parseToml(content);
  } catch {
    throw new Error(`设备身份文件损坏或无效：${identityPath}；请修复 TOML，禁止以新身份替代。`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`设备身份文件结构无效：${identityPath}；请保留 schema_version = 1 和有效 device_id。`);
  }

  const record = raw as Record<string, unknown>;
  if (record['schema_version'] !== 1) {
    throw new Error(`设备身份 schema 不支持：${identityPath}；仅支持 schema_version = 1。`);
  }
  try {
    return assertDeviceId(record['device_id']);
  } catch {
    throw new Error(`设备身份文件中的 device_id 无效：${identityPath}；请修复格式，禁止以新身份替代。`);
  }
}

function suppliedCandidates(options: EnsureDeviceIdentityOptions): DeviceIdCandidate[] {
  return [
    { source: '旧配置镜像', value: options.legacyDeviceId },
    { source: '显式参数', value: options.explicitDeviceId },
    { source: '环境变量', value: options.envDeviceId },
  ];
}

async function reuseIdentity(
  identityPath: string,
  storedDeviceId: string,
  options: EnsureDeviceIdentityOptions,
): Promise<DeviceIdentity> {
  const deviceId = resolveDeviceIdCandidate([
    { source: 'identity.toml', value: storedDeviceId },
    ...suppliedCandidates(options),
  ]);
  if (deviceId === undefined) throw new Error(`设备身份文件为空：${identityPath}`);
  return { deviceId, source: 'reused' };
}

export async function ensureDeviceIdentity(options: EnsureDeviceIdentityOptions): Promise<DeviceIdentity> {
  if (!options.identityPath) throw new Error('必须提供设备身份文件路径。');

  const stored = await readStoredDeviceId(options.identityPath);
  if (stored !== undefined) return reuseIdentity(options.identityPath, stored, options);

  const migrated = resolveDeviceIdCandidate(suppliedCandidates(options));

  // 锁不是身份正确性的前提：生成或迁移前再次读取，缩小并发窗口。
  const reread = await readStoredDeviceId(options.identityPath);
  if (reread !== undefined) return reuseIdentity(options.identityPath, reread, options);

  let deviceId = migrated;
  if (deviceId === undefined) {
    if (options.hasReusableCredential) {
      throw new Error('身份文件不存在但存在可复用凭证；请恢复身份或提供既有设备 ID，禁止随机生成。');
    }
    if (!options.allowCreate) {
      throw new Error('身份文件不存在且没有可迁移 ID；请提供显式设备 ID，禁止随机生成。');
    }
    deviceId = `bd_${randomBytes(16).toString('hex')}`;
  }

  const result = await writeAtomicFile(
    options.identityPath,
    `schema_version = 1\ndevice_id = "${deviceId}"\n`,
    { overwrite: false },
  );
  if (result === 'exists') {
    const published = await readStoredDeviceId(options.identityPath);
    if (published === undefined) throw new Error(`设备身份发布后无法读回：${options.identityPath}`);
    return reuseIdentity(options.identityPath, published, options);
  }

  return { deviceId, source: migrated === undefined ? 'created' : 'migrated' };
}
