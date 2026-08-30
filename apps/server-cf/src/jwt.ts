// HS256 JWT over WebCrypto (ADR-008). Mirror of server-node/src/jwt.ts —
// same claims, same semantics; async because crypto.subtle is.
export interface Claims {
  sub: string;
  iat: number;
  exp: number;
}

const encoder = new TextEncoder();

const b64url = (bytes: ArrayBuffer | Uint8Array): string => {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const b64urlDecode = (s: string): string =>
  atob(s.replace(/-/g, '+').replace(/_/g, '/'));

const hmacKey = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);

export const mintToken = async (
  userId: string,
  secret: string,
  nowMs: number,
  ttlMs: number,
): Promise<string> => {
  const header = b64url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const iat = Math.floor(nowMs / 1000);
  const payload = b64url(
    encoder.encode(JSON.stringify({ sub: userId, iat, exp: iat + Math.floor(ttlMs / 1000) } satisfies Claims)),
  );
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(sig)}`;
};

export const verifyToken = async (
  token: string,
  secret: string,
  nowMs: number,
): Promise<Claims | null> => {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts as [string, string, string];
  // Everything that parses attacker-controlled text lives inside the try:
  // atob throws on non-base64, and an escaping throw here would reset the
  // Durable Object, dropping every other socket attached to it.
  try {
    const sigBytes = Uint8Array.from(b64urlDecode(sig), (c) => c.charCodeAt(0));
    const ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      sigBytes,
      encoder.encode(`${header}.${payload}`),
    );
    if (!ok) return null;
    // Decode as UTF-8, matching the Node adapter exactly: a latin1 read
    // would resolve a non-ASCII `sub` to a different principal per runtime.
    const bytes = Uint8Array.from(b64urlDecode(payload), (c) => c.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(bytes)) as Partial<Claims>;
    if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number') return null;
    if (claims.exp * 1000 < nowMs) return null;
    return claims as Claims;
  } catch {
    return null;
  }
};
