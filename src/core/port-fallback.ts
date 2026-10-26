/**
 * 端口顺延：本机面板默认端口被占用时，从 base 起逐个尝试。
 * 只对 EADDRINUSE 顺延；其它错误立即抛出，避免把权限/配置问题伪装成“端口占用”。
 */
export function isAddrInUse(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
  );
}

export async function withPortFallback<T>(
  basePort: number,
  attempts: number,
  start: (port: number) => Promise<T>,
): Promise<T | undefined> {
  for (let offset = 0; offset < attempts; offset += 1) {
    try {
      return await start(basePort + offset);
    } catch (error) {
      if (isAddrInUse(error)) continue;
      throw error;
    }
  }
  return undefined;
}
