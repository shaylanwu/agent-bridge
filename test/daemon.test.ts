import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { isPidAlive, readDaemonPid } from '../src/commands/daemon.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

describe('daemon pid helpers', () => {
  it('读取合法 pid，非法/不存在返回 undefined', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-daemon-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'daemon.pid');
    writeFileSync(file, '12345\n');
    expect(readDaemonPid(file)).toBe(12345);
    writeFileSync(file, 'nope');
    expect(readDaemonPid(file)).toBeUndefined();
    expect(readDaemonPid(join(dir, 'missing'))).toBeUndefined();
  });

  it('当前进程存活，不存在的 pid 不存活', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(999_999_999)).toBe(false);
  });
});
