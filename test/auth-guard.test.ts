/**
 * headless 未登录挂死守卫单测（agy 实测驱动）
 *
 * agy 1.4.10 未登录时：stderr 立即打 `Authentication required…` / `Waiting for authentication (timeout 60s)…`，
 * 60s 后吐 `status:"ERROR"` 结果但进程不退出。守卫的职责 = 有界缓冲内模式命中 → kill + tool_no_credentials。
 * 这里穷举匹配语义（跨分片 / 无关 stderr / 缓冲有界），kill+settle 的胶水由 settle 幂等性保证。
 */

import { describe, expect, it } from 'vitest';
import { feedAuthGuard } from '../src/core/task-supervisor';
import { AGENTS } from '../src/adapters/agent-adapters';

const guard = AGENTS.find((a) => a.kind === 'agy')!.authGuard!;

describe('认证挂死守卫 feedAuthGuard', () => {
  it('agy 的守卫模式与 1.4.10 实测 stderr 前缀一致', () => {
    expect(guard.hint).toContain('agy');
    // 两条实测前缀；记忆里的 `Authentication required` 文本以实测为准
    expect(guard.patterns).toHaveLength(2);
  });

  it('完整命中：Authentication required 立即判定未登录', () => {
    const r = feedAuthGuard(guard, '', 'Authentication required. Please visit the URL to log in:\n');
    expect(r.hit).toBe(true);
  });

  it('模式跨 stderr 分片断裂也能命中（有界缓冲合并后匹配）', () => {
    let state = { buffer: '', hit: false };
    state = feedAuthGuard(guard, state.buffer, 'W');
    expect(state.hit).toBe(false);
    state = feedAuthGuard(guard, state.buffer, 'aiting for auth');
    expect(state.hit).toBe(false);
    state = feedAuthGuard(guard, state.buffer, 'entication (timeout 60s)...\n');
    expect(state.hit).toBe(true);
  });

  it('无关 stderr（工具报错里提到 auth）不误杀', () => {
    const r = feedAuthGuard(guard, '', 'error: upstream 401 auth token rejected by remote\n');
    expect(r.hit).toBe(false);
  });

  it('缓冲有界：超过 4KB 只保留最近内容（长噪声不撑内存）', () => {
    const noise = 'x'.repeat(6000);
    const r = feedAuthGuard(guard, noise, 'Authentication required');
    expect(r.buffer.length).toBeLessThanOrEqual(4096);
    expect(r.hit).toBe(true);
  });
});
