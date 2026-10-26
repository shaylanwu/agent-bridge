import { describe, expect, it } from 'vitest';
import { findSecretKey, validateFormContent } from '../src/core/form-schema.js';

const schema = {
  type: 'object',
  properties: {
    env: { type: 'string' },
    replicas: { type: 'integer' },
  },
  required: ['env'],
};

describe('Form schema', () => {
  it('接受符合 required/type 的 content', () => {
    expect(validateFormContent(schema, { env: 'staging', replicas: 2 })).toBeUndefined();
  });

  it('拒绝缺必填与类型不匹配', () => {
    expect(validateFormContent(schema, {})).toContain('env');
    expect(validateFormContent(schema, { env: 'staging', replicas: '2' })).toContain('replicas');
  });

  it('拒绝 secret 字段（含嵌套）', () => {
    expect(findSecretKey({ apiKey: 'x' })).toBe('apiKey');
    expect(findSecretKey({ nested: { password: 'x' } })).toBe('nested.password');
    expect(validateFormContent(schema, { env: 'staging', apiKey: 'x' })).toContain('secret');
  });
});
