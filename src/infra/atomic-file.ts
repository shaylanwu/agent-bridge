import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, link, mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export type AtomicWriteResult = 'written' | 'exists';

export interface AtomicWriteOptions {
  /** false 使用 hard link 做不覆盖发布；默认 true 使用 rename 原子替换。 */
  overwrite?: boolean;
}

function codeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'UNKNOWN';
}

function atomicError(filePath: string, operation: string, error: unknown, published: boolean): Error {
  const outcome = published
    ? '目标可能已发布，但目录持久化状态不确定；请先读回核对，勿删除目标文件。'
    : '旧文件未被替换；请检查父目录权限和可用存储后重试。';
  return new Error(`原子文件操作失败（${operation}，${codeOf(error)}）：${filePath}。${outcome}`);
}

function runSystem(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { encoding: 'utf8', windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function windowsSystemTool(name: string): string {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', name);
}

async function secureWindowsFile(filePath: string): Promise<void> {
  const identity = await runSystem(windowsSystemTool('whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
  const sid = identity.match(/"(S-1-\d+(?:-\d+)*)"/)?.[1];
  if (!sid) throw new Error('无法确认当前 Windows 用户 SID');

  await runSystem(windowsSystemTool('icacls.exe'), [
    filePath,
    '/inheritance:r',
    '/grant:r',
    `*${sid}:(F)`,
    '*S-1-5-18:(F)',
  ]);
}

async function secureTemporaryFile(filePath: string): Promise<void> {
  if (process.platform === 'win32') {
    await secureWindowsFile(filePath);
    return;
  }

  await chmod(filePath, 0o600);
  if (((await stat(filePath)).mode & 0o777) !== 0o600) {
    throw new Error('无法确认临时文件权限为 0600');
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeAtomicFile(
  filePath: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<AtomicWriteResult> {
  const directory = dirname(filePath);
  const temporaryPath = join(directory, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let published = false;
  let operation = '创建父目录';

  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    operation = '创建临时文件';
    handle = await open(temporaryPath, 'wx', 0o600);
    operation = '写入临时文件';
    await handle.writeFile(content, 'utf8');
    operation = 'fsync 临时文件';
    await handle.sync();
    operation = '关闭临时文件';
    await handle.close();
    handle = undefined;
    operation = '设置临时文件权限';
    await secureTemporaryFile(temporaryPath);

    if (options.overwrite === false) {
      operation = '不覆盖发布';
      try {
        await link(temporaryPath, filePath);
      } catch (error) {
        if (codeOf(error) === 'EEXIST') return 'exists';
        throw error;
      }
    } else {
      operation = '原子替换';
      await rename(temporaryPath, filePath);
    }
    published = true;

    operation = 'fsync 父目录';
    await syncDirectory(directory);
    return 'written';
  } catch (error) {
    throw atomicError(filePath, operation, error, published);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    if (!published) await unlink(temporaryPath).catch(() => undefined);
  }
}
