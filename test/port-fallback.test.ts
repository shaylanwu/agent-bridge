import { describe, expect, it } from 'vitest';
import { withPortFallback } from '../src/core/port-fallback.js';

function addrInUse(): Error {
  const error = new Error('listen EADDRINUSE') as NodeJS.ErrnoException;
  error.code = 'EADDRINUSE';
  return error;
}

describe('withPortFallback', () => {
  it('端口占用时从 8787 起顺延', async () => {
    const tried: number[] = [];
    const result = await withPortFallback(8787, 5, async (port) => {
      tried.push(port);
      if (port <= 8788) throw addrInUse();
      return `http://127.0.0.1:${port}`;
    });
    expect(tried).toEqual([8787, 8788, 8789]);
    expect(result).toBe('http://127.0.0.1:8789');
  });

  it('其它错误立即抛出，不把权限问题当成端口占用', async () => {
    await expect(
      withPortFallback(8787, 5, async () => {
        throw new Error('EACCES');
      }),
    ).rejects.toThrow('EACCES');
  });

  it('全部占用返回 undefined', async () => {
    await expect(
      withPortFallback(8787, 2, async () => {
        throw addrInUse();
      }),
    ).resolves.toBeUndefined();
  });
});
