import { prisma } from "../config/prisma"

type ReputationEvent =
  | "post_created"       // +2
  | "review_posted"      // +5
  | "review_liked"       // +1
  | "streak_7_days"      // +10
  | "streak_30_days"     // +25
  | "blog_published"     // +8
  | "first_follower"     // +5
  | "post_liked"         // +1
  | "list_100_anime"     // +15

const REP_VALUES: Record<ReputationEvent, number> = {
  post_created: 2,
  review_posted: 5,
  review_liked: 1,
  streak_7_days: 10,
  streak_30_days: 25,
  blog_published: 8,
  first_follower: 5,
  post_liked: 1,
  list_100_anime: 15,
}

export async function addReputation(userId: string, event: ReputationEvent): Promise<void> {
  const delta = REP_VALUES[event]
  await prisma.user.update({
    where: { id: userId },
    data: { reputation: { increment: delta } },
  })
}
