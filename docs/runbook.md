# Runbook

Operational procedures.

## Healthcheck

```bash
curl https://api.animeunwatched.com/healthz
# expect: { "ok": true }
```

## Tail logs (prod)

```bash
docker logs -f aw-api
```

## Apply pending migrations (prod)

Migrations run automatically on container start in non-dev. To force:

```bash
docker exec aw-api npx prisma migrate deploy
```

## Rotate JWT secrets

1. Generate new secrets: `openssl rand -hex 32` (twice).
2. Update env vars on host: `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`.
3. Restart API container.
4. **All sessions are invalidated.** Users must log in again. Communicate before doing this in prod.

## Swap catalog provider

```bash
./scripts/swap.sh <provider>
docker compose restart api
```

Watch logs for any 5xx spike on `/anime/*` for 10 minutes.

## Reset rate-limit blocks

Rate limits are in-process; restarting the API clears them.

## Ban a user manually

```bash
docker exec -it aw-api node -e \
  "require('./dist/config/prisma').prisma.user.update({ where: { username: 'baduser' }, data: { isBanned: true }}).then(()=>process.exit(0))"
```

## Investigate a slow endpoint

1. `/metrics` Prometheus endpoint.
2. Check Grafana dashboard "Backend p95 by route".
3. Pull traces from Sentry for that route name.
4. If DB-bound, `EXPLAIN ANALYZE` the suspect query in `psql`.

## Database backup / restore

Backups handled by managed Postgres. Manual snapshot:

```bash
pg_dump $DATABASE_URL > backup-$(date +%F).sql
```

Restore:

```bash
psql $DATABASE_URL < backup-2026-05-08.sql
```

## On-call escalation

(Fill in once team exists.)

## Incident template

Title: `<date> <severity> <one-line summary>`
Body:
- Impact: who, what, how long
- Detection: how we noticed
- Cause: root cause if known
- Resolution: what we did
- Follow-ups: action items
