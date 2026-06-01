# Data retention policy

**Owner:** Priyanshu (info@athavita.com) · **Last reviewed:** 2026-06-02

## Principles

1. We collect the minimum data needed for the service to work and for
   account recovery / abuse defense.
2. Users can delete their account at any time via Settings → Account → Delete.
3. Deletion is **immediate and cascading** for user-owned content
   (posts, comments, list entries, likes, follows, blogs, reviews).
4. We keep a small set of records longer for legal / security reasons,
   listed in §3 below.

## 1. What we collect

| Category | Fields | Source |
|---|---|---|
| Account | email, username, displayName, passwordHash (argon2id), createdAt, role, banner/avatar URLs | User registration |
| OAuth identity | googleId / appleId | OAuth flow |
| Watch list | Anime IDs + status + score per user | User input |
| Social graph | Follow relationships | User clicks |
| Content | Posts, comments, threads, reviews, blogs (with timestamps) | User input |
| Engagement | Likes, reposts, poll votes | User clicks |
| Notifications | recipientId, type, payload (JSON), read flag | System events |
| Sessions | RefreshToken rows: hashed token, expiresAt, IP, user-agent, last-used | Login / refresh |
| Security events | Login attempts, password changes, account deletion, moderation actions | App audit (see `app/src/lib/audit.ts`) |
| Server logs | Pino JSON to CloudWatch — req method, path, status, latency, X-Request-ID | Backend middleware |
| Sentry events | Error stack traces (PII scrubbed where possible) | Backend errors |

## 2. Default retention windows

| Category | Retention | Justification |
|---|---|---|
| Account row | Until user-initiated delete | Identity |
| Watch list / lists | Until account delete | Core feature |
| Posts / comments / threads / blogs / reviews | Until author-initiated soft-delete + 7 days, then hard-delete from DB | 7-day window lets users recover an accidental delete via support |
| Likes / reposts / poll votes | Until parent content deleted | Foreign keys cascade |
| Notifications | 90 days, then nightly cron drops rows older than 90d | Bounded growth on noisy table |
| RefreshToken | Until token expires (7 days) OR user clicks "log out everywhere" | Session security |
| SecurityEvent (audit log) | 365 days | Anomaly detection + DPDP §8 (security log retention) |
| CloudWatch logs | 30 days (App Runner default) | Cost + privacy |
| Sentry events | 90 days (default plan) | Debugging window |

## 3. Records kept after account deletion

When a user deletes their account, **everything in §2 is dropped immediately
via Prisma cascading deletes**, with the following exceptions:

- **SecurityEvent rows tied to that user**: anonymized (`userId` → `NULL`)
  but the row stays for 365 days. Retains audit trail for fraud /
  policy enforcement without keeping personal info.
- **Posts / comments referenced by other users' replies**: hard-deleted
  along with the cascade. Conversation tree contracts; this is intentional.
- **Clubs the user owned**: ownership transfers to the placeholder
  `"deleted_user"` ID so the club survives. Members are notified by
  the next admin in line.

## 4. How to request deletion / export

- **In-product:** Settings → Account → Delete account (immediate cascade)
- **Email:** info@athavita.com — DPDP §13(1) gives 90 days to action.
  Our SLA is 7 days for export, 14 days for verified deletion requests
  outside the in-product flow.

## 5. Backups

- AWS RDS automated snapshots: retained 1 day (free-tier minimum).
  Bump to 7 days once we leave free tier.
- Snapshots inherit production data, including soft-deleted rows. They
  are encrypted at rest (RDS default) and only restorable into our AWS
  account.
- A user deletion request triggers a re-snapshot the next morning so the
  pre-deletion state ages out within retention.

## 6. Children

We do not knowingly collect data from users under 13. If we learn a
child has registered, we delete the account immediately (no parental
consent flow exists yet — feature gap, see roadmap).

## 7. Changes to this policy

Material changes are announced via in-app banner + the email on file at
least 14 days before they take effect, except for security-driven
changes (which take effect immediately and are announced after the fact).

---

## Implementation TODO

- [ ] Nightly cron: `DELETE FROM "Notification" WHERE "createdAt" < NOW() - INTERVAL '90 days'`
- [ ] Nightly cron: `UPDATE "SecurityEvent" SET "userId" = NULL WHERE "userId" IN (SELECT id FROM "User" WHERE "deletedAt" IS NOT NULL)` — except User has hard-delete not soft, so the cascade already nulls these via `onDelete: SetNull`
- [ ] Nightly cron: `DELETE FROM "SecurityEvent" WHERE "createdAt" < NOW() - INTERVAL '365 days'`
- [ ] Periodic data-export endpoint for GDPR/DPDP §18 portability
- [ ] Bump RDS retention to 7 days when budget allows
