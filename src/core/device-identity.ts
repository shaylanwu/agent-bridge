export const DEVICE_ID_PATTERN = /^bd_(?:[0-9a-f]{32}|[0-9a-f]{12})$/;

export type IdentitySource = 'created' | 'migrated' | 'reused';
export type DeviceIdentity = { deviceId: string; source: IdentitySource };

export interface DeviceIdCandidate {
  source: string;
  value: unknown;
}

export function assertDeviceId(value: unknown): string {
  if (typeof value !== 'string' || !DEVICE_ID_PATTERN.test(value)) {
    throw new Error('设备 ID 格式无效：应为 bd_ 加 32 或 12 位小写十六进制字符。');
  }
  return value;
}

export function resolveDeviceIdCandidate(candidates: readonly DeviceIdCandidate[]): string | undefined {
  let resolved: string | undefined;
  let resolvedSource: string | undefined;

  for (const candidate of candidates) {
    if (candidate.value === undefined) continue;
    const deviceId = assertDeviceId(candidate.value);
    if (resolved !== undefined && resolved !== deviceId) {
      throw new Error(`本地设备身份冲突：${resolvedSource ?? '已有身份'}与${candidate.source}不一致；请核对后重试。`);
    }
    resolved = deviceId;
    resolvedSource = candidate.source;
  }

  return resolved;
}
