/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />

interface EmailMessage {
  to: string;
  from: string;
  subject: string;
  html?: string;
  text?: string;
  reply_to?: string;
  headers?: Record<string, string>;
}

interface SendEmailBinding {
  send(msg: EmailMessage): Promise<void>;
}

declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    CACHE: KVNamespace;
    AI: Ai;
    SEND_EMAIL: SendEmailBinding;
    NOTIFY_QUEUE: Queue<NotifyMessage>;
    MONITOR_SCHEDULER: DurableObjectNamespace;
    HEARTBEAT_TRACKER: DurableObjectNamespace;
    ASSETS?: Fetcher;

    APP_NAME: string;
    APP_VERSION: string;

    // Worker secrets via `wrangler secret put`.
    ACCESS_TEAM_DOMAIN?: string;
    ACCESS_AUD?: string;
    ALLOWED_EMAILS?: string;
    BOOTSTRAP_ADMIN_EMAILS?: string;
    EMAIL_FROM?: string;
    APP_BASE_URL?: string;
  }
}

interface NotifyMessage {
  kind: 'incident.open' | 'incident.recover' | 'ssl.expiry_warning';
  monitor_id: number;
  incident_id?: number;
  payload: Record<string, unknown>;
}

type Runtime = import('@astrojs/cloudflare').Runtime<Cloudflare.Env>;

interface AppUser {
  id: number;
  email: string;
  display_name: string | null;
  is_admin: number;
}

// `locals.runtime.env` / `locals.runtime.ctx` are exposed by the Cloudflare
// adapter's platformProxy. We use them in API routes for `ctx.waitUntil(...)`.
declare namespace App {
  interface Locals {
    runtime: Runtime;
    user: AppUser | null;
  }
}
