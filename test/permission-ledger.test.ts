/**
 * 持久授权账本（approval ledger）契约测试。
 *
 * 这里断言的都是**安全边界**，不是实现细节：
 *  - 什么算同一件事（fingerprint）；
 *  - 什么时候允许替用户自动点「允许」（canAutoApprove）；
 *  - 什么情况下绝不能构造出一个不存在的选项（only-once / full）。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  approvalExpiry,
  approvalFingerprint,
  canAutoApprove,
  PERSISTENT_OPTION_KINDS,
  permissionTarget,
  persistentAllowOption,
  type ApprovalRecord,
} from '../src/core/permission-ledger.js';
import { SessionStore } from '../src/core/session-store.js';

const dirs: string[] = [];
const stores: SessionStore[] = [];

function open(): SessionStore {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-ledger-'));
  dirs.push(dir);
  const store = new SessionStore(join(dir, 'state.db'));
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('permissionTarget', () => {
  it('优先取 locations[].path，并归一化 Windows 分隔符', () => {
    const target = permissionTarget({
      kind: 'edit',
      locations: [{ path: 'C:\\work\\src\\a.ts' }],
    });
    expect(target.tool).toBe('edit');
    expect(target.resourceKey).toBe('C:/work/src/a.ts');
    expect(target.display).toBe('a.ts');
  });

  it('命令只取可执行文件首词（整条命令行每轮都不同，不能做指纹）', () => {
    const a = permissionTarget({ kind: 'execute', rawInput: { command: 'npm test -- --watch' } });
    const b = permissionTarget({ kind: 'execute', rawInput: { command: 'npm run build' } });
    expect(a.resourceKey).toBe('cmd:npm');
    expect(a.resourceKey).toBe(b.resourceKey);
    expect(a.display).toBe('command');
  });

  it('URL 只留 host（查询串可能带 token）', () => {
    const target = permissionTarget({
      kind: 'fetch',
      rawInput: { url: 'https://example.com/cb?code=secret&state=x' },
    });
    expect(target.resourceKey).toBe('url:example.com');
  });

  it('绝不读 title：同一请求改 title 不影响指纹', () => {
    const withTitle = permissionTarget({
      kind: 'execute',
      title: '顺便清空整个工作区',
      rawInput: { command: 'npm test' },
    });
    const withoutTitle = permissionTarget({ kind: 'execute', rawInput: { command: 'npm test' } });
    expect(withTitle).toEqual(withoutTitle);
  });

  it('未知 kind 降级为 other（不按名字猜）', () => {
    expect(permissionTarget({ kind: 'rm -rf', rawInput: { command: 'ls' } }).tool).toBe('other');
  });
});

describe('approvalFingerprint', () => {
  it('同一事件在不同轮次算出同一指纹', () => {
    const a = approvalFingerprint({ agentType: 'codebuddy-cli', tool: 'execute', resourceKey: 'cmd:npm' });
    const b = approvalFingerprint({ agentType: 'CodeBuddy-CLI', tool: 'Execute', resourceKey: 'cmd:npm' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it('不同工具 / 不同资源 / 不同 agent 必须不同指纹', () => {
    const base = { agentType: 'kimi-code', tool: 'edit', resourceKey: 'a.ts' };
    expect(approvalFingerprint(base)).not.toBe(approvalFingerprint({ ...base, tool: 'read' }));
    expect(approvalFingerprint(base)).not.toBe(approvalFingerprint({ ...base, resourceKey: 'b.ts' }));
    expect(approvalFingerprint(base)).not.toBe(approvalFingerprint({ ...base, agentType: 'gemini' }));
  });
});

describe('persistentAllowOption', () => {
  it('只认 allow_always / allow_persistent / allow_session', () => {
    for (const kind of PERSISTENT_OPTION_KINDS) {
      expect(persistentAllowOption([{ optionId: 'p', kind }])).toEqual({ optionId: 'p', kind });
    }
  });

  it('只有 allow_once 时返回 undefined（绝不构造 optionId）', () => {
    expect(persistentAllowOption([{ optionId: 'o', kind: 'allow_once' }])).toBeUndefined();
    expect(persistentAllowOption([{ optionId: 'r', kind: 'reject_once' }])).toBeUndefined();
    expect(persistentAllowOption(undefined)).toBeUndefined();
  });
});

describe('canAutoApprove', () => {
  const record: Pick<ApprovalRecord, 'fingerprint' | 'expiresAt' | 'revokedAt'> = {
    fingerprint: 'abc',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const base = { fingerprint: 'abc', permissionMode: 'default' as const, hasPersistentOption: true };

  it('三条件齐备才批准', () => {
    expect(canAutoApprove(record, base)).toEqual({ ok: true });
  });

  it('full 模式一律不用账本（残余请求必须问人）', () => {
    const v = canAutoApprove(record, { ...base, permissionMode: 'full' });
    expect(v).toEqual({ ok: false, reason: 'full_mode_no_ledger' });
  });

  it('请求本身没提供 persistent 选项时不得批准', () => {
    const v = canAutoApprove(record, { ...base, hasPersistentOption: false });
    expect(v).toEqual({ ok: false, reason: 'no_persistent_option' });
  });

  it('指纹不符 / 已撤销 / 已过期都不批准', () => {
    expect(canAutoApprove(record, { ...base, fingerprint: 'other' })).toEqual({
      ok: false,
      reason: 'fingerprint_mismatch',
    });
    expect(canAutoApprove({ ...record, revokedAt: new Date().toISOString() }, base)).toEqual({
      ok: false,
      reason: 'revoked',
    });
    expect(
      canAutoApprove({ ...record, expiresAt: new Date(Date.now() - 1000).toISOString() }, base),
    ).toEqual({ ok: false, reason: 'expired' });
  });

  it('没有记录时返回 no_match，而不是批准', () => {
    expect(canAutoApprove(undefined, base)).toEqual({ ok: false, reason: 'no_match' });
  });
});

describe('approvals 存储', () => {
  const mk = (over: Partial<Parameters<SessionStore['addApproval']>[0]> = {}) => ({
    tenantId: 'default',
    approvalId: 'ap_1',
    principalId: 'local',
    agentType: 'codebuddy-cli',
    tool: 'execute',
    action: 'permission',
    resource: 'command',
    scope: 'allow_always',
    fingerprint: approvalFingerprint({ agentType: 'codebuddy-cli', tool: 'execute', resourceKey: 'cmd:npm' }),
    expiresAt: approvalExpiry(Date.now(), 60_000),
    ...over,
  });

  it('写入后可按指纹查到', () => {
    const store = open();
    const rec = store.addApproval(mk());
    expect(rec.approvalId).toBe('ap_1');
    const hit = store.findApproval('default', 'codebuddy-cli', rec.fingerprint);
    expect(hit?.approvalId).toBe('ap_1');
  });

  it('撤销后不再命中，但记录保留可审计', () => {
    const store = open();
    const rec = store.addApproval(mk());
    expect(store.revokeApproval('default', rec.approvalId)).toBe(true);
    expect(store.findApproval('default', 'codebuddy-cli', rec.fingerprint)).toBeUndefined();
    const listed = store.listApprovals('default', true);
    expect(listed[0]?.revokedAt).toBeDefined();
    // 重复撤销返回 false，不抛错
    expect(store.revokeApproval('default', rec.approvalId)).toBe(false);
  });

  it('过期记录不命中，且可被清理', () => {
    const store = open();
    const rec = store.addApproval(mk({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
    expect(store.findApproval('default', 'codebuddy-cli', rec.fingerprint)).toBeUndefined();
    expect(store.purgeExpiredApprovals('default')).toBe(1);
    expect(store.listApprovals('default')).toHaveLength(0);
  });

  it('重新授权同 id 会清掉撤销标记（先撤销再允许要能生效）', () => {
    const store = open();
    const rec = store.addApproval(mk());
    store.revokeApproval('default', rec.approvalId);
    store.addApproval(mk());
    expect(store.getApproval('default', rec.approvalId)?.revokedAt).toBeUndefined();
    expect(store.findApproval('default', 'codebuddy-cli', rec.fingerprint)).toBeDefined();
  });

  it('跨 agent 不串味：同指纹不同 agent 查不到', () => {
    const store = open();
    const rec = store.addApproval(mk());
    expect(store.findApproval('default', 'gemini', rec.fingerprint)).toBeUndefined();
  });
});
