/**
 * 前台保活（CLI 支撑件）
 *
 * 长驻命令（`connect` / `serve`）最后都要：注册退出信号 → 优雅关闭 → 永不 resolve。
 * 抽出来是因为两个命令都要，写两遍必然慢慢写歪。
 */

export function hold(close: () => void): Promise<void> {
  const bye = (): void => {
    close();
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  return new Promise<void>(() => undefined);
}
