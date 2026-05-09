import { PrismaClient } from "../app/src/generated/prisma"
import argon2 from "argon2"

const prisma = new PrismaClient()

async function main() {
  // Create test users
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
  ])

  // Create some anime entries (popular ones)
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

  // Create a club
  await prisma.club.upsert({
    where: { slug: "anime-discussion" },
    update: {},
    create: { slug: "anime-discussion", name: "Anime Discussion Hub", description: "General anime discussion for all fans", ownerId: users[0].id, reputation: 500 }
  })

  console.log("✅ Seed complete:", { users: users.length, anime: anime.length })
}

main().catch(console.error).finally(() => prisma.$disconnect())
