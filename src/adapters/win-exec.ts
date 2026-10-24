/**
 * Windows 上执行 `.cmd` / `.bat` 垫片的正确姿势（2026-10-21）
 *
 * 两个坑叠在一起：
 * 1) `spawn(bin, args, { shell: true })` 会把命令**直接拼接**（不做转义），路径带空格就断：
 *    `C:\...\Programs\Qoder IDE\bin\qoder.cmd --version` → cmd 只认到 `C:\...\Qoder`，
 *    于是工具被误判成「装坏」（真机上 Qoder 其实是好的，能报 1.1.75）。Node 20+ 还会报 DEP0190。
 * 2) 只把命令拆成 `cmd.exe /d /s /c "..."` 的多个参数也不行——Node 会给每个参数加引号，
 *    cmd 的 `/s` 再剥外层引号，最后引号错位（实测全量「装坏」）。
 *
 * 正解：自己拼一条**完整命令行字符串**（每个参数加引号、内部 `"` 翻倍），
 * 以 `{ shell: true }` 交给 Node（单字符串入参，不触发 DEP0190），cmd 按原样执行。
 */

const WIN_SHIM_RE = /\.(cmd|bat)$/i;

export function isWinShim(binPath: string): boolean {
  return process.platform === 'win32' && WIN_SHIM_RE.test(binPath);
}

/** cmd 参数转义：整体加引号 + 内部 `"` 翻倍 */
function quoteArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** 拼出可直接交给 `{ shell: true }` 的完整命令行（仅 Windows shim 需要） */
export function buildWinCommandLine(binPath: string, argv: string[]): string {
  return [quoteArg(binPath), ...argv.map(quoteArg)].join(' ');
}
