/**
 * `context_exhausted` 的反应式识别（core/context-overflow.ts）
 *
 * 正例取自各家 CLI 的**真实报错文案**；反例专门覆盖「长得像但其实不是超限」的失败，
 * 因为误判的代价是把能重试成功的任务提前判死（比不报更坏）。
 */
import { describe, expect, it } from 'vitest';
import {
  CONTEXT_OVERFLOW_CODES,
  looksLikeContextOverflow,
} from '../src/core/context-overflow.js';

describe('looksLikeContextOverflow：真实超限文案', () => {
  it('Anthropic / Claude 的 prompt is too long', () => {
    expect(
      looksLikeContextOverflow(
        'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 213456 tokens > 200000 maximum"}}',
      ),
    ).toBe(true);
  });

  it('OpenAI 兼容端的显式错误码', () => {
    expect(looksLikeContextOverflow('{"error":{"code":"context_length_exceeded"}}')).toBe(true);
    expect(looksLikeContextOverflow('context_window_exceeded')).toBe(true);
  });

  it('Gemini 的 token count 句式', () => {
    expect(
      looksLikeContextOverflow(
        'The input token count (1048577) exceeds the maximum number of tokens allowed (1048576).',
      ),
    ).toBe(true);
  });

  it('量词在后的反序句式（maximum context length … you requested …）', () => {
    expect(
      looksLikeContextOverflow(
        'This model\'s maximum context length is 128000 tokens. However, you requested 150000 tokens.',
      ),
    ).toBe(true);
  });

  it('Conversation is too long', () => {
    expect(looksLikeContextOverflow('Error: Conversation is too long to continue')).toBe(true);
  });

  it('中文文案', () => {
    expect(looksLikeContextOverflow('请求失败：上下文长度超出模型上限')).toBe(true);
    expect(looksLikeContextOverflow('提示词过长，超过上下文窗口限制')).toBe(true);
    expect(looksLikeContextOverflow('token 数量超过上限')).toBe(true);
  });

  it('多段输入任意一段命中即可（error 文案 + 输出尾部）', () => {
    expect(
      looksLikeContextOverflow('CLI 退出码 1', 'stderr: prompt is too long: 213456 tokens'),
    ).toBe(true);
  });
});

describe('looksLikeContextOverflow：必须不误判的失败', () => {
  it('gRPC 的 context deadline exceeded 是超时，不是超限', () => {
    expect(looksLikeContextOverflow('context deadline exceeded')).toBe(false);
    expect(looksLikeContextOverflow('rpc error: code = DeadlineExceeded desc = context deadline exceeded')).toBe(false);
  });

  it('额度与配额', () => {
    expect(looksLikeContextOverflow('credit limit exceeded')).toBe(false);
    expect(looksLikeContextOverflow('You exceeded your current quota, please check your plan')).toBe(false);
    expect(looksLikeContextOverflow('rate limit exceeded, retry after 60s')).toBe(false);
  });

  it('认证失败', () => {
    expect(looksLikeContextOverflow('401 Unauthorized')).toBe(false);
    expect(looksLikeContextOverflow('Authentication required. Please run /login')).toBe(false);
  });

  it('普通超时 / 退出码 / 文件大小限制', () => {
    expect(looksLikeContextOverflow('request timed out')).toBe(false);
    expect(looksLikeContextOverflow('CLI 退出码 42')).toBe(false);
    expect(looksLikeContextOverflow('git push failed: file size exceeds the limit')).toBe(false);
  });

  it('max_tokens 配置值本身不是超限', () => {
    expect(looksLikeContextOverflow('Max tokens must be a positive integer')).toBe(false);
    expect(looksLikeContextOverflow('--max-tokens 4096')).toBe(false);
  });

  it('空输入', () => {
    expect(looksLikeContextOverflow()).toBe(false);
    expect(looksLikeContextOverflow(undefined, null, '')).toBe(false);
  });
});

describe('CONTEXT_OVERFLOW_CODES', () => {
  it('全部小写、无空格（供 includes 匹配）', () => {
    for (const code of CONTEXT_OVERFLOW_CODES) {
      expect(code).toBe(code.toLowerCase());
      expect(code).not.toMatch(/\s/);
    }
  });
});
