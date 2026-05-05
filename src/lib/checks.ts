// HTTP check runner. The whole product is "give us a URL and we'll fetch it" —
// which is a textbook SSRF surface. Every fetch flows through `safeFetch` which
// resolves the hostname via DoH, blocks private/loopback/CGNAT/metadata ranges,
// re-validates on every redirect, caps redirects + body size, and enforces a
// hard timeout.

import type { HttpMonitorConfig } from '~/lib/db';

const DOH_URL = 'https://cloudflare-dns.com/dns-query';
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const HARD_TIMEOUT_MS = 30_000;

export type CheckOutcome = {
  status: 'ok' | 'fail' | 'timeout' | 'error';
  http_code?: number;
  latency_ms: number;
  error_kind?: string;
  error_msg?: string;
  body_sample?: string;
};

export async function runHttpCheck(cfg: HttpMonitorConfig): Promise<CheckOutcome> {
  const started = Date.now();
  try {
    const result = await safeFetch(cfg.url, {
      method: cfg.method,
      headers: cfg.headers,
      body: cfg.body,
      timeoutMs: Math.min(cfg.timeout_ms || 10_000, HARD_TIMEOUT_MS),
    });
    const latency = Date.now() - started;

    const expected = cfg.expected_codes && cfg.expected_codes.length > 0
      ? cfg.expected_codes
      : [200, 201, 202, 203, 204, 205, 206];
    const codeOk = expected.includes(result.status);
    if (!codeOk) {
      return {
        status: 'fail',
        http_code: result.status,
        latency_ms: latency,
        error_kind: 'bad_status',
        error_msg: `Expected ${expected.join('/')}, got ${result.status}`,
        body_sample: result.bodySample,
      };
    }

    if (cfg.keyword_present && !result.body.includes(cfg.keyword_present)) {
      return {
        status: 'fail',
        http_code: result.status,
        latency_ms: latency,
        error_kind: 'keyword_missing',
        error_msg: `Required keyword not found`,
        body_sample: result.bodySample,
      };
    }
    if (cfg.keyword_absent && result.body.includes(cfg.keyword_absent)) {
      return {
        status: 'fail',
        http_code: result.status,
        latency_ms: latency,
        error_kind: 'keyword_forbidden',
        error_msg: `Forbidden keyword present`,
        body_sample: result.bodySample,
      };
    }

    return {
      status: 'ok',
      http_code: result.status,
      latency_ms: latency,
    };
  } catch (err) {
    const latency = Date.now() - started;
    const e = err as Error & { kind?: string };
    if (e.kind === 'timeout') {
      return { status: 'timeout', latency_ms: latency, error_kind: 'timeout', error_msg: e.message };
    }
    return {
      status: 'error',
      latency_ms: latency,
      error_kind: e.kind ?? 'fetch_error',
      error_msg: e.message?.slice(0, 500),
    };
  }
}

type SafeFetchOptions = {
  method: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
};

type SafeFetchResult = { status: number; body: string; bodySample: string };

async function safeFetch(url: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = parseAndValidateUrl(current);
    await assertHostnameAllowed(u.hostname);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort('timeout'), opts.timeoutMs);
    let res: Response;
    try {
      res = await fetch(current, {
        method: opts.method,
        headers: {
          'User-Agent': 'cs-uptime-monitor/0.1 (+https://cloudsteading.com/uptime)',
          ...(opts.headers ?? {}),
        },
        body: hop === 0 ? opts.body : undefined,
        redirect: 'manual',
        signal: ac.signal,
      });
    } catch (err) {
      const e = err as Error;
      if (e.name === 'AbortError' || `${e}`.includes('timeout')) {
        const t = new Error(`Timeout after ${opts.timeoutMs}ms`) as Error & { kind?: string };
        t.kind = 'timeout';
        throw t;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) {
        return { status: res.status, body: '', bodySample: '' };
      }
      current = new URL(loc, current).toString();
      continue;
    }

    const { body, sample } = await readCappedBody(res);
    return { status: res.status, body, bodySample: sample };
  }
  const e = new Error(`Too many redirects (>${MAX_REDIRECTS})`) as Error & { kind?: string };
  e.kind = 'redirect_loop';
  throw e;
}

