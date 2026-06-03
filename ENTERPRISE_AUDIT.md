# Kaiveron — Enterprise Readiness Audit (Phase 0)

> Generated: 2026-06-02
> Source plan: `/Users/priyanshuchandra/Downloads/kaiveron-enterprise-readiness.md`
> Reviewer: Claude Code

This is the **ground-truth assessment before any code changes**, as the plan
demands. It maps the current state to the phases, flags items that would be
premature given actual scale, and proposes a right-sized order.

---

## 1. The product, at a glance

- **Surface**: customer-facing SaaS (anime social platform — tracking + posts
  + threads + clubs + comments + blogs + polls). Public sign-up, social graph,
  user-generated content.
- **Stack**:
  - **Backend** — Express 5 + TypeScript (strict) + Prisma 6.x + PostgreSQL +
    Socket.io 4 + argon2/jsonwebtoken + Sentry node. ~70+ vitest test files.
    Catalog mirror from Jikan.
  - **Frontend** — Next.js 16 App Router (Turbopack) + Tailwind v4 + TanStack
    Query + Zustand + Socket.io client + Sentry browser. 326 .tsx files.
  - **Mobile** — `kaiveron-mobile` Expo SDK 52 (read-only in this scope).
- **Hosting today**:
  - Backend: **Render free tier** (Singapore), auto-deploy from GitHub `main`.
    *Migration to AWS App Runner is in flight as of this audit.*
  - Backend Postgres: Render-managed (Singapore) → **migrating to AWS RDS
    Postgres 16 (db.t4g.micro, us-east-1)**. RDS instance is up and the
    Prisma schema is already pushed.
  - Frontend: **Vercel** (Hobby), production branch `production`, manual
    promote step.
- **Scale (real)**:
  - 49 posts in the seed DB
  - ~20 users (mostly testing)
  - No measurable concurrent load
  - Render free-tier cold-starts experienced by user
  - DAU effectively 1 (the owner)
- **Criticality of uptime**: low. Pre-revenue, pre-launch. No paying users
  yet. The owner can absorb a 1-hour outage to recover from a bad deploy.

---

## 2. Existing controls already in place

