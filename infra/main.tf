terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }

  # State stays local for now. Once there's a second operator, move it to
  # an S3 backend with DynamoDB locks.
  # backend "s3" {
  #   bucket = "kaiveron-tf-state"
  #   key    = "infra/terraform.tfstate"
  #   region = "us-east-1"
  #   dynamodb_table = "kaiveron-tf-locks"
  # }
}

provider "aws" {
  region = var.region
}

# ---------------------------------------------------------------------------
# Networking: open Postgres to the world (App Runner is in AWS-managed VPC,
# no static egress IP, so 0.0.0.0/0 + sslmode=require is the simplest path
# until we move App Runner into our own VPC with a NAT). Connection still
# requires the master password.
# ---------------------------------------------------------------------------

resource "aws_security_group" "rds" {
  name        = "kaiveron-rds-public"
  description = "Allow Postgres from anywhere (App Runner uses AWS-managed VPC, no static egress)"

  ingress {
    description = "Postgres from anywhere"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Project = "kaiveron"
    Env     = "prod"
  }

  lifecycle {
    # If a console click changes the description, don't fight it.
    ignore_changes = [description]
  }
}

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

resource "aws_db_instance" "prod" {
  identifier            = var.db_instance_identifier
  engine                = "postgres"
  engine_version        = "16.3"
  instance_class        = var.db_instance_class
  allocated_storage     = var.db_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = "kaiveron"
  username = "kaiveron_admin"
  # Password is set out-of-band (initial CLI bringup + rotated via
  # `aws rds modify-db-instance`) — never committed. Stored in 1Password.

  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = true

  backup_retention_period = var.db_backup_retention_period
  backup_window           = "07:00-08:00"        # UTC; pre-traffic window
  maintenance_window      = "Sun:08:00-Sun:09:00"

  deletion_protection      = true
  skip_final_snapshot      = false
  final_snapshot_identifier = "kaiveron-prod-final-${formatdate("YYYYMMDD", timestamp())}"

  apply_immediately = false

  tags = {
    Project = "kaiveron"
    Env     = "prod"
  }

  lifecycle {
    ignore_changes = [
      # RDS rewrites this every snapshot — don't drift on it
      final_snapshot_identifier,
      # Password is managed elsewhere
      master_user_password,
      # The console may have set things we want to leave alone
      tags,
    ]
  }
}

# ---------------------------------------------------------------------------
# App Runner service (the backend)
# ---------------------------------------------------------------------------

resource "aws_apprunner_service" "backend" {
  service_name = var.service_name

  source_configuration {
    auto_deployments_enabled = true

    authentication_configuration {
      connection_arn = var.github_connection_arn
    }

    code_repository {
      repository_url = var.github_repo

      source_code_version {
        type  = "BRANCH"
        value = var.github_branch
      }

      code_configuration {
        configuration_source = "API"

        code_configuration_values {
          runtime       = "NODEJS_22"
          build_command = "npm ci && npm run build"
          start_command = "node dist/server.js"
          port          = "4000"

          runtime_environment_variables = {
            NODE_ENV                  = "production"
            PORT                      = "4000"
            CATALOG_PROVIDER          = var.catalog_provider
            JIKAN_BASE_URL            = var.jikan_base_url
            CORS_ORIGIN               = var.cors_origin
            FRONTEND_URL              = var.frontend_url
            OAUTH_CALLBACK_BASE       = var.oauth_callback_base
            GOOGLE_CLIENT_ID          = var.google_client_id
            JWT_ACCESS_EXPIRY         = "15m"
            JWT_REFRESH_EXPIRY        = "7d"
            ENABLE_EMAIL_NOTIFICATIONS = "false"
          }

          # Secrets (DATABASE_URL, JWT_*, GOOGLE_CLIENT_SECRET, CRON_SECRET)
          # are intentionally NOT here. They live in App Runner's existing
          # runtime_environment_variables until the Secrets Manager
          # migration runs (see docs/runbooks/secrets-manager-migration.md),
          # at which point they move to runtime_environment_secrets and
          # we add `instance_configuration { instance_role_arn = ... }`.
          #
          # Ignored in the lifecycle below so Terraform doesn't fight with
          # values set by the console / runbook.
        }
      }
    }
  }

  instance_configuration {
    cpu    = "1024"
    memory = "2048"
  }

  health_check_configuration {
    protocol            = "HTTP"
    path                = "/health"
    interval            = 10
    timeout             = 5
    healthy_threshold   = 1
    unhealthy_threshold = 5
  }

  tags = {
    Project = "kaiveron"
    Env     = "prod"
  }

  lifecycle {
    ignore_changes = [
      # Secrets, custom domain, and CPU bumps happen outside TF for now.
      source_configuration[0].code_repository[0].code_configuration[0].code_configuration_values[0].runtime_environment_variables,
      source_configuration[0].code_repository[0].code_configuration[0].code_configuration_values[0].runtime_environment_secrets,
      instance_configuration[0].instance_role_arn,
    ]
  }
}
