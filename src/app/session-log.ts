/**
 * 会话日志契约（应用编排层）
 *
 * `app/` 层不许直接 `console.*` —— 否则本地控制面板复用同一段编排时会被 stdout 绑死，
 * 单测里也会吐一屏噪音。由调用方注入实现（CLI 注入带颜色的终端输出，控制面注入事件流）。
 */

export type SessionLog = (level: 'info' | 'warn' | 'error', line: string) => void;