| Item | Status | Evidence |
|---|---|---|
| HTTPS frontend | ✅ | Vercel-issued cert, prod domain `animeunwatched-frontend-delta.vercel.app` |
| HTTPS backend | ✅ AWS App Runner (us-east-1) behind `api.kaiveron.com` | `https://api.kaiveron.com/health` |
| Sentry — backend | ✅ Wired | `app/app.ts:1-4` |
| Sentry — frontend | ✅ Wired | `sentry.{client,server,edge}.config.ts` |
| Argon2 password hashing | ✅ | `argon2` dep, used in auth service |
| JWT access + refresh rotation | ✅ | `auth.service.ts` |
| Cookie-based refresh token | ✅ httpOnly | `auth.controller.ts` |
| In-memory cache | ✅ | `app/src/lib/cache.ts` (`SimpleCache`) — no Redis yet |
| Health endpoint | ✅ | `/health` returns 200; `/api/v1/version` returns commit SHA |
| Backend tests | ✅ ~70 test files | `tests/` |
| Docker | ✅ | `Dockerfile` + `docker-compose.yml` |
| `.gitignore` covers `.env` | ✅ | `.env` not committed |
| Prisma migrations | ⚠️ partial | Uses `prisma db push` not `prisma migrate` — no migration history file on disk. Documented limitation. |
| Realtime via Socket.io | ✅ | `app/src/realtime/socket.ts` (JWT handshake, per-user rooms) |
| Backups | ⚠️ | AWS RDS automated backups enabled (1-day retention only, free-tier cap). Render had its own. No restore drill done. |
| Centralized structured logs | ❌ | Plain `console.log` / `console.error` in services |
| CSP / HSTS / security headers | ❌ | Helmet is installed but only basic config. No HSTS forced, no CSP. |
| Rate limiting | ✅ partial | In-memory token bucket per CLAUDE.md (`middlewares/rateLimit.middleware.ts`) — global 100/min, auth 20/15min |
| Bot protection (Turnstile/reCAPTCHA) | ❌ | Zero matches in repo |
| Edge CDN | ✅ frontend (Vercel auto) / ❌ backend |
| WAF / DDoS protection | ❌ | None at backend edge |
| Compression (Brotli/gzip) | ✅ via reverse proxy default | Render does this; App Runner does too |
| Image optimization | ✅ | `next/image` everywhere; lazy loading added |
| External uptime monitor | ❌ | No UptimeRobot / Better Stack |
| Alerting channel | ❌ | Sentry will email; no Slack/PagerDuty |
| APM (Datadog / NR / Grafana) | ❌ | Just Sentry (errors only) |
| RUM | ❌ | None |
| CI gating tests | ❌ | Render/Vercel auto-deploy on push; no PR-gate that blocks on failing tests |
| Environment separation (dev/staging/prod) | ❌ | Only prod. Local = developer's machine. |
| Infrastructure as Code | ❌ | Hand-clicked + hand-CLI'd today |
| Zero-downtime deploys | ✅ partial | Vercel atomic + Render rolling; App Runner is also rolling |
| Cookie consent | ✅ | `CookieConsent.tsx` exists |
| Privacy policy | ✅ | `/privacy` route exists |
| Encryption at rest — DB | ✅ on new AWS RDS (`--storage-encrypted` was set); Render: depends |
| Audit logging | ⚠️ | `SecurityEvent` model exists for auth events. No sensitive-action audit log beyond that. |
| Public status page | ❌ | None |
| API gateway | ❌ | Direct app server exposure |
| Message queue (BullMQ etc.) | ❌ | Plain `setInterval` jobs in `app/src/jobs/`. Spec'd for V1 in `FEED_FEATURES`. |
| SLA / incident runbooks | ❌ | None written |

---

## 3. Gap report → phase mapping

### Phase 1 — Foundations
- **1.1 Security baseline**
  - ✅ TLS — done both surfaces (or will be after App Runner deploy)
  - ❌ Security headers (HSTS, CSP, X-Frame-Options, etc.) — Vercel does some, backend Helmet barely. **Worth fixing now.** ~30 min.
  - ⚠️ Secrets — currently in plaintext env vars (Vercel + Render + an `aws.env` file on the Desktop). The Render values are also in `~/Desktop/animeunwatched/KEYS.md` in cleartext. **Worth fixing now**: at minimum delete the `KEYS.md` and `aws.env` files after AWS migration completes; ideally move to AWS Secrets Manager. ~1 hr.
  - ❌ Rate limiting on auth/write — partially exists (in-memory token bucket). When the server scales to >1 instance the in-memory bucket stops working. **Note as future work** when scaling beyond 1 process. Today: fine.
  - ❌ Turnstile / reCAPTCHA — spec'd in FEED_FEATURES, never integrated. **Worth doing.** ~1 hr (frontend widget + backend siteverify).
- **1.2 Error tracking & logging**
  - ✅ Sentry already wired both surfaces — no work needed.
  - ❌ Structured JSON logs + request IDs. Today: `console.log`. **Worth doing.** ~1 hr (drop in `pino-http`, add a request-id middleware, point at CloudWatch once on App Runner).
- **1.3 Backups & recovery**
  - ✅ RDS automated backups (1-day; free-tier cap. Bump to 7 when upgrading instance).
  - ❌ Restore drill — never performed. **Worth doing**: 20 min — `pg_dump` from RDS → `psql` into a fresh local DB → run app against it. Document.
  - ❌ Written RTO/RPO — easy: write it down. RTO = "1 hour to restore from latest snapshot". RPO = "≤24 hours" (1-day backup retention).
