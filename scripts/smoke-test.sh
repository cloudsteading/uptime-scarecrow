#!/usr/bin/env bash
# End-to-end smoke test for local Uptime Scarecrow.
# Assumes `npm run dev` (which runs both the app and scheduler) is up.
# Override APP_PORT if Astro's auto-fallback picked a different port.
#
# Usage: ./scripts/smoke-test.sh   (or)   APP_PORT=4323 ./scripts/smoke-test.sh
set -euo pipefail

APP="http://localhost:${APP_PORT:-4322}"
SCH="http://localhost:8788"
PASS=0
FAIL=0
say() { printf '%s\n' "$*"; }
ok()  { say "  ✓ $*"; PASS=$((PASS+1)); }
bad() { say "  ✗ $*"; FAIL=$((FAIL+1)); }

say "== App reachable on $APP =="
if curl -fsS "$APP/" -o /dev/null; then ok "GET / → 200"; else bad "GET / failed — is npm run dev running on $APP?"; fi
if curl -fsS "$APP/about" -o /dev/null; then ok "GET /about → 200"; fi
if curl -fsS "$APP/incidents" -o /dev/null; then ok "GET /incidents → 200"; fi
if curl -fsS "$APP/settings" -o /dev/null; then ok "GET /settings → 200"; fi

say
say "== Scheduler reachable on $SCH =="
if status=$(curl -fsS "$SCH/" 2>/dev/null); then
  ok "GET / → $status"
  echo "$status" | grep -q '"DB":true' && ok "DB binding visible" || bad "DB binding missing"
  echo "$status" | grep -q '"MONITOR_SCHEDULER":true' && ok "MONITOR_SCHEDULER binding visible" || bad "MONITOR_SCHEDULER binding missing"
  echo "$status" | grep -q '"HEARTBEAT_TRACKER":true' && ok "HEARTBEAT_TRACKER binding visible" || bad "HEARTBEAT_TRACKER binding missing"
else
  bad "Scheduler not responding — is npm run dev:scheduler running on $SCH?"
fi

say
say "== Cron-trigger endpoints =="
for c in '*+*+*+*+*' '5+0+*+*+*' '15+0+*+*+*'; do
  if curl -fsS "$SCH/__scheduled?cron=$c" -o /dev/null; then ok "trigger cron='$c' → 200"; else bad "trigger cron='$c' failed"; fi
done

say
say "== Create a heartbeat monitor with a cron expression =="
RESP=$(curl -fsS -i -X POST "$APP/api/v1/monitors" \
  -H "Origin: $APP" \
  -H "Sec-Fetch-Site: same-origin" \
  -d type=heartbeat \
  -d 'name=smoke-cron-monitor' \
  -d 'schedule_kind=cron' \
  -d 'cron_expression=*/5 * * * *' \
  -d grace_seconds=300 || echo "FAIL")
LOCATION=$(echo "$RESP" | awk -F': ' '/^[Ll]ocation:/ { sub(/\r/,"",$2); print $2 }' | head -1)
if [[ -n "${LOCATION:-}" ]]; then
  ok "POST /api/v1/monitors → 303 → $LOCATION"
else
  bad "POST /api/v1/monitors did not redirect (auth? db? endpoint?)"
fi

say
say "== Create an HTTP monitor =="
RESP=$(curl -fsS -i -X POST "$APP/api/v1/monitors" \
  -H "Origin: $APP" \
  -H "Sec-Fetch-Site: same-origin" \
  -d type=http \
  -d 'name=smoke-http-monitor' \
  -d 'url=https://cloudsteading.com' \
  -d method=GET \
  -d interval_seconds=60 \
  -d timeout_ms=10000 || echo "FAIL")
LOCATION=$(echo "$RESP" | awk -F': ' '/^[Ll]ocation:/ { sub(/\r/,"",$2); print $2 }' | head -1)
if [[ -n "${LOCATION:-}" ]]; then
  ok "POST /api/v1/monitors → 303 → $LOCATION"
else
  bad "HTTP monitor create failed"
fi

say
say "== Summary =="
say "  passed: $PASS"
say "  failed: $FAIL"
[[ $FAIL -eq 0 ]] || exit 1
