import { verifyAdminAuditChain } from "../lib/adminAudit"
import { raiseAlert } from "../lib/raiseAlert"

/**
 * Daily audit-log integrity check. Runs verifyAdminAuditChain and, on a
 * broken chain, creates a CRITICAL AdminAlert so operators see it in the
 * overview attention panel + alerts page.
 *
 * Manual tampering of AuditLog by anything other than the admin-audit
 * service is impossible to prevent in code (the DB user has write access),
 * but any tamper breaks the SHA-256 chain. This job is the canary.
 */
export async function runAuditChainCheck(): Promise<{ intact: boolean; brokenAt: string | null }> {
  const result = await verifyAdminAuditChain()
  if (!result) return { intact: true, brokenAt: null }

  await raiseAlert({
    severity: "critical", category: "security",
    title: `Audit log integrity check FAILED`,
    body:  `Chain broken at AuditLog row ${result.brokenAt}. Review immediately — tampering or DB corruption.`,
    link:  "/audit",
    metadata: { brokenAt: result.brokenAt },
  })
  return { intact: false, brokenAt: result.brokenAt }
}
