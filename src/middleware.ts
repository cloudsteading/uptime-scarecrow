import { defineMiddleware } from 'astro:middleware';
import { env } from 'cloudflare:workers';
import { verifyAccessJwt } from '~/lib/access';
import { upsertUser, isAllowedEmail } from '~/lib/db';
import { readFlash, clearFlashHeader } from '~/lib/flash';

// Auth boundary: only /admin/* (page routes + the /admin/api/v1/* JSON API)
// requires Cloudflare Access. Everything else — public status page at /,
// public monitor detail at /m/<id>, /h/<token> heartbeat ingest, static
// assets — passes through without auth and gets ctx.locals.user = null.
function requiresAuth(path: string): boolean {
  return path === '/admin' || path.startsWith('/admin/');
}

export const onRequest = defineMiddleware(async (ctx, next) => {
  const url = new URL(ctx.request.url);
  const path = url.pathname;

  // Single-use flash cookie. Pulled into locals so the layout can render it;
  // cleared on the response below so a refresh of the destination doesn't
  // re-show the toast.
  const flash = readFlash(ctx.request);
  ctx.locals.flash = flash;

  const finish = async (response: Response): Promise<Response> => {
    if (flash) clearFlashHeader(response.headers);
    return response;
  };

  if (!requiresAuth(path)) {
    ctx.locals.user = null;
    return finish(await next());
  }

  // Dev mode: when Access isn't configured we render with a fake local user
  // so the UI is browseable without infra setup. Gated by an explicit
  // DEV_NO_AUTH=1 var (set in .dev.vars only) — never fall back to a
  // hostname check, because request.url's hostname is derived from the
  // client-controlled Host header. Production deploys never set this var,
  // so the bypass is unreachable regardless of what headers a client sends.
  const accessConfigured = !!env.ACCESS_TEAM_DOMAIN && !!env.ACCESS_AUD;
  const devBypass = env.DEV_NO_AUTH === '1';
  const dbReady = !!env.DB;

  if (!accessConfigured) {
    if (!devBypass) {
      console.error(
        'Access not configured (ACCESS_TEAM_DOMAIN/ACCESS_AUD missing) and DEV_NO_AUTH not set — refusing /admin request',
      );
      return new Response(
        'Service misconfigured: Cloudflare Access is not set up. Set ACCESS_TEAM_DOMAIN and ACCESS_AUD secrets.',
        { status: 503 },
      );
    }
    if (dbReady) {
      try {
        const user = await upsertUser('local-dev@example.com', env.BOOTSTRAP_ADMIN_EMAILS);
        ctx.locals.user = {
          id: user.id,
          email: user.email,
          display_name: user.display_name,
          is_admin: user.is_admin,
        };
      } catch {
        ctx.locals.user = devFakeUser();
      }
    } else {
      ctx.locals.user = devFakeUser();
    }
    return finish(await next());
  }

  const jwt = ctx.request.headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt) {
    return new Response('Unauthorized — Cloudflare Access required', { status: 401 });
  }

  let identity: { email: string };
  try {
    identity = await verifyAccessJwt(jwt, env);
  } catch (err) {
    console.warn('Access JWT rejected', (err as Error).message);
    return new Response('Unauthorized', { status: 401 });
  }

  if (!isAllowedEmail(identity.email, env.ALLOWED_EMAILS)) {
    return new Response('Forbidden — email not on allowlist', { status: 403 });
  }

  const user = await upsertUser(identity.email, env.BOOTSTRAP_ADMIN_EMAILS);
  ctx.locals.user = {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    is_admin: user.is_admin,
  };

  return finish(await next());
});

function devFakeUser(): AppUser {
  return { id: 0, email: 'local-dev@example.com', display_name: 'Local dev', is_admin: 1 };
}