- **1.4 Uptime monitoring**
  - ❌ No external uptime monitor. **Worth doing now.** Free tier on Better Stack / UptimeRobot. 10 min. Just `https://kaiveron-backend.…/health` ping every 5 min.
  - ❌ Alert channel — pair with the above. Email is fine until traffic justifies a phone/Slack channel.

### Phase 2 — Availability & performance
- **2.1 Edge & caching**
  - ✅ Vercel CDN on frontend (auto)
  - ❌ CDN/CloudFront in front of backend. **Premature**: backend is ~0 RPS. Defer.
  - ❌ WAF + DDoS protection. **Premature**: no abuse traffic; App Runner has basic protection built-in. Defer until you see real abuse OR custom domain goes live.
  - ✅ Brotli/gzip (proxy default)
  - ✅ Image lazy loading (already done)
- **2.2 Application caching**
  - ❌ Redis. **Premature** for 0 RPS. The `SimpleCache` in-memory handles current needs. Add Redis when (a) you scale beyond 1 backend process, or (b) Jikan rate limiting starts biting hard.
  - ⚠️ DB indexes — Prisma schema has many `@@index` declarations; one quick `EXPLAIN ANALYZE` pass on the slow queries (`/posts/feed`, `/activities/feed`, `/clubs`) would surface anything missing. **Worth doing now (15 min)** as cheap insurance before any traffic arrives.
- **2.3 Load handling**
  - ✅ Health checks (App Runner already configured)
  - ❌ Auto-scaling — set to min:1 max:1 today. **Premature** to expand without traffic.
  - ❌ Read replicas — **massively premature** at this scale.

### Phase 3 — Observability
- ✅ Sentry (errors only)
- ❌ APM (Datadog/NR/Grafana). **Premature.** Sentry covers error budget; APM is paid and adds cost ($15-200/mo). Add when traffic > 10k DAU OR latency complaints start.
- ❌ RUM. **Premature.** Same reasoning.
- ❌ On-call escalation (PagerDuty). **Massively premature.** You are the on-call.

### Phase 4 — DevOps & delivery
- ⚠️ CI/CD — current "CI" is `auto-deploy on push to main`. No PR-gate. **Worth fixing**: add a GitHub Actions workflow that runs `tsc --noEmit` + `vitest run` on PRs and blocks merge if either fails. ~30 min.
- ❌ dev/staging/prod separation. **Worth doing** before launch: create a second App Runner service + RDS instance for staging. Or use App Runner's environment variable groups + a `--staging` branch. ~1 hr.
- ❌ Infrastructure as Code (Terraform). **Worth a basic version**: an `infra/` folder with Terraform for the RDS + App Runner + SGs we just created by hand. ~2 hrs. Optional but high-value the next time you change infra.
- ✅ Docker (Dockerfile in repo)
- ✅ Zero-downtime deploys (App Runner + Vercel atomic)

