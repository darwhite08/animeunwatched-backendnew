import { PrismaClient } from "../app/src/generated/prisma"
import argon2 from "argon2"

const prisma = new PrismaClient()

async function main() {
  // ─── Users ─────────────────────────────────────────────────────────────────
  const hash = await argon2.hash("password123")

  const users = await Promise.all([
    prisma.user.upsert({
      where: { email: "admin@unwatched.dev" },
      update: {},
      create: { email: "admin@unwatched.dev", username: "admin", displayName: "Admin", passwordHash: hash, role: "ADMIN", reputation: 9999 }
    }),
    prisma.user.upsert({
      where: { email: "otaku@unwatched.dev" },
      update: {},
      create: { email: "otaku@unwatched.dev", username: "otaku_arch", displayName: "Otaku Arch", passwordHash: hash, role: "USER", reputation: 1240 }
    }),
    prisma.user.upsert({
      where: { email: "shadow@unwatched.dev" },
      update: {},
      create: { email: "shadow@unwatched.dev", username: "shadow_watcher", displayName: "Shadow Watcher", passwordHash: hash, role: "MOD", reputation: 840 }
    }),
    // Additional users with varied reputation
    prisma.user.upsert({
      where: { email: "neon@unwatched.dev" },
      update: {},
      create: { email: "neon@unwatched.dev", username: "neon_weeb", displayName: "Neon Weeb", passwordHash: hash, role: "USER", reputation: 240 }
    }),
    prisma.user.upsert({
      where: { email: "rookie@unwatched.dev" },
      update: {},
      create: { email: "rookie@unwatched.dev", username: "rookie_watcher", displayName: "Rookie Watcher", passwordHash: hash, role: "USER", reputation: 89 }
    }),
    prisma.user.upsert({
      where: { email: "elite@unwatched.dev" },
      update: {},
      create: { email: "elite@unwatched.dev", username: "elite_otaku", displayName: "Elite Otaku", passwordHash: hash, role: "USER", reputation: 450 }
    }),
  ])

  // ─── Anime ─────────────────────────────────────────────────────────────────
  const anime = await Promise.all([
    prisma.anime.upsert({
      where: { malId: 5114 },
      update: {},
      create: { malId: 5114, title: "Fullmetal Alchemist: Brotherhood", score: 9.1, year: 2009, type: "TV", status: "Finished Airing", episodes: 64, imageUrl: "https://images.unsplash.com/photo-1518893063132-36e46dbe2428?w=400" }
    }),
    prisma.anime.upsert({
      where: { malId: 9253 },
      update: {},
      create: { malId: 9253, title: "Steins;Gate", score: 9.0, year: 2011, type: "TV", status: "Finished Airing", episodes: 24, imageUrl: "https://images.unsplash.com/photo-1446776653964-20c1d3a81b06?w=400" }
    }),
    prisma.anime.upsert({
      where: { malId: 16498 },
      update: {},
      create: { malId: 16498, title: "Attack on Titan", score: 9.0, year: 2013, type: "TV", status: "Finished Airing", episodes: 87, imageUrl: "https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=400" }
    }),
  ])

  // ─── Clubs ─────────────────────────────────────────────────────────────────
  await Promise.all([
    prisma.club.upsert({
      where: { slug: "anime-discussion" },
      update: {},
      create: { slug: "anime-discussion", name: "Anime Discussion Hub", description: "General anime discussion for all fans", ownerId: users[0].id, reputation: 500 }
    }),
    prisma.club.upsert({
      where: { slug: "psych-fans" },
      update: {},
      create: { slug: "psych-fans", name: "Psychological Thriller Fans", description: "For fans of mind-bending psychological anime thrillers", ownerId: users[1].id, reputation: 320 }
    }),
  ])

  // ─── Posts ─────────────────────────────────────────────────────────────────
  const postSeeds = [
    { authorId: users[0].id, content: "Just finished rewatching Steins;Gate. The time loop arc still gives me chills. El Psy Kongroo!", animeId: anime[1].id },
    { authorId: users[1].id, content: "Fullmetal Alchemist: Brotherhood is the peak of shounen. The alchemy system is so well thought out.", animeId: anime[0].id },
    { authorId: users[2].id, content: "Attack on Titan's final arc was a masterpiece of moral ambiguity. Eren did nothing wrong... or did he?", animeId: anime[2].id },
    { authorId: users[3].id, content: "Started watching Steins;Gate for the first time. Episode 1 seems slow but everyone tells me to stick with it!", animeId: anime[1].id },
    { authorId: users[5].id, content: "The Brotherhood vs 2003 FMA debate is eternal. Both have their merits but Brotherhood is objectively the complete story.", animeId: anime[0].id },
  ]

  for (const seed of postSeeds) {
    // Check if this exact post already exists (by author + first 50 chars of content)
    const existing = await prisma.post.findFirst({
      where: { authorId: seed.authorId, content: { startsWith: seed.content.slice(0, 50) } },
    })
    if (!existing) {
      await prisma.post.create({ data: seed })
    }
  }

  // ─── Reviews ───────────────────────────────────────────────────────────────
  const reviewSeeds = [
    {
      animeId: anime[1].id, // Steins;Gate
      authorId: users[1].id, // otaku_arch
      score: 10,
      body: "Steins;Gate is a masterpiece of science fiction storytelling. The slow build in the first half pays off magnificently. The emotional depth and time travel mechanics are unmatched in anime. A perfect 10/10.",
    },
    {
      animeId: anime[0].id, // FMA:B
      authorId: users[2].id, // shadow_watcher
      score: 9,
      body: "Fullmetal Alchemist: Brotherhood is nearly flawless. The world-building, character development, and thematic depth are exceptional. One of the best action anime ever made. A strong 9/10.",
    },
  ]

  for (const seed of reviewSeeds) {
    await prisma.review.upsert({
      where: { animeId_authorId: { animeId: seed.animeId, authorId: seed.authorId } },
      update: {},
      create: seed,
    })
  }

  // ─── Notifications for admin ────────────────────────────────────────────────
  const notifSeeds = [
    {
      recipientId: users[0].id,
      type: "achievement",
      payload: { title: "First Steps", description: "Welcome to AnimeUnwatched! Your journey begins.", icon: "trophy" },
    },
    {
      recipientId: users[0].id,
      type: "follow",
      payload: { followerId: users[1].id, followerUsername: "otaku_arch", followerDisplayName: "Otaku Arch" },
    },
    {
      recipientId: users[0].id,
      type: "system",
      payload: { message: "AnimeUnwatched is now live! Check out the new features in the latest update.", link: "/changelog" },
    },
  ]

  for (const seed of notifSeeds) {
    const existing = await prisma.notification.findFirst({
      where: { recipientId: seed.recipientId, type: seed.type },
    })
    if (!existing) {
      await prisma.notification.create({ data: seed })
    }
  }

  console.log("✅ Seed complete:", {
    users: users.length,
    anime: anime.length,
    clubs: 2,
    posts: postSeeds.length,
    reviews: reviewSeeds.length,
    notifications: notifSeeds.length,
  })
}

main().catch(console.error).finally(() => prisma.$disconnect())
