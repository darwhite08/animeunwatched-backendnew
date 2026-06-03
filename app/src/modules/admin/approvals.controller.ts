import type { Request, Response, NextFunction } from "express"
import { prisma } from "../../config/prisma"
import { badRequest, forbidden, notFound } from "../../lib/errors"
import { adminAuditR } from "../../lib/adminAudit"

export async function listApprovals(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : "pending"
    const where: Record<string, unknown> = {}
    if (status !== "all") where.status = status
    const rows = await prisma.approvalRequest.findMany({
      where, orderBy: { createdAt: "desc" }, take: 100,
      include: { decisions: { orderBy: { createdAt: "asc" } } },
    })
    // Auto-expire any pending past their TTL so the list stays accurate
    const now = new Date()
    for (const r of rows) {
      if (r.status === "pending" && r.expiresAt < now) {
        await prisma.approvalRequest.update({ where: { id: r.id }, data: { status: "expired" } })
        r.status = "expired"
      }
    }
    const counters = {
      pending:  rows.filter(r => r.status === "pending").length,
      approved: rows.filter(r => r.status === "approved").length,
      executed: rows.filter(r => r.status === "executed").length,
      rejected: rows.filter(r => r.status === "rejected").length,
      expired:  rows.filter(r => r.status === "expired").length,
    }
    res.status(200).json({ data: rows, counters })
  } catch (err) { next(err) }
}

export async function reviewApproval(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const reviewerId = res.locals.user?.id as string
    const id = req.params.id as string
    const { decision, note } = req.body as { decision?: string; note?: string }
    if (decision !== "approve" && decision !== "reject") throw badRequest('decision must be "approve" | "reject"')
    const ar = await prisma.approvalRequest.findUnique({ where: { id } })
    if (!ar) throw notFound("Approval not found")
    if (ar.status !== "pending") throw badRequest(`Approval is already ${ar.status}`)
    if (ar.requestedBy === reviewerId) throw forbidden("You cannot approve your own request — two-person rule")
    if (ar.expiresAt < new Date()) {
      await prisma.approvalRequest.update({ where: { id }, data: { status: "expired" } })
      throw badRequest("Approval has expired")
    }

    await prisma.approvalDecision.create({
      data: { requestId: id, reviewerId, decision, note: note ?? null },
    })
    const updated = await prisma.approvalRequest.update({
      where: { id },
      data: {
        status:     decision === "approve" ? "approved" : "rejected",
        reviewedBy: reviewerId,
        reviewedAt: new Date(),
        reviewNote: note ?? null,
      },
    })
    await adminAuditR(req, res, {
      action: `approval.${decision}`, targetType: "ApprovalRequest", targetId: id,
      metadata: { action: ar.action, resource: ar.resource },
    })
    res.status(200).json({ request: updated })
  } catch (err) { next(err) }
}

export async function getApproval(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string
    const ar = await prisma.approvalRequest.findUnique({
      where: { id }, include: { decisions: { orderBy: { createdAt: "asc" } } },
    })
    if (!ar) throw notFound("Approval not found")
    res.status(200).json(ar)
  } catch (err) { next(err) }
}

/**
 * Bulk-reject several pending approvals at once — useful for clearing
 * old/abandoned requests. Approver still cannot be the requester.
 */
export async function bulkReject(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const reviewerId = res.locals.user?.id as string
    const { approvalIds, note } = req.body as { approvalIds?: unknown; note?: string }
    if (!Array.isArray(approvalIds) || approvalIds.length === 0) throw badRequest("approvalIds[] required")
    const ids = approvalIds.map(String).slice(0, 200)
    const targets = await prisma.approvalRequest.findMany({ where: { id: { in: ids }, status: "pending" } })
    let rejected = 0, skipped = 0
    for (const ar of targets) {
      if (ar.requestedBy === reviewerId) { skipped++; continue }   // can't reject your own
      await prisma.approvalDecision.create({ data: { requestId: ar.id, reviewerId, decision: "reject", note: note ?? null } })
      await prisma.approvalRequest.update({
        where: { id: ar.id },
        data: { status: "rejected", reviewedBy: reviewerId, reviewedAt: new Date(), reviewNote: note ?? null },
      })
      rejected++
    }
    await adminAuditR(req, res, {
      action: "approval.bulk_reject", targetType: "ApprovalRequest",
      metadata: { rejected, skipped, requested: ids.length },
    })
    res.status(200).json({ rejected, skipped })
  } catch (err) { next(err) }
}
