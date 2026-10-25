import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';

interface LockRecord {
  ownerToken: string;
  pid: number;
  hostname: string;
  createdAt: string;
}

interface HeldLock {
  path: string;
  ownerToken: string;
}

const processQueues = new Map<string, Promise<void>>();

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function busyError(lockPath: string): Error {
  return new Error(`该 profile 已有绑定进行中：${lockPath}；请等待其完成，或确认无绑定进程后人工处理锁文件。`);
}

function unsafeError(lockPath: string, detail: string): Error {
  return new Error(`无法安全回收 profile 锁：${lockPath}。${detail}；请确认无绑定进程后人工删除该锁文件。`);
}

function parseLockRecord(text: string, lockPath: string): LockRecord {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw unsafeError(lockPath, '锁记录不是有效 JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw unsafeError(lockPath, '锁记录结构无效');
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record['ownerToken'] !== 'string' || record['ownerToken'].length === 0
    || typeof record['pid'] !== 'number' || !Number.isInteger(record['pid']) || record['pid'] <= 0
    || typeof record['hostname'] !== 'string' || record['hostname'].length === 0
    || typeof record['createdAt'] !== 'string' || Number.isNaN(Date.parse(record['createdAt']))
  ) {
    throw unsafeError(lockPath, '锁记录缺少有效 ownerToken/pid/hostname/createdAt');
  }
  return {
    ownerToken: record['ownerToken'],
    pid: record['pid'],
    hostname: record['hostname'],
    createdAt: record['createdAt'],
  };
}

async function withRecoveryGuard<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const guardPath = `${lockPath}.recovery`;
  const ownerToken = randomUUID();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let createdByUs = false;
  try {
    handle = await open(guardPath, 'wx', 0o600);
    createdByUs = true;
    await handle.writeFile(ownerToken, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    if (createdByUs) await unlink(guardPath).catch(() => undefined);
    if (errorCode(error) === 'EEXIST') throw busyError(lockPath);
    throw unsafeError(lockPath, `获取 stale 回收互斥失败（${errorCode(error) ?? 'UNKNOWN'}）`);
  }

  try {
    return await fn();
  } finally {
    try {
      const current = await readFile(guardPath, 'utf8');
      // guard 只允许短时的 stale 判定/删除临界区使用；不自动强拆，避免递归竞态。
      if (current === ownerToken) await unlink(guardPath);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        throw unsafeError(lockPath, `释放 stale 回收互斥失败（${errorCode(error) ?? 'UNKNOWN'}）`);
      }
    }
  }
}

async function recoverStaleLock(lockPath: string): Promise<void> {
  await withRecoveryGuard(lockPath, async () => {
    let text: string;
    try {
      text = await readFile(lockPath, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      throw unsafeError(lockPath, `读取锁失败（${errorCode(error) ?? 'UNKNOWN'}）`);
    }
    const record = parseLockRecord(text, lockPath);
    if (record.hostname !== hostname()) throw unsafeError(lockPath, '锁属于其他主机，不能判断 PID 是否存活');

    let alive = true;
    try {
      process.kill(record.pid, 0);
    } catch (error) {
      if (errorCode(error) === 'ESRCH') alive = false;
      else if (errorCode(error) !== 'EPERM') {
        throw unsafeError(lockPath, `无法确认 PID ${record.pid} 状态（${errorCode(error) ?? 'UNKNOWN'}）`);
      }
    }
    if (alive) throw busyError(lockPath);

    let confirmed: string;
    try {
      confirmed = await readFile(lockPath, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      throw unsafeError(lockPath, `回收前重读锁失败（${errorCode(error) ?? 'UNKNOWN'}）`);
    }
    if (confirmed !== text) throw unsafeError(lockPath, 'stale 判断期间锁记录已变化');

    try {
      await unlink(lockPath);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        throw unsafeError(lockPath, `删除已确认 stale 锁失败（${errorCode(error) ?? 'UNKNOWN'}）`);
      }
    }
  });
}

async function acquireLock(stateDir: string, lockPath: string, record: LockRecord): Promise<HeldLock> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let createdByUs = false;
    try {
      handle = await open(lockPath, 'wx', 0o600);
      createdByUs = true;
      await handle.writeFile(JSON.stringify(record), 'utf8');
      await handle.sync();
      await handle.close();
      return { path: lockPath, ownerToken: record.ownerToken };
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      if (errorCode(error) !== 'EEXIST') {
        // open('wx') 失败时锁可能属于另一进程；只有自己已创建后才允许清理。
        if (createdByUs) await unlink(lockPath).catch(() => undefined);
        throw new Error(`获取 profile 锁失败（${errorCode(error) ?? 'UNKNOWN'}）：${lockPath}；请检查目录权限后重试。`);
      }
      await recoverStaleLock(lockPath);
    }
  }
  throw busyError(lockPath);
}

async function releaseLock(lock: HeldLock): Promise<void> {
  let text: string;
  try {
    text = await readFile(lock.path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw new Error(`释放 profile 锁前读取失败：${lock.path}；请核对锁 owner 后人工处理。`);
  }
  let current: unknown;
  try {
    current = JSON.parse(text);
  } catch {
    return;
  }
  if (typeof current !== 'object' || current === null || !('ownerToken' in current) || current.ownerToken !== lock.ownerToken) {
    return;
  }
  try {
    await unlink(lock.path);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw new Error(`释放 profile 锁失败：${lock.path}；请确认锁 owner 后人工处理。`);
    }
  }
}

async function runWithLock<T>(stateDir: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = join(stateDir, 'profile.lock');
  const record: LockRecord = {
    ownerToken: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    createdAt: new Date().toISOString(),
  };
  const lock = await acquireLock(stateDir, lockPath, record);
  try {
    return await fn();
  } finally {
    await releaseLock(lock);
  }
}

export async function withProfileLock<T>(stateDir: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(stateDir);
  const previous = processQueues.get(key) ?? Promise.resolve();
  const run = previous.then(() => runWithLock(key, fn));
  const tail = run.then(() => undefined, () => undefined);
  processQueues.set(key, tail);
  try {
    return await run;
  } finally {
    if (processQueues.get(key) === tail) processQueues.delete(key);
  }
}
