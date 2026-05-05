// Cloudflare Access JWT verification. We verify the JWT signature against the
// team's JWKS, the audience, the issuer, and the time bounds. Header `email`
// is read from the verified payload — never from `Cf-Access-Authenticated-User-Email`
// alone, since that header would survive a routing misconfiguration.
//
// JWKS is cached in KV for 24h, keyed by `kid`. On `kid` miss we force-refresh
// once before rejecting (handles legitimate key rotation).

const JWKS_CACHE_KEY = 'access:jwks';
const JWKS_TTL_S = 60 * 60 * 24;
const CLOCK_SKEW_S = 60;

type Jwks = { keys: JsonWebKey[] };
type AccessClaims = {
  aud?: string | string[];
  iss?: string;
  email?: string;
  sub?: string;
  exp?: number;
  iat?: number;
  nbf?: number;
};

export type VerifiedAccessIdentity = {
  email: string;
  sub: string;
};

function b64urlToUint8(s: string): Uint8Array {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJoseSegment<T>(seg: string): T {
  const bytes = b64urlToUint8(seg);
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function loadJwks(env: Cloudflare.Env, force: boolean): Promise<Jwks> {
  if (!env.ACCESS_TEAM_DOMAIN) throw new Error('ACCESS_TEAM_DOMAIN secret not set');
  if (!force) {
    const cached = await env.CACHE.get(JWKS_CACHE_KEY, 'json');
    if (cached) return cached as Jwks;
  }
  const url = `https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`;
  const res = await fetch(url, { cf: { cacheTtl: 300 } });
  if (!res.ok) throw new Error(`Failed to load Access JWKS (${res.status})`);
  const jwks = (await res.json()) as Jwks;
  await env.CACHE.put(JWKS_CACHE_KEY, JSON.stringify(jwks), { expirationTtl: JWKS_TTL_S });
  return jwks;
}

async function importRsaKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
}

export async function verifyAccessJwt(
  jwt: string,
  env: Cloudflare.Env,
): Promise<VerifiedAccessIdentity> {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('Malformed JWT');
  const [headerB64, payloadB64, sigB64] = parts;

  const header = decodeJoseSegment<{ alg: string; kid: string }>(headerB64);
  if (header.alg !== 'RS256') throw new Error(`Unsupported alg: ${header.alg}`);

  let jwks = await loadJwks(env, false);
  let key = jwks.keys.find((k) => (k as JsonWebKey & { kid?: string }).kid === header.kid);
  if (!key) {
    jwks = await loadJwks(env, true);
    key = jwks.keys.find((k) => (k as JsonWebKey & { kid?: string }).kid === header.kid);
  }
  if (!key) throw new Error('No matching JWKS key');

  const cryptoKey = await importRsaKey(key);
  const signed = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig = b64urlToUint8(sigB64);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, sig as BufferSource, signed as BufferSource);
  if (!ok) throw new Error('Bad signature');

  const claims = decodeJoseSegment<AccessClaims>(payloadB64);
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp != null && now > claims.exp + CLOCK_SKEW_S) throw new Error('Token expired');
  if (claims.nbf != null && now + CLOCK_SKEW_S < claims.nbf) throw new Error('Token not yet valid');

  if (env.ACCESS_AUD) {
    const auds = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
    if (!auds.includes(env.ACCESS_AUD)) throw new Error('Bad audience');
  }
  if (env.ACCESS_TEAM_DOMAIN) {
    const expectedIss = `https://${env.ACCESS_TEAM_DOMAIN}`;
    if (claims.iss !== expectedIss) throw new Error('Bad issuer');
  }

  if (!claims.email) throw new Error('No email claim');
  return { email: claims.email.toLowerCase(), sub: claims.sub ?? claims.email };
}
