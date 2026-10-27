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
  },
});
