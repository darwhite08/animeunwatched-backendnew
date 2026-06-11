import "dotenv/config"
import { PrismaClient } from "../app/src/generated/prisma/client"
import argon2 from "argon2"

const prisma = new PrismaClient()

async function main() {
  const hash = await argon2.hash("password123")

  // ─── Founding Creator counter (single row) ──────────────────────────────────
  await prisma.foundingCounter.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, issued: 0, cap: 250 },
  })

  // ─── Users ────────────────────────────────────────────────────────────────
  const users = await Promise.all([
    prisma.user.upsert({ where: { email: "admin@unwatched.dev" }, update: {}, create: { email: "admin@unwatched.dev", username: "admin", displayName: "Admin", passwordHash: hash, role: "ADMIN", reputation: 9999 } }),
    prisma.user.upsert({ where: { email: "otaku@unwatched.dev" }, update: {}, create: { email: "otaku@unwatched.dev", username: "otaku_arch", displayName: "Otaku Arch", passwordHash: hash, role: "USER", reputation: 1240 } }),
    prisma.user.upsert({ where: { email: "shadow@unwatched.dev" }, update: {}, create: { email: "shadow@unwatched.dev", username: "shadow_watcher", displayName: "Shadow Watcher", passwordHash: hash, role: "MOD", reputation: 840 } }),
    prisma.user.upsert({ where: { email: "neon@unwatched.dev" }, update: {}, create: { email: "neon@unwatched.dev", username: "neon_weeb", displayName: "Neon Weeb", passwordHash: hash, role: "USER", reputation: 240 } }),
    prisma.user.upsert({ where: { email: "rookie@unwatched.dev" }, update: {}, create: { email: "rookie@unwatched.dev", username: "rookie_watcher", displayName: "Rookie Watcher", passwordHash: hash, role: "USER", reputation: 89 } }),
    prisma.user.upsert({ where: { email: "elite@unwatched.dev" }, update: {}, create: { email: "elite@unwatched.dev", username: "elite_otaku", displayName: "Elite Otaku", passwordHash: hash, role: "USER", reputation: 450 } }),
    prisma.user.upsert({ where: { email: "cipher@unwatched.dev" }, update: {}, create: { email: "cipher@unwatched.dev", username: "cipher_ronin", displayName: "Cipher Ronin", passwordHash: hash, role: "USER", reputation: 680 } }),
    prisma.user.upsert({ where: { email: "void@unwatched.dev" }, update: {}, create: { email: "void@unwatched.dev", username: "void_seeker", displayName: "Void Seeker", passwordHash: hash, role: "USER", reputation: 320 } }),
  ])

  // ─── Anime (25 titles) ────────────────────────────────────────────────────
  const animeData = [
    { malId: 5114,  title: "Fullmetal Alchemist: Brotherhood", titleEnglish: "Fullmetal Alchemist: Brotherhood", score: 9.1, year: 2009, type: "TV", status: "Finished Airing", episodes: 64, synopsis: "After a failed alchemical experiment, brothers Edward and Alphonse Elric seek the Philosopher's Stone to restore their bodies.", imageUrl: "https://cdn.myanimelist.net/images/anime/1223/96541.jpg", season: "spring", source: "Manga", rating: "R - 17+" },
    { malId: 9253,  title: "Steins;Gate", titleEnglish: "Steins;Gate", score: 9.08, year: 2011, type: "TV", status: "Finished Airing", episodes: 24, synopsis: "A self-proclaimed mad scientist discovers a way to send messages to the past, leading to unforeseen consequences.", imageUrl: "https://cdn.myanimelist.net/images/anime/5/73199.jpg", season: "spring", source: "Visual novel", rating: "PG-13" },
    { malId: 16498, title: "Attack on Titan", titleEnglish: "Attack on Titan", score: 9.0, year: 2013, type: "TV", status: "Finished Airing", episodes: 87, synopsis: "Humanity fights for survival against giant humanoid creatures called Titans behind enormous protective walls.", imageUrl: "https://cdn.myanimelist.net/images/anime/10/47347.jpg", season: "spring", source: "Manga", rating: "R - 17+" },
    { malId: 38524, title: "Shingeki no Kyojin: The Final Season", titleEnglish: "Attack on Titan Final Season", score: 9.0, year: 2020, type: "TV", status: "Finished Airing", episodes: 28, synopsis: "The final chapter of humanity's battle against Titans reaches its shocking conclusion.", imageUrl: "https://cdn.myanimelist.net/images/anime/1000/110531.jpg", season: "winter", source: "Manga", rating: "R - 17+" },
    { malId: 1535,  title: "Death Note", titleEnglish: "Death Note", score: 8.62, year: 2006, type: "TV", status: "Finished Airing", episodes: 37, synopsis: "A high school student discovers a supernatural notebook that allows him to kill anyone by writing their name.", imageUrl: "https://cdn.myanimelist.net/images/anime/9/9453.jpg", season: "fall", source: "Manga", rating: "R - 17+" },
    { malId: 1575,  title: "Code Geass: Hangyaku no Lelouch", titleEnglish: "Code Geass: Lelouch of the Rebellion", score: 8.7, year: 2006, type: "TV", status: "Finished Airing", episodes: 25, synopsis: "An exiled prince gains the power of absolute obedience and leads a rebellion against an oppressive empire.", imageUrl: "https://cdn.myanimelist.net/images/anime/5/50331.jpg", season: "fall", source: "Original", rating: "R - 17+" },
    { malId: 11061, title: "Hunter x Hunter (2011)", titleEnglish: "Hunter x Hunter", score: 9.04, year: 2011, type: "TV", status: "Finished Airing", episodes: 148, synopsis: "A boy sets out to find his father, who is a legendary Hunter, discovering a world of dangerous adventures.", imageUrl: "https://cdn.myanimelist.net/images/anime/11/33657.jpg", season: "fall", source: "Manga", rating: "PG-13" },
    { malId: 21,    title: "One Piece", titleEnglish: "One Piece", score: 8.72, year: 1999, type: "TV", status: "Currently Airing", episodes: null, synopsis: "Monkey D. Luffy sets sail to become the King of Pirates, gathering a crew and seeking the legendary treasure One Piece.", imageUrl: "https://cdn.myanimelist.net/images/anime/6/73245.jpg", season: "fall", source: "Manga", rating: "PG-13" },
    { malId: 20,    title: "Naruto", titleEnglish: "Naruto", score: 7.97, year: 2002, type: "TV", status: "Finished Airing", episodes: 220, synopsis: "A young ninja with a demon fox sealed inside him seeks recognition and dreams of becoming the strongest ninja.", imageUrl: "https://cdn.myanimelist.net/images/anime/13/17405.jpg", season: "fall", source: "Manga", rating: "PG-13" },
    { malId: 32281, title: "Kimi no Na wa.", titleEnglish: "Your Name.", score: 8.86, year: 2016, type: "Movie", status: "Finished Airing", episodes: 1, synopsis: "Two strangers find themselves linked in a bizarre way, experiencing each other's lives through dreams.", imageUrl: "https://cdn.myanimelist.net/images/anime/5/87048.jpg", season: "summer", source: "Original", rating: "PG" },
    { malId: 28851, title: "Koe no Katachi", titleEnglish: "A Silent Voice", score: 8.94, year: 2016, type: "Movie", status: "Finished Airing", episodes: 1, synopsis: "A young man seeks redemption for bullying a deaf girl in elementary school.", imageUrl: "https://cdn.myanimelist.net/images/anime/1122/96435.jpg", season: "summer", source: "Manga", rating: "PG-13" },
    { malId: 431,   title: "Howl no Ugoku Shiro", titleEnglish: "Howl's Moving Castle", score: 8.69, year: 2004, type: "Movie", status: "Finished Airing", episodes: 1, synopsis: "A young woman cursed into an old body seeks help from a mysterious wizard in his magical moving castle.", imageUrl: "https://cdn.myanimelist.net/images/anime/5/75810.jpg", season: "summer", source: "Novel", rating: "PG" },
    { malId: 44511, title: "Frieren: Beyond Journey's End", titleEnglish: "Frieren: Beyond Journey's End", score: 9.01, year: 2023, type: "TV", status: "Finished Airing", episodes: 28, synopsis: "A long-lived elven mage reflects on her past adventures and the meaning of life after the hero's quest ends.", imageUrl: "https://cdn.myanimelist.net/images/anime/1015/138006.jpg", season: "fall", source: "Manga", rating: "PG-13" },
    { malId: 48583, title: "Kimetsu no Yaiba: Mugen Ressha-hen", titleEnglish: "Demon Slayer: Mugen Train Arc", score: 8.59, year: 2021, type: "TV", status: "Finished Airing", episodes: 7, synopsis: "Tanjiro and his companions join the Flame Hashira Rengoku on a mission aboard the Mugen Train.", imageUrl: "https://cdn.myanimelist.net/images/anime/1704/106947.jpg", season: "winter", source: "Manga", rating: "R - 17+" },
    { malId: 40748, title: "Kimetsu no Yaiba", titleEnglish: "Demon Slayer: Kimetsu no Yaiba", score: 8.53, year: 2019, type: "TV", status: "Finished Airing", episodes: 26, synopsis: "A young boy becomes a demon slayer after his family is slaughtered and his sister is turned into a demon.", imageUrl: "https://cdn.myanimelist.net/images/anime/1286/99889.jpg", season: "spring", source: "Manga", rating: "R - 17+" },
    { malId: 37430, title: "Goblin Slayer", titleEnglish: "Goblin Slayer", score: 7.49, year: 2018, type: "TV", status: "Finished Airing", episodes: 12, synopsis: "A lone warrior dedicates his life to eradicating goblins after a traumatic childhood experience.", imageUrl: "https://cdn.myanimelist.net/images/anime/1805/95126.jpg", season: "fall", source: "Light novel", rating: "R - 17+" },
    { malId: 33486, title: "Boku no Hero Academia", titleEnglish: "My Hero Academia", score: 7.93, year: 2016, type: "TV", status: "Finished Airing", episodes: 113, synopsis: "In a world where most people have superpowers, a boy born without any dreams of becoming the greatest hero.", imageUrl: "https://cdn.myanimelist.net/images/anime/10/78745.jpg", season: "spring", source: "Manga", rating: "PG-13" },
    { malId: 41467, title: "Jujutsu Kaisen", titleEnglish: "Jujutsu Kaisen", score: 8.6, year: 2020, type: "TV", status: "Finished Airing", episodes: 24, synopsis: "A high schooler joins a secret organization of Jujutsu Sorcerers to fight cursed spirits after swallowing a cursed finger.", imageUrl: "https://cdn.myanimelist.net/images/anime/1171/109222.jpg", season: "fall", source: "Manga", rating: "R - 17+" },
    { malId: 37510, title: "Yakusoku no Neverland", titleEnglish: "The Promised Neverland", score: 8.5, year: 2019, type: "TV", status: "Finished Airing", episodes: 12, synopsis: "Orphans discover the dark truth about their idyllic home and plot their escape.", imageUrl: "https://cdn.myanimelist.net/images/anime/1830/95876.jpg", season: "winter", source: "Manga", rating: "PG-13" },
    { malId: 2001,  title: "Tengen Toppa Gurren Lagann", titleEnglish: "Gurren Lagann", score: 8.64, year: 2007, type: "TV", status: "Finished Airing", episodes: 27, synopsis: "Two diggers from an underground village join a rebellion against a tyrannical ruler using a massive mech.", imageUrl: "https://cdn.myanimelist.net/images/anime/4/5123.jpg", season: "spring", source: "Original", rating: "PG-13" },
    { malId: 2904,  title: "Code Geass: Hangyaku no Lelouch R2", titleEnglish: "Code Geass R2", score: 8.91, year: 2008, type: "TV", status: "Finished Airing", episodes: 25, synopsis: "Lelouch continues his rebellion, manipulating the world's superpowers in an epic chess match.", imageUrl: "https://cdn.myanimelist.net/images/anime/1438/108007.jpg", season: "spring", source: "Original", rating: "R - 17+" },
    { malId: 33352, title: "Mob Psycho 100", titleEnglish: "Mob Psycho 100", score: 8.49, year: 2016, type: "TV", status: "Finished Airing", episodes: 12, synopsis: "A psychic middle school boy tries to live a normal life while suppressing his overwhelming powers.", imageUrl: "https://cdn.myanimelist.net/images/anime/8/80356.jpg", season: "summer", source: "Manga", rating: "PG-13" },
    { malId: 14227, title: "No Game No Life", titleEnglish: "No Game No Life", score: 8.07, year: 2014, type: "TV", status: "Finished Airing", episodes: 12, synopsis: "Genius gamer siblings are transported to a world where all conflict is resolved through games.", imageUrl: "https://cdn.myanimelist.net/images/anime/1074/111944.jpg", season: "spring", source: "Light novel", rating: "PG-13" },
    { malId: 23273, title: "Shigatsu wa Kimi no Uso", titleEnglish: "Your Lie in April", score: 8.66, year: 2014, type: "TV", status: "Finished Airing", episodes: 22, synopsis: "A piano prodigy who lost his ability to hear music meets a free-spirited violinist who changes his life.", imageUrl: "https://cdn.myanimelist.net/images/anime/3/67177.jpg", season: "fall", source: "Manga", rating: "PG-13" },
    { malId: 820,   title: "Ginga Eiyuu Densetsu", titleEnglish: "Legend of the Galactic Heroes", score: 9.05, year: 1988, type: "OVA", status: "Finished Airing", episodes: 110, synopsis: "Two brilliant military commanders on opposing sides of a galactic war shape the fate of civilization.", imageUrl: "https://cdn.myanimelist.net/images/anime/1492/94408.jpg", season: null, source: "Light novel", rating: "R - 17+" },
    { malId: 199,   title: "Sen to Chihiro no Kamikakushi", titleEnglish: "Spirited Away", score: 8.85, year: 2001, type: "Movie", status: "Finished Airing", episodes: 1, synopsis: "A young girl enters a mysterious spirit world and must work to free herself and her parents.", imageUrl: "https://cdn.myanimelist.net/images/anime/6/79597.jpg", season: "summer", source: "Original", rating: "PG" },
  ]

  const animeGenres: Record<number, string[]> = {
    5114: ["Action", "Adventure", "Drama", "Fantasy"],
    9253: ["Drama", "Sci-Fi", "Thriller"],
    16498: ["Action", "Drama", "Fantasy", "Mystery"],
    38524: ["Action", "Drama", "Fantasy"],
    1535: ["Mystery", "Psychological", "Supernatural", "Thriller"],
    1575: ["Action", "Drama", "Mecha", "Sci-Fi"],
    11061: ["Action", "Adventure", "Fantasy"],
    21: ["Action", "Adventure", "Comedy", "Fantasy"],
    20: ["Action", "Adventure", "Fantasy"],
    32281: ["Drama", "Romance", "Supernatural"],
    28851: ["Drama", "Romance"],
    431: ["Adventure", "Drama", "Fantasy", "Romance"],
    44511: ["Adventure", "Drama", "Fantasy"],
    48583: ["Action", "Fantasy", "Historical"],
    40748: ["Action", "Fantasy", "Historical"],
    37430: ["Action", "Adventure", "Fantasy"],
    33486: ["Action", "Comedy", "Drama", "School"],
    41467: ["Action", "Fantasy", "School"],
    37510: ["Mystery", "Sci-Fi", "Thriller"],
    2001: ["Action", "Adventure", "Comedy", "Mecha"],
    2904: ["Action", "Drama", "Mecha", "Sci-Fi"],
    33352: ["Action", "Comedy", "Slice of Life", "Supernatural"],
    14227: ["Comedy", "Ecchi", "Fantasy", "Game"],
    23273: ["Drama", "Music", "Romance"],
    820: ["Drama", "Military", "Sci-Fi"],
    199: ["Adventure", "Fantasy", "Supernatural"],
  }

  const animeStudios: Record<number, string[]> = {
    5114: ["Bones"], 9253: ["White Fox"], 16498: ["Wit Studio"], 38524: ["MAPPA"],
    1535: ["Madhouse"], 1575: ["Sunrise"], 11061: ["Madhouse"], 21: ["Toei Animation"],
    20: ["Studio Pierrot"], 32281: ["CoMix Wave Films"], 28851: ["Kyoto Animation"],
    431: ["Studio Ghibli"], 44511: ["Madhouse"], 48583: ["ufotable"], 40748: ["ufotable"],
    37430: ["White Fox"], 33486: ["Bones"], 41467: ["MAPPA"], 37510: ["CloverWorks"],
    2001: ["Gainax"], 2904: ["Sunrise"], 33352: ["Bones"], 14227: ["Madhouse"],
    23273: ["A-1 Pictures"], 820: ["Kitty Film Movix"], 199: ["Studio Ghibli"],
  }

  const createdAnime: Record<number, string> = {}

  for (const a of animeData) {
    const genres = animeGenres[a.malId] ?? []
    const studios = animeStudios[a.malId] ?? []

    const genreRecords = await Promise.all(
      genres.map(name => prisma.genre.upsert({ where: { name }, create: { name }, update: {} }))
    )
    const studioRecords = await Promise.all(
      studios.map(name => prisma.studio.upsert({ where: { name }, create: { name }, update: {} }))
    )

    const anime = await prisma.anime.upsert({
      where: { malId: a.malId },
      update: { score: a.score, imageUrl: a.imageUrl, synopsis: a.synopsis ?? undefined },
      create: {
        malId: a.malId, title: a.title, titleEnglish: a.titleEnglish,
        score: a.score, year: a.year, type: a.type, status: a.status,
        episodes: a.episodes ?? null, synopsis: a.synopsis ?? null,
        imageUrl: a.imageUrl, season: a.season ?? null,
        source: a.source ?? null, rating: a.rating ?? null,
      },
    })

    // Upsert genre/studio relations
    for (const g of genreRecords) {
      await prisma.animeGenre.upsert({
        where: { animeId_genreId: { animeId: anime.id, genreId: g.id } },
        create: { animeId: anime.id, genreId: g.id },
        update: {},
      })
    }
    for (const s of studioRecords) {
      await prisma.animeStudio.upsert({
        where: { animeId_studioId: { animeId: anime.id, studioId: s.id } },
        create: { animeId: anime.id, studioId: s.id },
        update: {},
      })
    }

    createdAnime[a.malId] = anime.id
  }

  // ─── Clubs ────────────────────────────────────────────────────────────────
  await Promise.all([
    prisma.club.upsert({ where: { slug: "anime-discussion" }, update: {}, create: { slug: "anime-discussion", name: "Anime Discussion Hub", description: "General anime discussion for all fans", ownerId: users[0].id, reputation: 500 } }),
    prisma.club.upsert({ where: { slug: "psych-fans" }, update: {}, create: { slug: "psych-fans", name: "Psychological Thriller Fans", description: "For fans of mind-bending psychological anime thrillers", ownerId: users[1].id, reputation: 320 } }),
    prisma.club.upsert({ where: { slug: "shonen-elite" }, update: {}, create: { slug: "shonen-elite", name: "Shonen Elite", description: "Celebrating the best of shonen anime and manga", ownerId: users[6].id, reputation: 180 } }),
  ])

  // ─── Posts ────────────────────────────────────────────────────────────────
  const postSeeds = [
    { authorId: users[0].id, content: "Just finished rewatching Steins;Gate. The time loop arc still gives me chills every single time. El Psy Kongroo! 🧪", animeId: createdAnime[9253] },
    { authorId: users[1].id, content: "Fullmetal Alchemist: Brotherhood is the undisputed peak of shounen. The alchemy system, the world-building, the characters — all 10/10.", animeId: createdAnime[5114] },
    { authorId: users[2].id, content: "Attack on Titan's final arc was a masterpiece of moral ambiguity. Eren did nothing wrong... or did he? The debate continues.", animeId: createdAnime[16498] },
    { authorId: users[3].id, content: "Frieren: Beyond Journey's End is quietly the best anime of 2023. The way it handles time and grief is unlike anything else.", animeId: createdAnime[44511] },
    { authorId: users[5].id, content: "Hunter x Hunter's Chimera Ant arc is peak fiction. Not just anime — all of fiction. Meruem's development hit different.", animeId: createdAnime[11061] },
    { authorId: users[6].id, content: "Controversial opinion: Death Note peaks at episode 25 and the second half is mid. The first 25 episodes are genuinely perfect though.", animeId: createdAnime[1535] },
    { authorId: users[7].id, content: "Your Lie in April destroyed me emotionally. I was not prepared for that ending. Kaori deserved better 😭", animeId: createdAnime[23273] },
    { authorId: users[0].id, content: "Code Geass R2 episode 25 is the greatest finale in anime history. Zero Requiem was perfect storytelling. Change my mind.", animeId: createdAnime[2904] },
    { authorId: users[1].id, content: "Mob Psycho 100 is criminally underrated. The animation alone is worth watching but the story hits surprisingly hard too.", animeId: createdAnime[33352] },
    { authorId: users[4].id, content: "Just started Jujutsu Kaisen! Episode 1 is fire 🔥 Glad I finally started this. The animation quality is insane.", animeId: createdAnime[41467] },
    { authorId: users[6].id, content: "Spirited Away is still the greatest animated film ever made. The world-building in that movie is unmatched even 20+ years later.", animeId: createdAnime[199] },
    { authorId: users[7].id, content: "Legend of the Galactic Heroes is 110 episodes of absolute brilliance. If you haven't watched it, you're missing out on the greatest anime ever.", animeId: createdAnime[820] },
    { authorId: users[2].id, content: "Hot take: Gurren Lagann has the best ending in mecha anime. The scale of it is just ridiculous in the best way possible.", animeId: createdAnime[2001] },
    { authorId: users[3].id, content: "The Promised Neverland season 1 was near perfect. Let's just pretend season 2 doesn't exist and appreciate the masterpiece.", animeId: createdAnime[37510] },
    { authorId: users[5].id, content: "Demon Slayer's animation budget is insane. The Mugen Train arc made me forget I was watching an anime at some points. ufotable cooking.", animeId: createdAnime[48583] },
  ]

  for (const seed of postSeeds) {
    if (!seed.animeId) continue
    const existing = await prisma.post.findFirst({
      where: { authorId: seed.authorId, content: { startsWith: seed.content.slice(0, 40) } },
    })
    if (!existing) await prisma.post.create({ data: seed })
  }

  // ─── Reviews ──────────────────────────────────────────────────────────────
  const reviewSeeds = [
    { animeId: createdAnime[9253], authorId: users[1].id, score: 10, body: "Steins;Gate is a masterpiece of science fiction storytelling. The emotional depth and time travel mechanics are unmatched in anime.", hasSpoilers: false },
    { animeId: createdAnime[5114], authorId: users[2].id, score: 9, body: "Fullmetal Alchemist: Brotherhood is nearly flawless. World-building, character development, and thematic depth are exceptional.", hasSpoilers: false },
    { animeId: createdAnime[44511], authorId: users[3].id, score: 10, body: "Frieren is a meditative masterpiece about time, loss, and what it means to truly know someone. One of the greatest anime ever made.", hasSpoilers: false },
    { animeId: createdAnime[11061], authorId: users[6].id, score: 10, body: "HxH 2011 is the gold standard for battle shonen. Every arc tops the last. Chimera Ant arc is the Mount Everest of anime storytelling.", hasSpoilers: false },
    { animeId: createdAnime[32281], authorId: users[7].id, score: 9, body: "Your Name is breathtaking. The visuals, the music, the romance — everything comes together for a film that stays with you forever.", hasSpoilers: false },
  ]

  for (const seed of reviewSeeds) {
    if (!seed.animeId) continue
    await prisma.review.upsert({
      where: { animeId_authorId: { animeId: seed.animeId, authorId: seed.authorId } },
      update: {}, create: seed,
    })
  }

  // ─── Watchlist entries for admin user ─────────────────────────────────────
  const watchlistSeeds = [
    { animeId: createdAnime[5114], status: "COMPLETED" as const, score: 10, episodesSeen: 64 },
    { animeId: createdAnime[9253], status: "COMPLETED" as const, score: 10, episodesSeen: 24 },
    { animeId: createdAnime[44511], status: "COMPLETED" as const, score: 10, episodesSeen: 28 },
    { animeId: createdAnime[11061], status: "COMPLETED" as const, score: 10, episodesSeen: 148 },
    { animeId: createdAnime[16498], status: "COMPLETED" as const, score: 9, episodesSeen: 87 },
    { animeId: createdAnime[41467], status: "WATCHING" as const, score: null, episodesSeen: 12 },
    { animeId: createdAnime[40748], status: "WATCHING" as const, score: null, episodesSeen: 18 },
    { animeId: createdAnime[1535], status: "COMPLETED" as const, score: 9, episodesSeen: 37 },
    { animeId: createdAnime[21], status: "WATCHING" as const, score: null, episodesSeen: 1050 },
    { animeId: createdAnime[23273], status: "COMPLETED" as const, score: 9, episodesSeen: 22 },
    { animeId: createdAnime[820], status: "PLAN_TO_WATCH" as const, score: null, episodesSeen: 0 },
    { animeId: createdAnime[2001], status: "COMPLETED" as const, score: 9, episodesSeen: 27 },
  ]

  for (const w of watchlistSeeds) {
    if (!w.animeId) continue
    await prisma.listEntry.upsert({
      where: { userId_animeId: { userId: users[0].id, animeId: w.animeId } },
      update: {}, create: { userId: users[0].id, ...w },
    })
  }

  // ─── Notifications ────────────────────────────────────────────────────────
  const notifSeeds = [
    { recipientId: users[0].id, type: "achievement", payload: { title: "First Steps", description: "Welcome to AnimeUnwatched!", icon: "trophy" } },
    { recipientId: users[0].id, type: "follow", payload: { followerUsername: "otaku_arch", followerDisplayName: "Otaku Arch" } },
    { recipientId: users[0].id, type: "system", payload: { message: "AnimeUnwatched is now live! Check the changelog.", link: "/changelog" } },
    { recipientId: users[1].id, type: "achievement", payload: { title: "Avid Reviewer", description: "You've written 5 reviews!", icon: "star" } },
    { recipientId: users[1].id, type: "like", payload: { fromUsername: "shadow_watcher", postPreview: "Fullmetal Alchemist: Brotherhood is..." } },
  ]

  for (const seed of notifSeeds) {
    const existing = await prisma.notification.findFirst({ where: { recipientId: seed.recipientId, type: seed.type } })
    if (!existing) await prisma.notification.create({ data: seed })
  }

  console.log("✅ Seed complete:", {
    users: users.length,
    anime: animeData.length,
    genres: Object.values(animeGenres).flat().filter((v, i, a) => a.indexOf(v) === i).length,
    posts: postSeeds.length,
    reviews: reviewSeeds.length,
    watchlistEntries: watchlistSeeds.length,
  })
}

main().catch(console.error).finally(() => prisma.$disconnect())