function parseAndValidateUrl(input: string): URL {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    const e = new Error('Invalid URL') as Error & { kind?: string };
    e.kind = 'bad_url';
    throw e;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    const e = new Error(`Scheme not allowed: ${u.protocol}`) as Error & { kind?: string };
    e.kind = 'bad_scheme';
    throw e;
  }
  return u;
}

async function readCappedBody(res: Response): Promise<{ body: string; sample: string }> {
  if (!res.body) return { body: '', sample: '' };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        try { reader.cancel(); } catch { /* ignore */ }
        const e = new Error('Response body exceeded 5MB cap') as Error & { kind?: string };
        e.kind = 'body_too_large';
        throw e;
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.byteLength; }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(merged);
  return { body: text, sample: text.slice(0, 1024) };
}

const PRIVATE_V4: [number, number, number][] = [
  [10, 8, 0],         // 10.0.0.0/8
  [172, 12, 16],      // 172.16.0.0/12 — first octet 172, top 4 bits of second = 0001
  [192, 16, 168],     // 192.168.0.0/16
  [127, 8, 0],        // 127.0.0.0/8
  [169, 16, 254],     // 169.254.0.0/16 — link-local, includes 169.254.169.254
  [100, 10, 64],      // 100.64.0.0/10 — CGNAT
  [0, 8, 0],          // 0.0.0.0/8
];

function v4InRange(parts: number[], rule: [number, number, number]): boolean {
  const [first, prefix, expected] = rule;
  if (prefix >= 8) {
    if (parts[0] !== first) return false;
  }
  if (prefix === 8) return true;
  if (prefix === 16) return parts[1] === expected;
  if (prefix === 12) return (parts[1] & 0xf0) === (expected & 0xf0);
  if (prefix === 10) return (parts[1] & 0xc0) === (expected & 0xc0);
  return false;
}

function isPrivateV4(addr: string): boolean {
  const parts = addr.split('.').map((s) => Number(s));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  return PRIVATE_V4.some((r) => v4InRange(parts, r));
}

function isPrivateV6(addr: string): boolean {
  const a = addr.toLowerCase();
  if (a === '::1' || a === '::') return true;
  if (a.startsWith('fc') || a.startsWith('fd')) return true; // ULA
  if (a.startsWith('fe8') || a.startsWith('fe9') || a.startsWith('fea') || a.startsWith('feb')) return true; // link-local
  if (a.startsWith('::ffff:')) {
    return isPrivateV4(a.slice('::ffff:'.length));
  }
  return false;
}

async function assertHostnameAllowed(hostname: string): Promise<void> {
  // IP literal? validate directly without DNS.
  if (/^[\d.]+$/.test(hostname)) {
    if (isPrivateV4(hostname)) throw blocked(hostname);
    return;
  }
  if (hostname.includes(':')) {
    if (isPrivateV6(hostname)) throw blocked(hostname);
    return;
  }
  if (hostname === 'localhost') throw blocked(hostname);

  const [a, aaaa] = await Promise.all([
    dohResolve(hostname, 'A'),
    dohResolve(hostname, 'AAAA').catch(() => [] as string[]),
  ]);
  for (const ip of a) if (isPrivateV4(ip)) throw blocked(`${hostname} → ${ip}`);
  for (const ip of aaaa) if (isPrivateV6(ip)) throw blocked(`${hostname} → ${ip}`);
}

function blocked(host: string): Error & { kind: string } {
  const e = new Error(`Refusing to fetch private address: ${host}`) as Error & { kind: string };
  e.kind = 'blocked_address';
  return e;
}

async function dohResolve(name: string, type: 'A' | 'AAAA'): Promise<string[]> {
  const url = `${DOH_URL}?name=${encodeURIComponent(name)}&type=${type}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/dns-json' },
    cf: { cacheTtl: 60 },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { Answer?: { type: number; data: string }[] };
  if (!data.Answer) return [];
  const want = type === 'A' ? 1 : 28;
  return data.Answer.filter((a) => a.type === want).map((a) => a.data);
}
