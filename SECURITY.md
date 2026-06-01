# Security notes for operators

## Secrets

### Where they live today (2026-06-02)

- **AWS App Runner runtime env vars** — production source of truth.
  Edit via `aws apprunner update-service` or the AWS Console.
- **Vercel env vars** — frontend `NEXT_PUBLIC_*` values.
  Edit via `vercel env add/rm` or the Vercel Console.
- **`~/Desktop/animeunwatched/aws.env`** — local copy used during the
  initial AWS migration. **Move to a password manager
  (1Password / Bitwarden) and delete from disk** once AWS is stable for
  ~1 week.
- **`~/Desktop/animeunwatched/KEYS.md`** — Render-era credential dump.
  **Delete** once the Render service is shut down (no rollback needed).
- **`/tmp/kaiveron-*.txt`** — ephemeral; rebooting the laptop clears
  them. Still, scrub manually if you finish a session and don't need
  them again: `shred -u /tmp/kaiveron-*.txt`.

### Rotation schedule

| Secret | Rotate when | Rotate how |
|---|---|---|
| Hostinger API token | Anytime exposed in chat / shared; otherwise quarterly | Hostinger → API tokens → revoke + generate new |
| AWS RDS master password | Quarterly, or on any suspected leak | `aws rds modify-db-instance --master-user-password '<NEW>' --apply-immediately` → update `DATABASE_URL` in App Runner env |
| JWT_ACCESS_SECRET + JWT_REFRESH_SECRET | Annually, or after a suspected breach (invalidates all live sessions) | Generate with `openssl rand -base64 64`, update both App Runner env vars at the same time |
| Google OAuth client secret | Only if leaked | Google Cloud Console → Credentials → Reset secret |
| Sentry DSN | If publicly exposed (rare since it's read-only by design) | New Sentry project → migrate |
| GitHub `kaiveron-deploy` access key | Quarterly | `aws iam create-access-key` → update local `aws configure` → `aws iam delete-access-key <old>` |

### Anti-patterns to never commit

- `.env`, `aws.env`, `KEYS.md` — already in `.gitignore`; double-check before commits
- Plaintext private keys in any committed file
- Hardcoded API tokens (Hostinger / Sentry / OAuth) in source

## Headers & transport

- HSTS enabled (2y + includeSubDomains + preload) on both frontend (`next.config.ts`)
  and backend (`helmet.hsts` in `app/app.ts`)
- TLS-only: all `kaiveron.com` subdomains served via Vercel cert + AWS ACM cert
- CSP allows only known origins (see `next.config.ts:BACKEND_ORIGINS`)
- `Cross-Origin-Opener-Policy: same-origin-allow-popups` (Spectre defense;
  Google OAuth keeps working via FedCM)

## Auth

- Passwords: **argon2id** (`argon2` npm package, default config)
- JWT: HS256 with 64-byte secrets, 15-min access + 7-day refresh
- Refresh tokens are **rotated** on every use (`auth.service.ts`)
- Refresh cookie is `httpOnly; secure; sameSite=lax`
- Login + write endpoints are rate-limited (in-memory token bucket; OK
  until we scale to >1 backend instance — then move to Redis)

## Things known to be on the to-do list

- Move secrets from plaintext env → **AWS Secrets Manager** (then
  reference from App Runner via `--secrets`). Lower urgency at current
  scale.
- **Cloudflare Turnstile** on signup + post (spec'd in
  `FEED_FEATURES.md §12`, not yet integrated).
- **Audit log** beyond `SecurityEvent` — add coverage for
  moderation actions, account deletions, role changes.

## If you suspect a breach

1. Rotate the master password (RDS) + both JWT secrets in the same
   App Runner env update — invalidates every live session.
2. Force-revoke all refresh tokens at the DB:
   ```sql
   DELETE FROM "RefreshToken";
   ```
3. Check Sentry + CloudWatch for anomalous patterns in the prior 7 days.
4. Snapshot the DB before doing anything destructive (creates an
   audit trail).
5. Open AWS support if the suspected vector is an AWS service.
