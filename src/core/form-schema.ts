/**
 * ACP/MCP Form 的最小 schema 校验与 secret 拒绝。
 *
 * 只支持设计约定的扁平对象子集（type/properties/required），
 * 不实现完整 JSON Schema；未知字段允许，但 secret 字段一律拒绝。
 */

const SECRET_KEY = /(token|secret|password|passwd|authorization|api[_-]?key|credential|private[_-]?key)/i;

export function findSecretKey(value: unknown, path = ''): string | undefined {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = findSecretKey(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const next = path ? `${path}.${key}` : key;
    if (SECRET_KEY.test(key)) return next;
    const found = findSecretKey(child, next);
    if (found) return found;
  }
  return undefined;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function typeMatches(expected: unknown, value: unknown): boolean {
  if (Array.isArray(expected)) return expected.some((item) => typeMatches(item, value));
  if (typeof expected !== 'string') return true;
  if (expected === 'integer') return Number.isInteger(value);
  if (expected === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeOf(value) === expected;
}

/** 返回错误文案；通过返回 undefined */
export function validateFormContent(
  schema: Record<string, unknown>,
  content: Record<string, unknown>,
): string | undefined {
  const secret = findSecretKey(content);
  if (secret) return `Form 不允许 secret 字段：${secret}`;

  const required = Array.isArray(schema['required'])
    ? schema['required'].filter((key): key is string => typeof key === 'string')
    : [];
  for (const key of required) {
    if (!(key in content)) return `缺少必填字段：${key}`;
  }

  const properties =
    typeof schema['properties'] === 'object' && schema['properties'] !== null
      ? (schema['properties'] as Record<string, unknown>)
      : {};
  for (const [key, value] of Object.entries(content)) {
    const def = properties[key];
    if (typeof def !== 'object' || def === null) continue;
    const expected = (def as Record<string, unknown>)['type'];
    if (expected !== undefined && !typeMatches(expected, value)) {
      return `字段类型不匹配：${key}`;
    }
  }
  return undefined;
}
