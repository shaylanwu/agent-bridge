/**
 * 命令行参数解析（CLI 支撑件）
 *
 * 极简解析：只支持 `--key=value`、`--flag` 与位置参数。
 * 不引入 commander/yargs —— 本包刻意的"零运行时依赖"约束（package.json 只有 ws + smol-toml）。
 */

export interface Flags {
  _: string[];
  [k: string]: string | boolean | string[];
}

export function parseFlags(argv: string[]): Flags {
  const out: Flags = { _: [] };
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
      else out[a.slice(2)] = true;
    } else {
      (out._ as string[]).push(a);
    }
  }
  return out;
}

/** 取字符串型 flag（非字符串一律视为未给） */
export function strFlag(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

/** 取布尔型 flag */
export function boolFlag(flags: Flags, key: string): boolean {
  return flags[key] === true;
}

/** 取数值型 flag：非法或非正一律回落默认值 */
export function numFlag(flags: Flags, key: string, fallback: number): number {
  const raw = Number(strFlag(flags, key) ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * 取数值型 flag 并允许自定义下界（如 `--max-queue=0` 合法）。
 * 空串 / 非法 / 越下界一律视为「未给」（返回 undefined），由调用方回落自己的优先级链。
 */
export function numFlagMin(flags: Flags, key: string, min: number): number | undefined {
  const raw = strFlag(flags, key);
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : undefined;
}

/** 位置参数：`agent-bridge services revoke <id>` 里 pos(flags,2) 即 `<id>` */
export function posFlag(flags: Flags, index: number): string {
  return (flags._ as string[])[index] ?? '';
}
