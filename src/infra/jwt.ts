/**
 * 最小 JWT/JWKS 校验器（无第三方依赖）。
 *
 * 用途：控制面/网关接受 principal JWT，映射 tenant 与 scope；不替代设备令牌。
 * 支持 RS256/384/512 与 ES256/384；JWKS 只支持 RSA/EC 公钥。
 */

import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';

export type JwtErrorCode =
  | 'malformed'
  | 'unsupported_alg'
  | 'unknown_kid'
  | 'bad_signature'
  | 'expired'
  | 'not_yet_valid'
  | 'bad_issuer'
  | 'bad_audience';

export class JwtError extends Error {
  constructor(
    readonly code: JwtErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'JwtError';
  }
}

export interface Jwk {
  kty?: string;
  kid?: string;
  alg?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

export interface JwtPrincipal {
  subject: string;
  tenantId?: string;
  scopes: string[];
  claims: Record<string, unknown>;
}

export interface JwtVerifierOptions {
  jwks: { keys: Jwk[] } | string;
  issuer?: string;
  audience?: string;
  tenantClaim?: string;
  /** 允许的时钟偏差（秒，默认 30） */
  clockToleranceSec?: number;
  /** 缓存 JWKS 的毫秒数（默认 5 分钟） */
  cacheMs?: number;
  fetchImpl?: typeof fetch;
}

interface Decoded {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
}

function decode(token: string): Decoded {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('malformed', 'JWT 必须是三段式');
  const [head, body, sig] = parts as [string, string, string];
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8')) as Record<string, unknown>;
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new JwtError('malformed', 'JWT 头部或载荷不是合法 JSON');
  }
  return {
    header,
    payload,
    signingInput: `${head}.${body}`,
    signature: Buffer.from(sig, 'base64url'),
  };
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function scopesOf(payload: Record<string, unknown>): string[] {
  const scope = payload['scope'];
  if (typeof scope === 'string') return scope.split(/\s+/).filter(Boolean);
  const scp = payload['scp'];
  if (Array.isArray(scp)) return scp.filter((item): item is string => typeof item === 'string');
  return [];
}

function algorithm(alg: string): { hash: string; type: 'rsa' | 'ec' } {
  switch (alg) {
    case 'RS256':
      return { hash: 'sha256', type: 'rsa' };
    case 'RS384':
      return { hash: 'sha384', type: 'rsa' };
    case 'RS512':
      return { hash: 'sha512', type: 'rsa' };
    case 'ES256':
      return { hash: 'sha256', type: 'ec' };
    case 'ES384':
      return { hash: 'sha384', type: 'ec' };
    default:
      throw new JwtError('unsupported_alg', `不支持的 JWT alg：${alg}`);
  }
}

export class JwtVerifier {
  private keys?: Jwk[];
  private fetchedAt = 0;

  constructor(private readonly options: JwtVerifierOptions) {}

  async verify(token: string): Promise<JwtPrincipal> {
    const decoded = decode(token);
    const alg = String(decoded.header['alg'] ?? '');
    const { hash, type } = algorithm(alg);
    const kid = typeof decoded.header['kid'] === 'string' ? decoded.header['kid'] : undefined;
    const key = await this.publicKey(kid, type);

    const input = Buffer.from(decoded.signingInput, 'utf8');
    const ok =
      type === 'rsa'
        ? cryptoVerify(hash, input, key, decoded.signature)
        : cryptoVerify(hash, input, { key, dsaEncoding: 'ieee-p1363' }, decoded.signature);
    if (!ok) throw new JwtError('bad_signature', 'JWT 签名不匹配');

    const payload = decoded.payload;
    const now = Math.floor(Date.now() / 1000);
    const skew = this.options.clockToleranceSec ?? 30;
    const exp = num(payload['exp']);
    if (exp !== undefined && now - skew >= exp) throw new JwtError('expired', 'JWT 已过期');
    const nbf = num(payload['nbf']);
    if (nbf !== undefined && now + skew < nbf) throw new JwtError('not_yet_valid', 'JWT 尚未生效');

    if (this.options.issuer && payload['iss'] !== this.options.issuer) {
      throw new JwtError('bad_issuer', 'JWT issuer 不匹配');
    }
    if (this.options.audience) {
      const aud = payload['aud'];
      const audiences = Array.isArray(aud) ? aud : [aud];
      if (!audiences.includes(this.options.audience)) {
        throw new JwtError('bad_audience', 'JWT audience 不匹配');
      }
    }

    const subject = typeof payload['sub'] === 'string' ? payload['sub'] : '';
    if (!subject) throw new JwtError('malformed', 'JWT 缺少 sub');
    const tenantClaim = this.options.tenantClaim ?? 'tenant_id';
    const tenant = payload[tenantClaim];
    return {
      subject,
      ...(typeof tenant === 'string' && tenant ? { tenantId: tenant } : {}),
      scopes: scopesOf(payload),
      claims: payload,
    };
  }

  private async publicKey(kid: string | undefined, type: 'rsa' | 'ec'): Promise<KeyObject> {
    const keys = await this.loadKeys();
    const candidates = keys.filter((key) => {
      if (kid && key.kid !== kid) return false;
      const kty = key.kty ?? '';
      return type === 'rsa' ? kty === 'RSA' : kty === 'EC';
    });
    if (candidates.length === 0) throw new JwtError('unknown_kid', `JWKS 中找不到 kid=${kid ?? '(none)'}`);
    // kid 缺失时只接受唯一候选，避免拿错 key 做签名验证。
    if (!kid && candidates.length > 1) {
      throw new JwtError('unknown_kid', 'JWT 无 kid 且 JWKS 有多个候选 key');
    }
    return createPublicKey({ key: candidates[0] as never, format: 'jwk' });
  }

  private async loadKeys(): Promise<Jwk[]> {
    const source = this.options.jwks;
    if (typeof source !== 'string') return source.keys;
    const cacheMs = this.options.cacheMs ?? 5 * 60_000;
    if (this.keys && Date.now() - this.fetchedAt < cacheMs) return this.keys;
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(source, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new JwtError('unknown_kid', `JWKS 拉取失败：HTTP ${response.status}`);
    const body = (await response.json()) as { keys?: Jwk[] };
    if (!Array.isArray(body.keys)) throw new JwtError('unknown_kid', 'JWKS 缺少 keys 数组');
    this.keys = body.keys;
    this.fetchedAt = Date.now();
    return this.keys;
  }
}
