# Runbook — Postgres restore (AWS RDS)

> **TL;DR for incident time**
> 1. `aws rds restore-db-instance-from-db-snapshot --db-instance-identifier kaiveron-restore --db-snapshot-identifier <SNAPSHOT_ID>`
> 2. Wait ~10 min for the new instance to be Available
> 3. Repoint App Runner `DATABASE_URL` env var to the new instance endpoint
> 4. Verify via `/api/v1/version` + a smoke read
> 5. Once verified, swap the names: rename the broken instance, then rename the restored one to `kaiveron-prod`

---

## SLO

- **RTO (Recovery Time Objective)**: ≤ 1 hour from incident declared to read traffic restored
- **RPO (Recovery Point Objective)**: ≤ 24 hours of data loss
  - Limited by the current free-tier `--backup-retention-period 1`
  - Upgrade to `--backup-retention-period 7` once we leave free tier (changes RPO to ≤ 5 min thanks to continuous WAL-based point-in-time recovery)

## Backup inventory

- **Automated snapshots**: every day, retained for 1 day (free tier cap).
  ```bash
  aws rds describe-db-snapshots \
    --db-instance-identifier kaiveron-prod \
    --snapshot-type automated \
    --region us-east-1 \
    --query 'DBSnapshots[*].{Id:DBSnapshotIdentifier,Created:SnapshotCreateTime,Status:Status}' \
    --output table
  ```
- **Manual snapshots**: take one before any risky migration:
  ```bash
  aws rds create-db-snapshot \
    --db-instance-identifier kaiveron-prod \
    --db-snapshot-identifier "kaiveron-prod-manual-$(date +%Y%m%d-%H%M%S)" \
    --region us-east-1
  ```

## Full restore procedure

### 1. Identify the snapshot

```bash
aws rds describe-db-snapshots \
  --db-instance-identifier kaiveron-prod \
  --region us-east-1 \
  --query 'sort_by(DBSnapshots, &SnapshotCreateTime)[-1].{Id:DBSnapshotIdentifier,Created:SnapshotCreateTime}'
```

Copy the `Id` value.

### 2. Restore into a NEW instance (never overwrite live)

```bash
SNAP=<snapshot-id-from-step-1>
aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier kaiveron-restore \
  --db-snapshot-identifier "$SNAP" \
  --db-instance-class db.t4g.micro \
  --vpc-security-group-ids sg-0759edd222f95d3e3 \
  --publicly-accessible \
  --region us-east-1
```

### 3. Wait for "available"

```bash
aws rds wait db-instance-available \
  --db-instance-identifier kaiveron-restore \
  --region us-east-1
```

### 4. Get the new endpoint

```bash
aws rds describe-db-instances \
  --db-instance-identifier kaiveron-restore \
  --region us-east-1 \
  --query 'DBInstances[0].Endpoint.Address' --output text
```

### 5. Smoke-test the restored data BEFORE swapping prod

```bash
# Master password is the same as the original — pull from your secret store.
DATABASE_URL="postgresql://kaiveron_admin:<PW>@<NEW_ENDPOINT>:5432/kaiveron?sslmode=require" \
  npx prisma db pull --print | head -50

# Spot-check row counts:
DATABASE_URL="..." psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM \"User\";"
DATABASE_URL="..." psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM \"Post\";"
DATABASE_URL="..." psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM \"Activity\";"
```

### 6. Cut traffic over (only if smoke is green)

```bash
SERVICE_ARN=arn:aws:apprunner:us-east-1:106751263654:service/kaiveron-backend/2194b82380a34eb5b7821fa1452593ab

aws apprunner update-service \
  --service-arn $SERVICE_ARN \
  --source-configuration "$(jq -c \
    --arg url "postgresql://kaiveron_admin:<PW>@<NEW_ENDPOINT>:5432/kaiveron?sslmode=require" \
    '.CodeRepository.CodeConfiguration.CodeConfigurationValues.RuntimeEnvironmentVariables.DATABASE_URL=$url' \
    /tmp/kaiveron-apprunner-config.json)" \
  --region us-east-1
```

App Runner does a rolling restart with the new env. ~3 min to deploy.

### 7. Verify

```bash
curl https://api.kaiveron.com/api/v1/version    # SHA unchanged → service is live
curl https://api.kaiveron.com/health             # 200
# Sign in to https://kaiveron.com — confirm your account exists with the right post count
```

### 8. Rename instances (later — when you have a maintenance window)

```bash
# Old prod becomes the "to-delete" instance
aws rds modify-db-instance --db-instance-identifier kaiveron-prod --new-db-instance-identifier kaiveron-broken --apply-immediately --region us-east-1

# Restored becomes the new prod
aws rds modify-db-instance --db-instance-identifier kaiveron-restore --new-db-instance-identifier kaiveron-prod --apply-immediately --region us-east-1

# Delete the broken one once you're sure (no rollback after this!)
aws rds delete-db-instance --db-instance-identifier kaiveron-broken --skip-final-snapshot --region us-east-1
```

## Restore drill (do this once per quarter — not during an incident)

The goal is to prove the procedure works while nothing is on fire.

1. Take a manual snapshot from prod (Step "Backup inventory" above)
2. Restore it into `kaiveron-drill-YYYYMMDD` (steps 2–4 above, but rename)
3. Run the smoke checks (step 5)
4. Delete the drill instance: `aws rds delete-db-instance --db-instance-identifier kaiveron-drill-YYYYMMDD --skip-final-snapshot --region us-east-1`
5. Document any surprises in this file

## Things that will bite you

- **Snapshot retention is 1 day** on free tier. If the incident is older than yesterday's snapshot, you've lost that data. Bump retention to 7 the moment we leave free tier.
- **`prisma migrate` is NOT in use** — we deploy schema via `prisma db push`. A restored snapshot has the schema as of the snapshot moment. If we shipped a schema change after the snapshot, you'll need to `prisma db push` after the restore.
- **SSL is mandatory** on RDS — `?sslmode=require` in the URL. Skipping it → "no pg_hba.conf entry" error.
- **Security group needs port 5432 open** to whatever talks to the restored DB. Reuses `sg-0759edd222f95d3e3` which is already open to 0.0.0.0/0.
- **Master password is the SAME** as the original (RDS snapshots preserve it). It's in 1Password under "kaiveron-prod-rds-master".
