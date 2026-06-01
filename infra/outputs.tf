output "rds_endpoint" {
  description = "Postgres host:port"
  value       = aws_db_instance.prod.endpoint
}

output "rds_security_group_id" {
  description = "SG to reuse for any throwaway DB clients (e.g. restore drills)"
  value       = aws_security_group.rds.id
}

output "apprunner_service_arn" {
  description = "ARN of the backend service — used by deploys, env updates, restarts"
  value       = aws_apprunner_service.backend.arn
}

output "apprunner_default_url" {
  description = "Default *.awsapprunner.com URL (we use api.kaiveron.com via custom domain)"
  value       = aws_apprunner_service.backend.service_url
}
