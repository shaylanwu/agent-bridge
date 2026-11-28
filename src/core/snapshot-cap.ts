/**
 * `task_snapshot` 单响应的字节上限（规格：「单响应 1 MiB 是默认可配置安全策略」）。
 *
 * 为什么必须真的执行：快照会带上 `events`（含 `task_log`，一个任务十几万字节日志很常见）。
 * 一次给几百条带日志的事件，单帧就能到几 MB —— WS 心跳、平台解析、代理缓冲都会受影响，
 * 极端情况下直接断连。分页本来就该由平台按 `hasMoreBefore` + `afterEventSeq` 续取。
 *
 * 裁剪方向是**保住最新的**：平台要的是「现在是什么状态」，越新的越有用；
 * 被裁掉的是更早的部分，由 `hasMoreBefore: true` 告诉它「更早还有货，往前翻」。
 * 绝不裁剪字段内容（那会变成静默丢数据），只裁剪**保留哪几条事件**。
 */

export const SNAPSHOT_MAX_BYTES = 1024 * 1024;

/** 单条事件的 JSON 字节数（含分隔逗号） */
function bytesOf(event: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(event) ?? '', 'utf8') + 1;
  } catch {
    return 1; // 不可序列化（循环引用）的 payload：不占预算，交给上游序列化报错
  }
}

/**
 * 从**尾部**往回装事件，装不下为止。
 * 至少保留一条：返回空 events 会让平台以为「这任务没有任何事件」，比稍微超限更误导。
 */
export function capEventsByBytes<T>(events: readonly T[], budgetBytes: number): { kept: T[]; truncated: boolean } {
  if (events.length === 0) return { kept: [], truncated: false };
  let total = 0;
  let firstKept = events.length;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const size = bytesOf(events[i]);
    if (total + size > budgetBytes && firstKept < events.length) break;
    total += size;
    firstKept = i;
  }
  return { kept: events.slice(firstKept), truncated: firstKept > 0 };
}
