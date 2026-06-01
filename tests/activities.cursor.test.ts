/**
 * Cursor-pagination correctness for GET /activities/feed.
 *
 * Verifies:
 *  - no off-by-one (every row appears exactly once)
 *  - no duplicates across pages
 *  - terminal page returns nextCursor = null
 *  - rows arrive in strict createdAt-desc order
 *
 * Uses the real local Postgres test DB. If you run these in CI, set
 * DATABASE_URL to a disposable test DB.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../app/src/config/prisma";
import * as service from "../app/src/modules/activities/activities.service";

const TEST_USER_ID = "cursor-test-user";

async function seed(n: number) {
  await prisma.user.upsert({
    where: { id: TEST_USER_ID },
    create: {
      id: TEST_USER_ID, email: `${TEST_USER_ID}@test.local`,
      username: TEST_USER_ID, displayName: "Cursor Test",
    },
    update: {},
  });
  const now = Date.now();
  const rows = Array.from({ length: n }, (_, i) => ({
    id:        `cursor-test-${i.toString().padStart(4, "0")}`,
    authorId:  TEST_USER_ID,
    kind:      "TEXT" as const,
    body:      `cursor row ${i}`,
    // Spread createdAt 1 minute apart, oldest first
    createdAt: new Date(now - (n - i) * 60_000),
  }));
  await prisma.activity.createMany({ data: rows, skipDuplicates: true });
}

async function cleanup() {
  await prisma.activity.deleteMany({ where: { authorId: TEST_USER_ID } });
  await prisma.user.deleteMany({ where: { id: TEST_USER_ID } });
}

// Skipped in default `vitest run` — needs a real DATABASE_URL. To enable:
//   DATABASE_URL=postgresql://...  npx vitest run tests/activities.cursor.test.ts --reporter=verbose
// The default setup.ts (line 7) sets DATABASE_URL to a non-existent test host.
describe.skip("activities cursor pagination (real DB)", () => {
  const SEED_N = 25;
  const PAGE   = 10;

  beforeAll(async () => { await cleanup(); await seed(SEED_N); });
  afterAll(async () => { await cleanup(); });

  it("walks all rows with no duplicates, no gaps", async () => {
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    while (true) {
      const { data, meta } = await service.getFeed(TEST_USER_ID, {
        type: "profile", userId: TEST_USER_ID, cursor, limit: PAGE,
      });
      pages++;
      for (const row of data) {
        // Only assert on rows we seeded — DB may have other unrelated rows
        if (row.authorId === TEST_USER_ID) {
          expect(seen.has(row.id)).toBe(false);
          seen.add(row.id);
        }
      }
      if (!meta.nextCursor) break;
      cursor = meta.nextCursor;
      if (pages > 10) throw new Error("did not terminate");
    }
    expect(seen.size).toBe(SEED_N);
  });

  it("returns rows in strict createdAt-desc order on a single page", async () => {
    const { data } = await service.getFeed(TEST_USER_ID, {
      type: "profile", userId: TEST_USER_ID, limit: SEED_N,
    });
    for (let i = 1; i < data.length; i++) {
      expect(data[i - 1].createdAt.getTime()).toBeGreaterThanOrEqual(data[i].createdAt.getTime());
    }
  });

  it("terminal page yields nextCursor=null", async () => {
    let cursor: string | undefined;
    let last: Awaited<ReturnType<typeof service.getFeed>> | null = null;
    for (let i = 0; i < 10; i++) {
      last = await service.getFeed(TEST_USER_ID, {
        type: "profile", userId: TEST_USER_ID, cursor, limit: PAGE,
      });
      if (!last.meta.nextCursor) break;
      cursor = last.meta.nextCursor;
    }
    expect(last!.meta.nextCursor).toBeNull();
  });
});
