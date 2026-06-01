# Kaiveron — AWS infrastructure as code

This folder codifies the AWS resources that today run the backend at
`api.kaiveron.com`. Everything in here was originally created by hand
via the AWS Console / CLI during the migration off Render in May–Jun 2026;
Terraform is now the source of truth.

## Layout

```
infra/
├── main.tf              # Provider + RDS + App Runner + Security Group
├── variables.tf         # Inputs (region, instance sizes, etc.)
├── outputs.tf           # ARNs + endpoints, useful for cross-referencing
├── terraform.tfvars     # Per-environment values (gitignored — contains secrets)
└── README.md
```

## First run on a new machine

```bash
brew install terraform
cd infra/
terraform init

# Import the live resources so Terraform doesn't try to re-create them:
terraform import aws_security_group.rds        sg-0759edd222f95d3e3
terraform import aws_db_instance.prod          kaiveron-prod
terraform import aws_apprunner_service.backend arn:aws:apprunner:us-east-1:106751263654:service/kaiveron-backend/2194b82380a34eb5b7821fa1452593ab

# Verify zero drift — we should see "No changes":
terraform plan
```

## Day-to-day

- Want to bump the RDS class? Edit `main.tf:db_instance_class`, then
  `terraform plan` → review → `terraform apply`.
- Want to add an env var to App Runner? Edit `runtime_environment_variables`
  in `main.tf`, `terraform plan`, apply.
- **Secrets stay out of TF.** `DATABASE_URL`, `JWT_*` etc. live in
  Secrets Manager (see `docs/runbooks/secrets-manager-migration.md`)
  and are referenced via `runtime_environment_secrets` once the
  migration runs.

## Drift detection

Run weekly (or after any console click):

```bash
terraform plan -detailed-exitcode
# Exit 0 = no drift, Exit 2 = drift detected, Exit 1 = error
```

CI can run this as a scheduled job once we have a real ops cadence.

## What this does NOT manage (yet)

- The Vercel frontend project (managed via Vercel CLI / Console)
- The Hostinger DNS zone for `kaiveron.com` (managed via Hostinger API)
- The ACM certificate (created on demand by App Runner custom domain flow)
- IAM users — managed manually because they need MFA setup in the Console

Add them if/when they become churny.
