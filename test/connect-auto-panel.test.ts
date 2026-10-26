import { beforeEach, describe, expect, it, vi } from 'vitest';

const startPanel = vi.fn();
const startControlPlane = vi.fn();
const closeSession = vi.fn();

vi.mock('../src/cli/panel.js', () => ({
  startPanel: (...args: unknown[]) => startPanel(...args),
  panelLog: () => () => undefined,
}));
vi.mock('../src/app/bootstrap.js', () => ({
  startBridge: async () => ({
    session: {
      emitter: {},
      registry: {},
      store: {},
      artifacts: {},
      close: closeSession,
    },
    config: {
      platformUrl: 'http://127.0.0.1:5173',
      controlPlane: { enabled: false, host: '127.0.0.1', port: 8787 },
    },
  }),
}));
vi.mock('../src/transport/control-plane.js', () => ({
  startControlPlane: (settings: { port: number }) => startControlPlane(settings),
}));
vi.mock('../src/infra/profile-lock.js', () => ({
  acquireBridgeRuntimeLock: async () => ({ release: async () => undefined }),
}));
vi.mock('../src/cli/hold.js', () => ({
  hold: async (cleanup: () => void | Promise<void>) => {
    await cleanup();
  },
}));

import { cmdConnect } from '../src/commands/connect.js';

function addrInUse(): Error {
  const error = new Error('listen EADDRINUSE') as NodeJS.ErrnoException;
  error.code = 'EADDRINUSE';
  return error;
}

describe('connect 默认本机 Web 面板', () => {
  beforeEach(() => {
    startPanel.mockReset();
    startControlPlane.mockReset();
    closeSession.mockReset();
    startPanel.mockReturnValue({ stop: () => undefined, printLine: () => undefined });
  });

  it('8787 被占用时自动使用 8788', async () => {
    startControlPlane.mockImplementation(async (settings: { port: number }) => {
      if (settings.port === 8787) throw addrInUse();
      return { url: `http://127.0.0.1:${settings.port}`, close: () => undefined };
    });

    await cmdConnect({} as never);

    expect(startControlPlane.mock.calls.map((call) => (call[0] as { port: number }).port)).toEqual([
      8787, 8788,
    ]);
    expect(startPanel.mock.calls[0]?.[0]).toMatchObject({
      webUrl: expect.stringContaining('http://127.0.0.1:8788/?token='),
    });
    expect(closeSession).toHaveBeenCalledTimes(1);
  });
});
