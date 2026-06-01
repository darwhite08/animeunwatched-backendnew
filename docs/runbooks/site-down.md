# Runbook — Site is down

> **5-minute triage** — when a user reports the site is broken, work this list
> top to bottom. Each check tells you which layer to dig into next.

---

## 0. Confirm the report (30 sec)

```bash
# Frontend
curl -sS -o /dev/null -w "Vercel /api/version → %{http_code} in %{time_total}s\n" \
  https://animeunwatched-frontend-delta.vercel.app/api/version

# Backend
curl -sS -o /dev/null -w "AWS /health → %{http_code} in %{time_total}s\n" \
  https://api.kaiveron.com/health

# Render fallback (still up during cutover)
curl -sS -o /dev/null -w "Render /health → %{http_code} in %{time_total}s\n" \
  https://kaiveron-backend.onrender.com/health
```

Three possibilities:
- **All three 200** → user-side issue (their network, their cache, their account). Stop here, reply with troubleshooting steps.
- **Vercel 200 but AWS 5xx** → backend is down, jump to §2.
- **Vercel 5xx** → frontend is down, jump to §1.

---

## 1. Frontend is down (Vercel)

```bash
vercel ls animeunwatched-frontend | head -5
```

- **Latest prod is "Error"** → rollback by promoting the previous "Ready" production deploy:
  ```bash
  vercel ls animeunwatched-frontend | grep -E "Ready.*Production" | head -2
  echo y | vercel promote <previous-prod-url>
  ```
- **Latest prod is "Ready" but still 5xx** → check Vercel's dashboard for runtime errors → Sentry frontend project for the error pattern.
- **All deploys "Ready"** → probably a Vercel platform incident: https://www.vercel-status.com/

---

## 2. Backend is down (AWS App Runner)

```bash
SERVICE_ARN=arn:aws:apprunner:us-east-1:106751263654:service/kaiveron-backend/2194b82380a34eb5b7821fa1452593ab
aws apprunner describe-service --service-arn $SERVICE_ARN --region us-east-1 --query 'Service.Status'
```

| App Runner Status | Action |
|---|---|
| `RUNNING` but `/health` returns 5xx | Code-level error — jump to §3 (logs + Sentry) |
| `OPERATION_IN_PROGRESS` | A deploy is mid-flight. Wait 5 min. |
| `CREATE_FAILED` or `UPDATE_FAILED` | Last deploy failed. Roll back: |
| `PAUSED` | Manually paused. Resume: `aws apprunner start-deployment --service-arn $SERVICE_ARN --region us-east-1` |

### Roll back to the previous deploy

App Runner doesn't have native "redeploy previous SHA" — but you can re-trigger from any commit:

```bash
# Find the last working commit
cd ~/Desktop/animeunwatched/animeunwatched-backendnew
git log --oneline -10

# Push a revert to main → App Runner auto-deploys
git revert <bad-sha>
git push origin main
```

Or **fast cutover** — point Vercel back at the Render backend while we debug:

```bash
cd ~/Desktop/animeunwatched/animeunwatched-frontend
echo y | vercel env rm NEXT_PUBLIC_API_BASE production --yes
echo y | vercel env rm NEXT_PUBLIC_SOCKET_URL production --yes
echo y | vercel env rm API_BASE production --yes
echo "https://kaiveron-backend.onrender.com" | vercel env add NEXT_PUBLIC_API_BASE production
echo "https://kaiveron-backend.onrender.com" | vercel env add NEXT_PUBLIC_SOCKET_URL production
echo "https://kaiveron-backend.onrender.com" | vercel env add API_BASE production
git commit --allow-empty -m "rollback: point frontend back at Render backend"
git push origin production
# Then promote the new preview → prod via the standard 'vercel promote'
```

---

## 3. Backend is RUNNING but errors are flowing

### 3a. Sentry — anyone hitting this?

https://sentry.io → kaiveron-backend project → "Issues" tab → filter "Last 1 hour"

If yes, the stack trace tells you the file + line. Fix and push.

### 3b. CloudWatch logs

```bash
SERVICE_ARN=arn:aws:apprunner:us-east-1:106751263654:service/kaiveron-backend/2194b82380a34eb5b7821fa1452593ab
LOG_GROUP=$(aws apprunner describe-service --service-arn $SERVICE_ARN --region us-east-1 --query 'Service.SourceConfiguration.AutoDeploymentsEnabled' --output text 2>/dev/null)
# App Runner log groups follow: /aws/apprunner/<service-name>/<service-id>/application
aws logs tail "/aws/apprunner/kaiveron-backend/2194b82380a34eb5b7821fa1452593ab/application" --since 10m --region us-east-1 --follow
```

Filter for ERROR-level:

```bash
aws logs filter-log-events --log-group-name "/aws/apprunner/kaiveron-backend/..." \
  --filter-pattern '{ $.level = 50 }' --since 1h --region us-east-1
```

(`level: 50` in pino = `error`)

### 3c. Quote the X-Request-ID

If a user reports a specific failure, ask them to grab the response header `X-Request-ID`. Then:

```bash
aws logs filter-log-events --log-group-name "/aws/apprunner/kaiveron-backend/..." \
  --filter-pattern "<request-id>" --region us-east-1
```

That gives you the exact request's lifecycle in logs.

---

## 4. Database is down

```bash
aws rds describe-db-instances --db-instance-identifier kaiveron-prod --region us-east-1 \
  --query 'DBInstances[0].{Status:DBInstanceStatus,Endpoint:Endpoint.Address}'
```

| Status | Action |
|---|---|
| `available` | DB is up. The issue is upstream (App Runner can't reach it — check security group). |
| `storage-full` | Bump storage: `aws rds modify-db-instance --db-instance-identifier kaiveron-prod --allocated-storage 30 --apply-immediately --region us-east-1` |
| `failed`, `incompatible-credentials`, `incompatible-network` | Severe — open AWS support case immediately. While that's in flight, restore from the most recent snapshot per [`db-restore.md`](./db-restore.md). |

---

## 5. Communicate

Even pre-launch, post in a personal channel (Slack DM to yourself or a Discord channel) what happened + when it was fixed. Future-you will want the timestamp when you write the post-incident review.

## 6. Post-incident (within 24h of recovery)

Write a one-page note in `docs/incidents/YYYY-MM-DD-description.md`:
- Symptoms users saw
- Real root cause
- Timeline (detected, escalated, mitigated, resolved)
- What surprised you
- One concrete preventive action

Don't blame people. Look for missing controls, missing alerts, missing tests.