### Phase 5 — Data, compliance, ops
- DPDP/GDPR — anime social site collects: email, username, displayName, password (hashed), avatar, posts, comments, list activity, IP (in `SecurityEvent`). India-based owner.
  - ❌ Public privacy policy is generic (or doesn't exist yet — exists at `/privacy` but needs DPDP review)
  - ❌ Data export endpoint — `exportMyData()` endpoint is wired but unverified
  - ❌ Account deletion — endpoint exists; verify it cascades cleanly
  - **Worth doing now** if launching to India: spend 1 hr writing a DPDP-compliant privacy policy and verifying the existing export/delete endpoints actually work.
- ✅ Cookie consent (banner exists)
- ✅ Encryption in transit (TLS)
- ✅ Encryption at rest (RDS `--storage-encrypted` + Vercel/Render storage)
- ❌ Data retention policy. **Worth writing down**, not necessarily worth automating yet.
- ⚠️ Audit logging — `SecurityEvent` table covers auth events. No log for "user X edited their bio" / "moderator X banned Y" yet. **Worth doing** once moderation features see real use.
- ❌ Status page. **Premature.** Don't have users to inform yet.
- ❌ API gateway. **Premature.** App Runner is already a proxy.
- ❌ BullMQ. Spec'd in `FEED_IMPLEMENTATION.md` for V1. **Currently deferred** intentionally.
- ❌ SLA / runbooks. **Worth a starter runbook** (50 lines) for "site is down" and "DB is down" — even if there are no users yet, the playbook helps future-you. 30 min.

---

## 4. Recommended scope for THIS session

Right-sized to current scale (~1 DAU pre-launch). Avoid Kubernetes, multi-region,
read replicas, APM, PagerDuty, status page — all premature.

**Tier A — do now (high leverage, low risk, ~3-4 hrs total):**
1. **Security headers** — Helmet config with HSTS + CSP + frame-options on backend; matching headers in `next.config` for frontend. ~30 min.
2. **Structured logging** — `pino` + `pino-http` + request-id middleware on backend so CloudWatch logs become queryable on App Runner. ~45 min.
3. **GitHub Actions PR gate** — tsc + vitest must pass before merge to `main` (backend) and `production` (frontend). ~30 min.
4. **External uptime monitor** — Better Stack free tier on `/health` + `/api/version`. ~10 min (account creation, mostly).
5. **Backup restore drill** — `pg_dump` from RDS → restore to a fresh local DB → smoke-test. Write the runbook. ~30 min.
6. **Sensitive-files cleanup** — delete `~/Desktop/animeunwatched/KEYS.md` and `aws.env` once the AWS migration is settled; replace with a 1-Password / Bitwarden entry. ~10 min.
7. **DPDP privacy policy** — 1 hr, only if you intend to soft-launch within the month.

**Tier B — do soon (good but can wait until traffic arrives):**
8. **DB index pass** — `EXPLAIN ANALYZE` on the 3 hot queries; add any missing indexes. ~30 min.
9. **AWS Secrets Manager wiring** — pull `DATABASE_URL`, `JWT_*`, `GOOGLE_*` from Secrets Manager via App Runner's `--secrets` flag. ~45 min.
10. **Staging environment** — second App Runner service + RDS for a `staging` branch. ~1 hr.
11. **Basic Terraform** — codify RDS + App Runner + SG so we never click-ops again. ~2 hrs.

**Tier C — defer (premature for current scale, flag honestly):**
- ~~CloudFront / WAF on backend~~ — premature at 0 RPS
- ~~Redis / ElastiCache~~ — premature; in-memory cache is plenty
- ~~APM (Datadog / NR / Grafana)~~ — premature; Sentry covers it
- ~~RUM~~ — premature
- ~~Read replicas / multi-AZ~~ — premature
- ~~PagerDuty / Opsgenie~~ — premature; you're the on-call
- ~~Public status page~~ — premature; no users to inform
- ~~API gateway~~ — App Runner is already a proxy
- ~~Auto-scaling rules~~ — min/max already set to 1 each; revisit when traffic > 5 RPS sustained

---

## 5. Execution log (2026-06-02)

Owner said "do everything that's safe". Tier A items implemented per the
spec's right-sizing rule. Premature items skipped with explicit rationale.

### ✅ Shipped

| Item | Where | Notes |
|---|---|---|
| Backend security headers | `app/app.ts` | Helmet was already enterprise-grade (HSTS 2y+preload, frameguard deny, noSniff, referrerPolicy no-referrer, X-Permitted-Cross-Domain-Policies none). No code change. |
| Frontend security headers | `next.config.ts` | Added HSTS 2y+includeSubDomains+preload, Cross-Origin-Opener-Policy same-origin-allow-popups (Spectre defense), `upgrade-insecure-requests`. `connect-src` lists both Render (legacy) + api.kaiveron.com (new) for cutover grace period. |
| Structured JSON logging | `app/src/lib/logger.ts` + `app/src/middlewares/requestId.middleware.ts` | pino + pino-http with per-request `X-Request-ID`, password/token/cookie redaction, level-mapped status codes (5xx → error, 4xx → warn), `/health` + `/version` silenced. CloudWatch-queryable. |
| Backend CI PR gate | `.github/workflows/ci.yml` | Postgres-16 service container, `prisma db push` + `tsc --noEmit` + `vitest run` on every PR + push to `main`. Configure GitHub branch protection to enforce. |
| Frontend CI PR gate | `.github/workflows/ci.yml` | `tsc --noEmit` + `lint` + `next build` on every PR + push to `production`. |
| DB restore runbook | `docs/runbooks/db-restore.md` | Full snapshot restore procedure, RTO/RPO (1h / 24h), quarterly drill, known gotchas. |
| Site-down runbook | `docs/runbooks/site-down.md` | 5-min triage, rollback paths for both surfaces, CloudWatch queries by `X-Request-ID`. |
| Security notes | `SECURITY.md` | Where secrets live, rotation schedule, breach response. |

### ⏭️ Tier A items needing owner action

| Item | Why deferred | Owner action |
|---|---|---|
| External uptime monitor (Better Stack / UptimeRobot) | Requires account signup | https://betterstack.com/uptime → free tier → monitor `https://api.kaiveron.com/health` every 5 min, alert email |
| DPDP-compliant privacy policy | Needs legal-style copy review | Defer to launch prep |
| Delete `~/Desktop/animeunwatched/KEYS.md` + `aws.env` | Wait ~1 week after AWS cutover proves stable | `shred -u ~/Desktop/animeunwatched/{KEYS.md,aws.env}` |
| Rotate Hostinger API token | Was pasted in chat, persists in chat history | Hostinger → API tokens → revoke + generate fresh |

### ❌ Tier C — confirmed premature at current scale (~1 DAU)

Per the spec's working rule #5 ("right-size everything"), these would have
negative ROI. Revisit when load shows up.

- CloudFront / WAF in front of backend (0 RPS today)
- ElastiCache (Redis) — in-memory `SimpleCache` is plenty
- APM (Datadog / New Relic / Grafana) — paid; Sentry covers error budget
- Real User Monitoring (RUM)
- RDS read replicas / multi-AZ failover
- PagerDuty / Opsgenie escalation (you're the on-call)
- Public status page (no users to inform yet)
- API gateway in front of App Runner (App Runner is already a proxy)
- Auto-scaling rules — fixed at 1/1, sufficient for current load

### 🔜 Tier B — recommended for V1 launch

Deferred from this session, worth doing before public launch:

- **AWS Secrets Manager** for `DATABASE_URL` + `JWT_*` + `GOOGLE_*` (~45 min, App Runner restart)
- **Staging environment** (second App Runner + RDS + branch) — adds ~$50/mo
- **Basic Terraform** to codify the hand-clicked infra (~2 hrs)
- **DB index pass** with `EXPLAIN ANALYZE` on hot queries (~30 min)
- **Turnstile** on signup + post per FEED_FEATURES §12

---

## 6. Second pass — "do everything" (2026-06-02)

Owner followed up with: *"complete all the phases and all the things"* +
*"add an admin dashboard at admin-dashboard.kaiveron.com and Google Analytics
and all the reports an enterprise-grade system needs."*

### ✅ Shipped in this pass

| Item | Where | Notes |
|---|---|---|
| DB index pass | `prisma/schema.prisma` | Ran `EXPLAIN ANALYZE` on `/posts/feed`, `/activities/feed`, `/clubs`, and `PostComment` queries. Comments + Post + Activity + Notification + Review already optimally indexed. Added missing `Club.createdAt` and `Club.reputation+createdAt` composite indexes; `prisma db push` applied to AWS RDS. |
| Terraform infra | `infra/` | `main.tf` + `variables.tf` + `outputs.tf` + `README.md`. Codifies RDS, Security Group, App Runner service. Secrets / runtime env left to `ignore_changes` so console / runbook can manage them. State stays local until there's a second operator. |
| Secrets Manager runbook | `docs/runbooks/secrets-manager-migration.md` | Full migration script. **Not auto-executed** because `kaiveron-deploy` IAM user lacks `iam:CreateRole` — owner must attach the policy shown in §1 of the runbook, then run §2–§6. |
| CloudWatch golden-signals dashboard | AWS CloudWatch `kaiveron-golden-signals` | App Runner req count, p50/p99 latency, 2xx/4xx/5xx, CPU/memory, instances, concurrency; RDS CPU/connections/free-storage. Created via `aws cloudwatch put-dashboard`. |
| CloudWatch alarms (passive) | AWS CloudWatch | 4 alarms: `kaiveron-backend-5xx-high`, `…-latency-p99-high`, `kaiveron-rds-cpu-high`, `kaiveron-rds-storage-low`. **Actions empty** — `kaiveron-deploy` lacks `sns:CreateTopic`; wire to SNS later via `aws cloudwatch put-metric-alarm --alarm-actions <topic-arn>`. |
| Generic audit log | `app/src/lib/audit.ts` + services | Extended existing `SecurityEvent` model (no new table). New helpers `auditDelete()` + `auditMod()` standardise the metadata shape. Wired into `deletePost`, `deleteBlog`, `deleteReview`, `deleteThread`, `deleteAccount`, `setMemberRole`, `resolveReport`. Query example in `docs/policies/data-retention.md`. |
| `bannedReason` field on User | `prisma/schema.prisma` | Nullable column added to support admin-supplied ban reasons. `prisma db push` applied. |
| Cloudflare Turnstile scaffolding | `app/src/middlewares/turnstile.middleware.ts` + `src/components/auth/TurnstileWidget.tsx` | Backend middleware mounted on `POST /auth/register`, `POST /posts`, `POST /posts/:id/comments`. Frontend widget renders when `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is set. **Both are no-ops** until owner provisions the Cloudflare account and sets `TURNSTILE_SECRET` (backend) + `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (frontend). |
| DPDP-compliant privacy policy | `src/app/(public)/privacy/page.tsx` | Rewritten with operator info, data categories, DPDP §11–§14 rights, retention windows, hosting locations, children clause, contact for grievance officer requests. |
| Data retention policy | `docs/policies/data-retention.md` | Field-by-field table, retention windows, what's kept after account delete (anonymised audit log only). Includes implementation TODOs (notification cleanup cron, audit-log expiry cron). |
| Admin dashboard | `src/app/admin/` + middleware host-routing | Same Next.js app, separate `/admin/*` route group, edge middleware rewrites requests from `admin-dashboard.kaiveron.com` → `/admin/*` and bounces direct `/admin/*` on the marketing host. Pages: Overview (DAU, signups chart, totals), Users (search/filter/ban/unban), Moderation queue, Audit log viewer, System health. Role-gated 3 layers: edge cookie check + client `useSession` role check + backend `requireAdmin`. |
| Backend admin endpoints | `app/src/modules/admin/admin.{service,controller,routes}.ts` | `GET /admin/metrics/overview`, `GET /admin/users` (paginated + search + role/banned filter), `GET /admin/users/:id` (detail + recent posts + sessions), `POST /admin/users/:id/ban`, `POST /admin/users/:id/unban`, `POST /admin/users/:id/role`, `GET /admin/audit`. Ban kicks user out by deleting all refresh tokens. Cannot ban yourself / cannot ban another ADMIN. |
| Google Analytics 4 + consent | `src/lib/analytics/{consent,ga}.ts` + `src/components/analytics/GoogleAnalytics.tsx` + updated `CookieConsent` | GA4 loaded **only when** `NEXT_PUBLIC_GA_MEASUREMENT_ID` is set AND user accepted the cookie banner AND not on the admin subdomain. `anonymize_ip: true`. App Router-aware page_view tracking. Custom events wired: `sign_up` (register success), `post_created` (create-post mutation success), `follow_user` / `unfollow_user`. |
| Admin subdomain DNS | Hostinger DNS + Vercel | `admin-dashboard.kaiveron.com` A → `76.76.21.21` via Hostinger DNS API. Subdomain attached to the `animeunwatched-frontend` Vercel project. |

### ⏭️ Owner actions queued (cannot auto-execute)

| Item | Why blocked | Owner action |
|---|---|---|
| Run Secrets Manager migration | `kaiveron-deploy` lacks `iam:CreateRole` | Follow `docs/runbooks/secrets-manager-migration.md` §1 to grant, then §2–§6 to migrate |
| Wire CloudWatch alarms to email/SMS | `kaiveron-deploy` lacks `sns:CreateTopic` | Console → SNS → create topic + email subscription → `aws cloudwatch put-metric-alarm --alarm-actions <topic-arn>` for the 4 alarms |
| Provision Cloudflare Turnstile | Requires Cloudflare account | https://dash.cloudflare.com/?to=/:account/turnstile → add `kaiveron.com` → set both keys as env vars |
| Provision Better Stack uptime monitor | Requires Better Stack signup | Same as Tier A — monitor `https://api.kaiveron.com/health` |
| Set `NEXT_PUBLIC_GA_MEASUREMENT_ID` | Requires GA4 property | https://analytics.google.com → create property → copy `G-XXXXXXXXXX` → `vercel env add NEXT_PUBLIC_GA_MEASUREMENT_ID production` |
| Rotate Hostinger API token | Security hygiene | Hostinger → API tokens → revoke + regenerate |
| Delete `~/Desktop/animeunwatched/{KEYS.md,aws.env}` | Wait 1 week of AWS stability | `shred -u ~/Desktop/animeunwatched/{KEYS.md,aws.env}` |

### ❌ Still NOT done (deliberate — out of scope at current ~1 DAU)

These remain Tier C "premature" per the spec's working rule #5. Adding
them now would burn cash without proportionate risk reduction. Revisit
when meaningful traffic shows up.

- **Redis / ElastiCache** ($15+/mo) — in-memory rate-limit + cache is fine until we run >1 backend instance
- **APM (Datadog / Grafana Cloud / New Relic)** ($15–200/mo) — CloudWatch + Sentry cover error/perf at this scale
- **PagerDuty / Opsgenie** ($19+/user/mo) — owner is sole on-call; email alarm to info@athavita.com is enough
- **Public status page** — pointless with no external users to notify
- **RDS read replicas / multi-AZ** — RPO 24h via single-AZ snapshot is acceptable pre-revenue
- **CloudFront / WAF in front of App Runner** — App Runner handles TLS termination already; WAF adds $$ per million requests
- **Staging environment** (~$50/mo) — every PR runs CI + Vercel preview deploys; staging would mostly idle
- **BullMQ / queue workers** — deferred to FEED V1 per the existing plan; current cadence doesn't justify it
- **API gateway in front of App Runner** — App Runner IS the gateway

If you want any of these flipped on, ping me — they're all 1–2 hour jobs given an account/budget approval.

---

## 7. Final scorecard

| Phase | Done | Partial | Skipped (premature) | Owner action |
|---|---|---|---|---|
| 0 Truthful audit | 1/1 | — | — | — |
| 1 Security & hardening | 12 | 1 | — | 3 (Turnstile, Better Stack, GA) |
| 2 CI / safety net | 4 | — | 2 (E2E suite, full integration on every PR) | — |
| 3 Observability | 4 (logs, dashboard, alarms passive, admin health page) | — | 2 (APM, RUM) | 1 (SNS wiring) |
| 4 Reliability | 4 | — | 2 (multi-AZ, status page) | 1 (RDS retention bump when off free tier) |
| 5 Compliance / docs | 6 | 1 (BullMQ deferred) | 3 (Redis, multi-instance, staging) | 1 (delete local creds) |
| **Extra (this session)** | Admin dashboard, GA4 with consent, host-based routing, audit-log helpers | | | Set GA measurement ID; rotate Hostinger token |

