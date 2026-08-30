// Minimal HS256 JWT for the demo (ADR-008): the token proves identity only —
// authorization is always live in the sync path (ADR-003/004), so nothing
// here needs revocation lists or rotation machinery.
import { createHmac, timingSafeEqual } from 'node:crypto';

const b64url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const sign = (data: string, secret: string): string =>
  b64url(createHmac('sha256', secret).update(data).digest());

export interface Claims {
  sub: string;
  iat: number;
  exp: number;
}

export const mintToken = (userId: string, secret: string, nowMs: number, ttlMs: number): string => {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const iat = Math.floor(nowMs / 1000);
  const payload = b64url(
    Buffer.from(JSON.stringify({ sub: userId, iat, exp: iat + Math.floor(ttlMs / 1000) } satisfies Claims)),
  );
  return `${header}.${payload}.${sign(`${header}.${payload}`, secret)}`;
};

export const verifyToken = (token: string, secret: string, nowMs: number): Claims | null => {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts as [string, string, string];
  const expected = sign(`${header}.${payload}`, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Partial<Claims>;
    if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number') return null;
    if (claims.exp * 1000 < nowMs) return null;
    return claims as Claims;
  } catch {
    return null;
  }
};
