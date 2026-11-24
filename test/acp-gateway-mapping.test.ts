/**
 * ACP server 侧映射（task 1.3）—— 纯函数：
 * prompt / stopReason / permission / form / auth-url / cancel 的翻译表与畸形输入防御。
 */

import { describe, expect, it } from 'vitest';
import {
  acpMethodForInteractionKind,
  acpPromptToText,
  fromAcpElicitationResult,
  fromAcpPermissionOutcome,
  toAcpStopReason,
  toAcpPermissionRequestParams,
  toAcpElicitationParams,
  toAcpUrlElicititationParams,
} from '../src/transport/acp-gateway-mapping.js';
import type { InteractionRecord } from '../src/core/session-store.js';

const interaction = (kind: 'permission' | 'form' | 'auth-url', payload: Record<string, unknown>): Pick<InteractionRecord, 'sessionId' | 'payload'> =>
  ({ sessionId: 'bt_x', payload });

describe('TaskStatus → ACP stopReason', () => {
  it('success→end_turn，cancelled→cancelled，failed/timeout 不产出（走错误响应）', () => {
    expect(toAcpStopReason('success')).toBe('end_turn');
    expect(toAcpStopReason('cancelled')).toBe('cancelled');
    expect(toAcpStopReason('failed')).toBeUndefined();
    expect(toAcpStopReason('timeout')).toBeUndefined();
  });
});

describe('session/prompt → bridge prompt', () => {
  it('text block 数组拼接', () => {
    expect(acpPromptToText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toEqual({ text: 'a\nb' });
  });
  it('纯字符串也接受（宽松输入）', () => {
    expect(acpPromptToText('do it')).toEqual({ text: 'do it' });
  });
  it('非 text block 拒绝：不静默丢图片后假装收到完整请求', () => {
    const r = acpPromptToText([{ type: 'image', data: '...' }]);
    expect('unsupported' in r).toBe(true);
  });
  it('空 prompt 拒绝', () => {
    const r = acpPromptToText([]);
    expect('unsupported' in r).toBe(true);
  });
});

describe('permission 交互 ↔ session/request_permission', () => {
  it('options + toolCall 结构校验透传', () => {
    const r = toAcpPermissionRequestParams(
      interaction('permission', {
        options: [
          { optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'reject-once', kind: 'reject_once' },
        ],
        toolCall: { toolCallId: 'tc1', title: 'shell' },
      }),
    );
    expect(r).toMatchObject({
      sessionId: 'bt_x',
      options: [
        { optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'reject-once', kind: 'reject_once' },
      ],
      toolCall: { toolCallId: 'tc1', title: 'shell' },
    });
  });
  it('畸形 payload 判非法（缺 options / option 缺 optionId）', () => {
    expect('invalid' in toAcpPermissionRequestParams(interaction('permission', {}))).toBe(true);
    expect('invalid' in toAcpPermissionRequestParams(interaction('permission', { options: [] }))).toBe(true);
    expect('invalid' in toAcpPermissionRequestParams(interaction('permission', { options: [{ kind: 'allow_once' }] }))).toBe(true);
  });

  it('selected → accepted + optionId；cancelled → cancelled；畸形拒绝', () => {
    expect(fromAcpPermissionOutcome({ outcome: { outcome: 'selected', optionId: 'allow-once' } })).toEqual({
      state: 'accepted',
      optionId: 'allow-once',
    });
    expect(fromAcpPermissionOutcome({ outcome: { outcome: 'cancelled' } })).toEqual({ state: 'cancelled' });
    expect('invalid' in fromAcpPermissionOutcome({})).toBe(true);
    expect('invalid' in fromAcpPermissionOutcome({ outcome: { outcome: 'weird' } })).toBe(true);
  });
});

describe('form 交互 ↔ elicitation/create（form 模式）', () => {
  it('requestedSchema → schema + message', () => {
    const r = toAcpElicitationParams(
      interaction('form', { requestedSchema: { type: 'object', properties: { a: { type: 'string' } } }, message: 'fill it' }),
    );
    expect(r).toMatchObject({
      sessionId: 'bt_x',
      mode: 'form',
      message: 'fill it',
      schema: { type: 'object', properties: { a: { type: 'string' } } },
    });
  });
  it('缺 schema 判非法', () => {
    expect('invalid' in toAcpElicitationParams(interaction('form', { message: 'x' }))).toBe(true);
  });
  it('elicitation result：accept/decline/cancel', () => {
    expect(fromAcpElicitationResult({ action: 'accept', content: { a: '1' } })).toEqual({
      state: 'accepted',
      content: { a: '1' },
    });
    expect(fromAcpElicitationResult({ action: 'decline' })).toEqual({ state: 'declined' });
    expect(fromAcpElicitationResult({ action: 'cancel' })).toEqual({ state: 'cancelled' });
    expect('invalid' in fromAcpElicitationResult({ action: 'accept' })).toBe(true);
    expect('invalid' in fromAcpElicitationResult({})).toBe(true);
  });
});

describe('auth-url 交互 ↔ URL 模式 elicitation', () => {
  it('合法 url 透传为 mode:url', () => {
    const r = toAcpUrlElicititationParams(interaction('auth-url', { url: 'https://auth.example/login', message: 'login' }));
    expect(r).toMatchObject({ sessionId: 'bt_x', url: 'https://auth.example/login', mode: 'url', message: 'login' });
  });
  it('缺 url / 非 http(s) 判非法：网关不猜地址', () => {
    expect('invalid' in toAcpUrlElicititationParams(interaction('auth-url', {}))).toBe(true);
    expect('invalid' in toAcpUrlElicititationParams(interaction('auth-url', { url: 'ftp://x' }))).toBe(true);
  });
});

describe('交互 kind → ACP agent→client 方法名', () => {
  it('permission 走 request_permission；form/auth-url 走 elicitation/create', () => {
    expect(acpMethodForInteractionKind('permission')).toBe('session/request_permission');
    expect(acpMethodForInteractionKind('form')).toBe('elicitation/create');
    expect(acpMethodForInteractionKind('auth-url')).toBe('elicitation/create');
  });
});
