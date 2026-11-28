/**
 * Vitest 配置（只调超时，不改解析/收集规则）
 *
 * 为什么需要这个文件：测试里有相当一批是**真实文件读写**（临时 state 目录 + Windows 文件锁重试 +
 * SQLite WAL）。单跑每个用例 100~400ms，但 43 个文件并行跑时 CPU 抢占会把个别用例拖到 5s 默认超时以上，
 * 表现为「随机某一个 fs 用例超时」（实测先后在 config / device-identity 上各出现一次）。
 * 这类超时是测速问题，不是产品缺陷 —— 与其挨个文件打补丁，不如把默认预算调到与机器负载无关的量级。
 *
 * 刻意不设 `include` / `environment` / 路径别名：保持 vitest 默认行为，避免与既有 43 个文件漂移。
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 30_000,
    /**
     * 并行度上限（默认 = CPU 核数）。
     *
     * 为什么必须封顶：本机 16 核、而 `npm test` 里有**真实子进程**用例
     *（`e2e-device-identity` 跑真 `dist/cli.js`、`e2e-ws-dispatch` 跑假 ACP 子进程、
     * `bridge.test.ts` 跑 git）。满载机器上默认并行度会把这些文件挤到互相等待，
     * 现象是「用例全部报完却不退出」——实测挂过 10 分钟以上，`--maxWorkers=4` 后同样
     * 71 个文件 760 passed 只要 **14 秒**。
     *
     * 4 是「够快且不抢」的值：CI 的 2~4 核本来就跑不到更高，行为不变。
     */
    maxWorkers: 4,
  },
});
