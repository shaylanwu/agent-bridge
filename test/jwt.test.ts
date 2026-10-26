import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { JwtError, JwtVerifier } from '../src/infra/jwt.js';

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function rsaFixture() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  const kid = 'k1';
  const sign = (payload: Record<string, unknown>, alg = 'RS256', headerKid: string | undefined = kid) => {
    const header = { alg, typ: 'JWT', ...(headerKid ? { kid: headerKid } : {}) };
    const input = `${b64(header)}.${b64(payload)}`;
    const signature = createSign('sha256').update(input).sign(privateKey);
    return `${input}.${signature.toString('base64url')}`;
  };
  return { sign, jwks: { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] } };
}

describe('JwtVerifier', () => {
  const now = Math.floor(Date.now() / 1000);
  const base = { sub: 'user-1', iss: 'https://issuer.test', aud: 'agent-bridge', tenant_id: 't1', scope: 'task:read task:write', exp: now + 3600 };

  it('验签并映射 tenant/scope', async () => {
    const { sign, jwks } = rsaFixture();
    const verifier = new JwtVerifier({ jwks, issuer: 'https://issuer.test', audience: 'agent-bridge' });
    const principal = await verifier.verify(sign(base));
    expect(principal).toMatchObject({ subject: 'user-1', tenantId: 't1' });
    expect(principal.scopes).toEqual(['task:read', 'task:write']);
  });

  it('过期、audience 不符、签名错误、未知 kid 都拒绝', async () => {
    const { sign, jwks } = rsaFixture();
    const verifier = new JwtVerifier({ jwks, issuer: 'https://issuer.test', audience: 'agent-bridge' });
    await expect(verifier.verify(sign({ ...base, exp: now - 60 }))).rejects.toMatchObject({ code: 'expired' });
    await expect(verifier.verify(sign({ ...base, aud: 'other' }))).rejects.toMatchObject({ code: 'bad_audience' });
    await expect(verifier.verify(sign({ ...base, sub: 'x' }).slice(0, -2) + 'aa')).rejects.toMatchObject({
      code: 'bad_signature',
    });
    await expect(verifier.verify(sign(base, 'RS256', 'missing'))).rejects.toMatchObject({ code: 'unknown_kid' });
  });

  it('ES256 也可验证', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
    const header = { alg: 'ES256', typ: 'JWT', kid: 'ec1' };
    const input = `${b64(header)}.${b64(base)}`;
    const sig = createSign('sha256')
      .update(input)
      .sign({ key: privateKey, dsaEncoding: 'ieee-p1363' });
    const verifier = new JwtVerifier({
      jwks: { keys: [{ ...jwk, kid: 'ec1', alg: 'ES256', use: 'sig' }] },
      audience: 'agent-bridge',
    });
    await expect(verifier.verify(`${input}.${sig.toString('base64url')}`)).resolves.toMatchObject({
      subject: 'user-1',
    });
  });

  it('畸形 JWT 不走网络', async () => {
    const verifier = new JwtVerifier({ jwks: { keys: [] } });
    await expect(verifier.verify('not-a-jwt')).rejects.toBeInstanceOf(JwtError);
  });
});
