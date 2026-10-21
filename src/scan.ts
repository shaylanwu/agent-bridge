/**
 * 扫描调度：并发探测 11 个工具 + 30s TTL 缓存
 *
 * 为什么要有缓存：每个工具一次 `--version` 子进程（Windows 上还要过 cmd 垫片），
 * 全量扫一遍几百毫秒到几秒；页面轮询/平台下发 scan 时不能每次都重扫。
 */

import { AGENTS, probeAgent } from './agent-adapters.js';
import type { AgentListItem } from './protocol.js';

const TTL_MS = 30_000;

let cache: { at: number; items: AgentListItem[] } | null = null;

export interface ScanOptions {
  /** 绕过缓存（平台点「立即扫描」/ CLI `status --fresh`） */
  fresh?: boolean;
}

export async function scanAgents(opts: ScanOptions = {}): Promise<AgentListItem[]> {
  if (!opts.fresh && cache && Date.now() - cache.at < TTL_MS) return cache.items;
  // probeAgent 是同步阻塞的（execFileSync），这里用 microtask 让出一次事件循环，
  // 真正的并发在平台侧是多个 bridge 实例，不是单进程内并行。
  const items = AGENTS.map((def) => {
    try {
      return probeAgent(def);
    } catch {
      return {
        kind: def.kind,
        display: def.display,
        status: 'not_installed' as const,
        capability: def.capability,
      };
    }
  });
  cache = { at: Date.now(), items };
  return items;
}

export function invalidateScanCache(): void {
  cache = null;
}
