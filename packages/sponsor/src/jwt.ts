/**
 * Cheap local checks on a zkLogin JWT before anything reaches Enoki. This does not
 * verify the signature (Enoki does that when it derives the address); it only turns
 * away garbage and expired tokens with a 401 at no upstream cost. The token itself is
 * never logged.
 */

export type JwtPrecheck = { ok: true; iss: string; exp: number } | { ok: false; reason: string };

const MAX_JWT_LEN = 8192;
const B64URL = /^[A-Za-z0-9_-]+$/;

function decodePart(part: string): unknown {
  if (!B64URL.test(part)) throw new Error('not base64url');
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

export function precheckJwt(jwt: string, nowSec = Date.now() / 1000): JwtPrecheck {
  if (jwt.length > MAX_JWT_LEN) return { ok: false, reason: 'token too long' };
  const parts = jwt.split('.');
  if (parts.length !== 3 || !parts[2]) return { ok: false, reason: 'not a JWT' };
  let header: { alg?: unknown };
  let p: { iss?: unknown; aud?: unknown; sub?: unknown; exp?: unknown; nbf?: unknown; iat?: unknown };
  try {
    header = decodePart(parts[0]!) as typeof header;
    p = decodePart(parts[1]!) as typeof p;
  } catch {
    return { ok: false, reason: 'not a JWT' };
  }
  if (!header || typeof header !== 'object' || typeof header.alg !== 'string' || header.alg.toLowerCase() === 'none') {
    return { ok: false, reason: 'unsigned token' };
  }
  if (!p || typeof p !== 'object') return { ok: false, reason: 'not a JWT' };
  if (typeof p.iss !== 'string' || !p.iss) return { ok: false, reason: 'token has no issuer' };
  if (typeof p.sub !== 'string' || !p.sub) return { ok: false, reason: 'token has no subject' };
  const audOk =
    (typeof p.aud === 'string' && p.aud.length > 0) ||
    (Array.isArray(p.aud) && p.aud.length > 0 && p.aud.every((a) => typeof a === 'string' && a.length > 0));
  if (!audOk) return { ok: false, reason: 'token has no audience' };
  if (typeof p.exp !== 'number' || !Number.isFinite(p.exp)) return { ok: false, reason: 'token has no expiry' };
  if (p.exp <= nowSec) return { ok: false, reason: 'token expired' };
  // Allow 5 min of clock skew for not-before / issued-at.
  if (typeof p.nbf === 'number' && p.nbf > nowSec + 300) return { ok: false, reason: 'token not yet valid' };
  if (typeof p.iat === 'number' && p.iat > nowSec + 300) return { ok: false, reason: 'token issued in the future' };
  return { ok: true, iss: p.iss, exp: p.exp };
}
