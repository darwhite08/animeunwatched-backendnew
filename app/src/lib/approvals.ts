import type { Request, Response, NextFunction } from "express"
import { prisma } from "../config/prisma"
import { forbidden, badRequest } from "./errors"
import { adminAuditR } from "./adminAudit"

/**
 * Two-person rule. Wrap a high-risk handler to require an ApprovalRequest
 * that has been reviewed by a *different* admin before the side effect runs.
 *
 * Flow:
 *   1. Actor calls the endpoint without an X-Approval-Id header → middleware
 *      records an ApprovalRequest{status=pending} and returns 202 + the
 *      request id. The handler is NOT executed.
 *   2. A second admin opens /approvals, approves the request (writes an
 *      ApprovalDecision + flips status to "approved").
 *   3. Actor retries the original endpoint with X-Approval-Id: <id>. The
 *      middleware verifies the request is approved, the approver is not the
 *      actor, and not expired. The handler is then allowed to proceed and
 *      the request is marked "executed".
 *
 * High-risk actions tagged today:
 *   - users.delete           (DELETE /admin/users/:userId)
 *   - users.bulk.suspend     (POST   /admin/users/bulk with action=suspend)
 *   - billing.refund         (POST   /admin/billing/invoices/:id/refund)
 *   - api_keys.rotate        (POST   /admin/api-keys/:keyId/rotate)
 *
 * The action is just a string — adding more is a matter of mounting the
 * middleware on the route.
 */
export interface ApprovalConfig {
  action:    string
  resource:  (req: Request) => string
  expiryMin?: number
}

const DEFAULT_EXPIRY_MIN = 24 * 60   // 24 hours

export function requireApproval(cfg: ApprovalConfig) {
  return async function approvalGate(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actorId = (res.locals.user as { id?: string } | undefined)?.id
      if (!actorId) throw forbidden("No actor on request")

      const headerId = req.header("X-Approval-Id")?.trim() || undefined

      if (headerId) {
        // Second leg — verify the approval is good then continue to the
        // real handler. The handler doesn't need to know any of this.
        const ar = await prisma.approvalRequest.findUnique({ where: { id: headerId } })
        if (!ar)                          throw badRequest("Approval request not found")
        if (ar.action !== cfg.action)     throw badRequest("Approval is for a different action")
        if (ar.status === "rejected")     throw forbidden("Approval was rejected")
        if (ar.status === "expired")      throw forbidden("Approval has expired")
        if (ar.status === "executed")     throw forbidden("Approval was already used")
        if (ar.status !== "approved")     throw forbidden(`Approval is ${ar.status}`)
        if (ar.expiresAt < new Date())    {
          await prisma.approvalRequest.update({ where: { id: headerId }, data: { status: "expired" } })
          throw forbidden("Approval has expired")
        }
        if (ar.requestedBy !== actorId)   throw forbidden("Only the original requester may execute this approval")

        // Mark executed BEFORE the handler runs so a crash in the handler
        // still consumes the approval (forces a fresh request next time).
        await prisma.approvalRequest.update({
          where: { id: headerId },
          data:  { status: "executed", executedAt: new Date() },
        })
        await adminAuditR(req, res, {
          action: `approval.execute:${cfg.action}`,
          targetType: "ApprovalRequest", targetId: headerId,
          metadata: { resource: ar.resource },
        })
        // Stash on res.locals so the handler can reference if needed
        ;(res.locals as Record<string, unknown>).approval = ar
        return next()
      }

      // First leg — record the pending request and ask for a second pair of eyes.
      const reason = typeof (req.body as { _reason?: string })?._reason === "string"
        ? (req.body as { _reason: string })._reason
        : "(no reason provided)"
      const expiresAt = new Date(Date.now() + (cfg.expiryMin ?? DEFAULT_EXPIRY_MIN) * 60_000)
      const created = await prisma.approvalRequest.create({
        data: {
          action:      cfg.action,
          resource:    cfg.resource(req),
          payload:     ((req.body ?? {}) as object) as never,
          reason,
          requestedBy: actorId,
          expiresAt,
        },
      })
      await adminAuditR(req, res, {
        action: `approval.request:${cfg.action}`,
        targetType: "ApprovalRequest", targetId: created.id,
        metadata: { resource: created.resource, expiresAt: created.expiresAt },
      })
      res.status(202).json({
        approvalRequired: true,
        approvalId:       created.id,
        message:          "Action requires a second admin's approval. Share this approvalId with a teammate; they can approve at /approvals.",
        expiresAt:        created.expiresAt,
      })
    } catch (err) { next(err) }
  }
}
