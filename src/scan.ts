/**
 * 扫描调度：并发探测 11 个工具 + 30s TTL 缓存 + 逐项回调（实时回传）
 *
 * 为什么要并发：单个工具一次 `--version` 子进程（Windows 上还要过 cmd 垫片），串行实测 12.8s（空载）～
 * 25.7s（机器繁忙），期间事件循环被占住、WS 心跳与入站指令全被推迟。改为并发上限 4 后落到秒级。
 *
 * 为什么要 onItem：平台侧是卡片式展示，一次性丢 11 条会「一直空着 → 突然全亮」。逐项回调让平台
 * 每完成一个就推一条 `scan_progress`（见 cli.ts），终态再发全量 `agent_list` / `scan_result`。
 */

import { AGENTS, probeAgent } from './agent-adapters.js';
import type { AgentListItem } from './protocol.js';

const TTL_MS = 30_000;
/** 并发上限：11 个子进程全开会在低配机器上抢 CPU，4 个是实测的平衡点 */
const CONCURRENCY = 6;

let cache: { at: number; items: AgentListItem[] } | null = null;

export interface ScanOptions {
  /** 绕过缓存（平台点「立即扫描」/ CLI `status --fresh`） */
  fresh?: boolean;
  /** 每完成一个适配器回调一次（含未安装项），用于实时回传 */
  onItem?: (item: AgentListItem) => void;
}

export async function scanAgents(opts: ScanOptions = {}): Promise<AgentListItem[]> {
  if (!opts.fresh && cache && Date.now() - cache.at < TTL_MS) {
    // 命中缓存：不再探测，但仍逐项回调，保证调用方拿到的进度序列是完整的
    if (opts.onItem) for (const item of cache.items) opts.onItem(item);
    return cache.items;
  }

  const items = new Array<AgentListItem>(AGENTS.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const def = AGENTS[index];
      if (!def) return;
      let item: AgentListItem;
      try {
        item = await probeAgent(def);
      } catch {
        // 一个工具探测炸了不能拖垮整次扫描
        item = {
          kind: def.kind,
          display: def.display,
          status: 'not_installed',
          capability: def.capability,
        };
      }
      items[index] = item;
      opts.onItem?.(item);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, AGENTS.length) }, worker));
  cache = { at: Date.now(), items };
  return items;
}

export function invalidateScanCache(): void {
  cache = null;
}
