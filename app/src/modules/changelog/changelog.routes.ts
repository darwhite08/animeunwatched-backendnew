import { Router } from "express"
import { prisma } from "../../config/prisma"

export const changelogRouter = Router()

// Public — no auth. Lets API consumers integrate the changelog into their
// own docs / status pages.
changelogRouter.get("/", async (_req, res, next) => {
  try {
    const data = await prisma.apiChangeLog.findMany({
      orderBy: { publishedAt: "desc" }, take: 200,
      select: { id: true, publishedAt: true, changeType: true, title: true, body: true, affects: true },
    })
    res.status(200).json({ data })
  } catch (err) { next(err) }
})
