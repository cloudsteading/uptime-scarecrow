// Flash messages: short-lived single-use cookie that survives one redirect.
// API routes call flashRedirect(ctx, '/somewhere', 'Saved'). Middleware reads
// the cookie on the next request, exposes Astro.locals.flash to the layout,
// and clears the cookie so a refresh doesn't re-show. URL stays clean.

import type { APIContext } from 'astro';

export type Flash = { msg: string; kind: 'ok' | 'err' };

const COOKIE = 'flash';

function buildSetCookie(value: string, maxAge: number): string {
  // SameSite=Lax so the cookie is included on the same-origin redirect
  // navigation but not on cross-site requests. HttpOnly so JS can't read
  // raw cookie state — flash is delivered to the page via a meta tag.
  // Secure flag relies on the deployment being https; safe to include
  // unconditionally because dev runs on localhost where browsers ignore it.
  return `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Lax; HttpOnly; Secure`;
}

export function flashRedirect(
  ctx: APIContext,
  location: string,
  msg: string,
  kind: Flash['kind'] = 'ok',
): Response {
  const res = ctx.redirect(location, 303);
  const value = encodeURIComponent(JSON.stringify({ msg, kind }));
  // 30s is plenty for redirect → page load on any reasonable connection
  // and bounded enough that an interrupted nav doesn't leave a stale flash.
  res.headers.append('Set-Cookie', buildSetCookie(value, 30));
  return res;
}

export function readFlash(req: Request): Flash | null {
  const cookie = req.headers.get('Cookie') ?? '';
  const m = cookie.match(/(?:^|;\s*)flash=([^;]*)/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(m[1])) as Flash;
    if (typeof parsed?.msg !== 'string' || (parsed.kind !== 'ok' && parsed.kind !== 'err')) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearFlashHeader(headers: Headers): void {
  headers.append('Set-Cookie', buildSetCookie('', 0));
}
