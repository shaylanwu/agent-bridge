const ANSI_ESCAPE = /\x1b\[[0-9;?]*[ -/]*[@-~]/;

/** CLI 日志里是否真的带 ANSI 转义；不要无条件写 true，前端会错误地按颜色渲染纯文本。 */
export function hasAnsi(text: string): boolean {
  return ANSI_ESCAPE.test(text);
}
