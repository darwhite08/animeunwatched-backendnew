# Runbook — migrate App Runner env vars to AWS Secrets Manager

**Why:** Today the prod secrets (DATABASE_URL, JWT_*, GOOGLE_CLIENT_SECRET,
CRON_SECRET) sit in App Runner's `RuntimeEnvironmentVariables` map as
plaintext. They are not in Git and only visible to IAM principals with
`apprunner:DescribeService` — adequate for current scale, but Secrets Manager
gives us rotation, audit-trailed access, and removes the values from
`aws apprunner describe-service` output.

**Status:** runbook ready; not yet executed because the `kaiveron-deploy`
IAM user lacks `iam:CreateRole`. Attach the policy below, then run the
script in §3.

**Estimated downtime:** ~3 minutes (App Runner rolling restart).

---

## 1. Grant IAM permissions on the deploy user

The deploy user needs to create the instance role and attach the
Secrets Manager read policy. The simplest path is the AWS-managed
`IAMFullAccess`, but a tighter inline policy works too:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowAppRunnerInstanceRole",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole",
        "iam:PutRolePolicy",
        "iam:AttachRolePolicy",
        "iam:GetRole",
        "iam:PassRole"
      ],
      "Resource": "arn:aws:iam::106751263654:role/AppRunnerInstanceRole-kaiveron"
    },
    {
      "Sid": "AllowSecretsManagerWriteOnce",
      "Effect": "Allow",
      "Action": [
        "secretsmanager:CreateSecret",
        "secretsmanager:PutSecretValue",
        "secretsmanager:UpdateSecret",
        "secretsmanager:DescribeSecret",
        "secretsmanager:ListSecrets"
      ],
      "Resource": "*"
    }
  ]
}
```

Apply via Console → IAM → Users → `kaiveron-deploy` → Add permissions →
Create inline policy.

## 2. Create the instance role

```bash
cat > /tmp/apprunner-instance-trust.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "tasks.apprunner.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}
EOF

aws iam create-role \
  --role-name AppRunnerInstanceRole-kaiveron \
  --assume-role-policy-document file:///tmp/apprunner-instance-trust.json
```

Attach the read policy (scoped to our prefix):

```bash
cat > /tmp/secrets-read.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["secretsmanager:GetSecretValue"],
    "Resource": "arn:aws:secretsmanager:us-east-1:106751263654:secret:kaiveron/prod/*"
  }]
}
EOF

aws iam put-role-policy \
  --role-name AppRunnerInstanceRole-kaiveron \
  --policy-name ReadKaiveronProdSecrets \
  --policy-document file:///tmp/secrets-read.json
```

## 3. Create the secrets

Pull the current values from App Runner's env, then create them:

```bash
# Read current values (do NOT echo them to history)
aws apprunner describe-service \
  --service-arn arn:aws:apprunner:us-east-1:106751263654:service/kaiveron-backend/2194b82380a34eb5b7821fa1452593ab \
  --region us-east-1 \
  --query 'Service.SourceConfiguration.CodeRepository.CodeConfiguration.CodeConfigurationValues.RuntimeEnvironmentVariables' \
  > /tmp/kaiveron-env.json
chmod 600 /tmp/kaiveron-env.json

# Move five secrets in parallel
for K in DATABASE_URL JWT_ACCESS_SECRET JWT_REFRESH_SECRET GOOGLE_CLIENT_SECRET CRON_SECRET; do
  V=$(jq -r ".$K" /tmp/kaiveron-env.json)
  aws secretsmanager create-secret \
    --name "kaiveron/prod/$K" \
    --secret-string "$V" \
    --region us-east-1 &
done
wait

shred -u /tmp/kaiveron-env.json
```

## 4. Update the App Runner service to reference the secrets

App Runner accepts `RuntimeEnvironmentSecrets` (a map of env-var-name → ARN).
The plaintext entries for those five keys must be **removed** from
`RuntimeEnvironmentVariables` at the same time, or the plain value will win.

```bash
ACCOUNT=106751263654
SVC=arn:aws:apprunner:us-east-1:106751263654:service/kaiveron-backend/2194b82380a34eb5b7821fa1452593ab
ROLE=arn:aws:iam::106751263654:role/AppRunnerInstanceRole-kaiveron

# Build the updated source config from a known-good template
cp /tmp/kaiveron-apprunner-config.json /tmp/cfg-with-secrets.json

jq --arg role "$ROLE" --arg acct "$ACCOUNT" '
  .CodeRepository.CodeConfiguration.CodeConfigurationValues
  |= ( .RuntimeEnvironmentVariables
       |= ( del(.DATABASE_URL, .JWT_ACCESS_SECRET, .JWT_REFRESH_SECRET,
                .GOOGLE_CLIENT_SECRET, .CRON_SECRET) )
     | .RuntimeEnvironmentSecrets = {
         "DATABASE_URL":         ("arn:aws:secretsmanager:us-east-1:" + $acct + ":secret:kaiveron/prod/DATABASE_URL"),
         "JWT_ACCESS_SECRET":    ("arn:aws:secretsmanager:us-east-1:" + $acct + ":secret:kaiveron/prod/JWT_ACCESS_SECRET"),
         "JWT_REFRESH_SECRET":   ("arn:aws:secretsmanager:us-east-1:" + $acct + ":secret:kaiveron/prod/JWT_REFRESH_SECRET"),
         "GOOGLE_CLIENT_SECRET": ("arn:aws:secretsmanager:us-east-1:" + $acct + ":secret:kaiveron/prod/GOOGLE_CLIENT_SECRET"),
         "CRON_SECRET":          ("arn:aws:secretsmanager:us-east-1:" + $acct + ":secret:kaiveron/prod/CRON_SECRET")
       } )
' /tmp/cfg-with-secrets.json > /tmp/cfg-with-secrets.out.json

aws apprunner update-service \
  --service-arn "$SVC" \
  --source-configuration "$(cat /tmp/cfg-with-secrets.out.json)" \
  --instance-configuration "Cpu=1024,Memory=2048,InstanceRoleArn=$ROLE" \
  --region us-east-1
```

App Runner does a rolling restart (~3 min). Verify:

```bash
curl https://api.kaiveron.com/health        # → 200
curl https://api.kaiveron.com/api/v1/version
```

## 5. Rotation (the actual reason we're moving)

```bash
# Generate a new value and put it as a new secret version
aws secretsmanager put-secret-value \
  --secret-id kaiveron/prod/JWT_ACCESS_SECRET \
  --secret-string "$(openssl rand -base64 64)" \
  --region us-east-1

# Then bounce App Runner so it picks up the new version
aws apprunner start-deployment \
  --service-arn arn:aws:apprunner:us-east-1:106751263654:service/kaiveron-backend/2194b82380a34eb5b7821fa1452593ab \
  --region us-east-1
```

(Rotating JWT secrets invalidates every signed-in session — coordinate with
users or do during a low-traffic window.)

## 6. After cutover

- Delete `~/Desktop/animeunwatched/aws.env` (no longer the source of truth).
- Update `SECURITY.md` "Where they live today" to point at Secrets Manager.
- Add a CloudWatch alarm on `AWS/SecretsManager` `GetSecretValue` errors.
