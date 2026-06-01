variable "region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "service_name" {
  description = "Logical name for the App Runner service"
  type        = string
  default     = "kaiveron-backend"
}

variable "db_instance_identifier" {
  description = "RDS instance identifier"
  type        = string
  default     = "kaiveron-prod"
}

variable "db_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage" {
  description = "RDS storage in GB"
  type        = number
  default     = 20
}

variable "db_backup_retention_period" {
  description = "How many days of automated snapshots to keep (1 = free tier minimum, 7 recommended once off free tier)"
  type        = number
  default     = 1
}

variable "github_connection_arn" {
  description = "App Runner GitHub connector ARN — get from console after first link"
  type        = string
  default     = "arn:aws:apprunner:us-east-1:106751263654:connection/kaiveron-github/4b91d44a3df84d319e2cc9c8be8f8c1c"
}

variable "github_repo" {
  description = "Repo URL App Runner builds from"
  type        = string
  default     = "https://github.com/darwhite08/animeunwatched-backendnew"
}

variable "github_branch" {
  description = "Branch App Runner watches for auto-deploy"
  type        = string
  default     = "main"
}

variable "cors_origin" {
  description = "Allowed CORS origin for the API (set to https://kaiveron.com once you cut over to the apex)"
  type        = string
  default     = "https://animeunwatched-frontend-delta.vercel.app"
}

variable "frontend_url" {
  description = "Public URL of the frontend, used for OAuth redirects + email links"
  type        = string
  default     = "https://animeunwatched-frontend-delta.vercel.app"
}

variable "oauth_callback_base" {
  description = "Public base URL for OAuth callbacks (must match Google Console)"
  type        = string
  default     = "https://api.kaiveron.com"
}

variable "google_client_id" {
  description = "Google OAuth client ID (public, OK to commit)"
  type        = string
  default     = "869974042597-9cmk2tag4u5f9kb17pc4l8h5dk0pe8ah.apps.googleusercontent.com"
}

variable "catalog_provider" {
  description = "Which anime catalog provider to use (jikan|mal|anilist)"
  type        = string
  default     = "jikan"
}

variable "jikan_base_url" {
  description = "Jikan API base URL"
  type        = string
  default     = "https://api.jikan.moe/v4"
}
