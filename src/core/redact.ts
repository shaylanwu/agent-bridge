/**
 * 日志脱敏（P1-2）
 *
 * 只做两件事，且只作用于 **task_log**（不能动 diff —— 那是要给人工审核的产物，动了就废了）：
 *  1. 本机家目录绝对路径 → `~`（AI CLI 的输出里常带绝对路径，属于隐私）；
 *  2. 长度 ≥64 的 base64 / hex 连续串 → 折叠（这类东西十有八九是密钥或 token）。
 *
 * 为什么单独一块：它是横切需求，日志、步骤 label、审计 detail 都要用同一份策略，
 * 各自写一份就会漂移。
 */

import { homedir } from 'node:os';

/** 长串阈值：短于此的普通标识符（文件名、hash 前缀）不动，避免误伤 */
export const LONG_SECRET_LEN = 64;
/** 折叠后保留的前缀长度（够定位，又不足以还原） */
const KEEP_PREFIX = 6;

/** base64 / base64url / hex 都会命中的字符集 */
const LONG_RUN_RE = /[A-Za-z0-9+/=_-]{64,}/g;

export interface RedactOptions {
  /** 要脱敏的家目录（默认取当前用户），传空串可关闭路径脱敏 */
  home?: string;
  /** 关闭长串折叠（例如只做路径脱敏的场景） */
  foldLongRuns?: boolean;
}

/**
 * 把 `home` 的出现替换成 `~`。
 * 用 split/join 而不是 RegExp：Windows 路径含 `\`，转义容易出错且没必要。
 */
export function maskHome(text: string, home: string): string {
  if (!home) return text;
  return text.split(home).join('~');
}

export function redact(text: string, opts: RedactOptions = {}): string {
  const home = opts.home === undefined ? homedir() : opts.home;
  let out = maskHome(text, home);
  if (opts.foldLongRuns !== false) {
    out = out.replace(LONG_RUN_RE, (m) => `${m.slice(0, KEEP_PREFIX)}…[${m.length}]`);
  }
  return out;
}
