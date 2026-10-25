import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mkdirMock, openMock, unlinkMock } = vi.hoisted(() => ({
  mkdirMock: vi.fn(),
  openMock: vi.fn(),
  unlinkMock: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  mkdir: mkdirMock,
  open: openMock,
  unlink: unlinkMock,
}));

import { withProfileLock } from '../src/infra/profile-lock.js';

describe('profile lock 获取失败清理边界', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mkdirMock.mockResolvedValue(undefined);
    unlinkMock.mockResolvedValue(undefined);
    openMock.mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
  });

  it('打开锁失败时不删除并非本进程创建的锁', async () => {
    await expect(withProfileLock('C:\\temp\\agent-bridge-lock-error', async () => undefined)).rejects.toThrow(
      /获取 profile 锁失败/,
    );

    expect(unlinkMock).not.toHaveBeenCalled();
  });
});
