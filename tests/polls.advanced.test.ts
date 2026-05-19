/**
 * Advanced polls tests — expiry, list pagination.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../app/src/config/prisma", () => ({
  prisma: {
    poll: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    pollVote: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

const makeOption = (id: string, votes: number = 0) => ({
  id, label: `Option ${id}`, pollId: "p1", order: 0,
  votes: Array(votes).fill({ userId: "u1" }),
});

describe("polls.service — list pagination", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns empty data for empty poll list", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { list } = await import("../app/src/modules/polls/polls.service");

    (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValueOnce([[], 0]);

    const result = await list(1, 20);
    expect(result.data).toHaveLength(0);
    expect(result.meta.total).toBe(0);
  });

  it("calculates pages correctly", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { list } = await import("../app/src/modules/polls/polls.service");

    (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      Array(20).fill({ id: "p1", question: "Q?", authorId: "u1",
        createdAt: new Date(), expiresAt: new Date(Date.now() + 1000),
        options: [makeOption("o1"), makeOption("o2")] }),
      45,
    ]);

    const result = await list(1, 20);
    expect(result.meta.total).toBe(45);
    expect(result.meta.pages).toBe(3); // ceil(45/20) = 3
  });
});

describe("polls.service — formatPoll", () => {
  beforeEach(() => vi.clearAllMocks());

  it("totalVotes is sum of all option votes", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getById } = await import("../app/src/modules/polls/polls.service");

    const mockPoll = {
      id: "p1", question: "Best anime?", authorId: "u1",
      createdAt: new Date(), expiresAt: new Date(Date.now() + 1000),
      options: [
        makeOption("o1", 5),  // 5 votes
        makeOption("o2", 3),  // 3 votes
        makeOption("o3", 0),  // 0 votes
      ],
    };
    (prisma.poll.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockPoll);

    const result = await getById("p1");
    expect(result.poll.totalVotes).toBe(8); // 5 + 3 + 0
    expect(result.poll.options[0].votes).toBe(5);
    expect(result.poll.options[1].votes).toBe(3);
    expect(result.poll.options[2].votes).toBe(0);
  });

  it("returns options in insertion order", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getById } = await import("../app/src/modules/polls/polls.service");

    const opts = [
      { id: "o1", label: "First",  pollId: "p1", order: 0, votes: [] },
      { id: "o2", label: "Second", pollId: "p1", order: 1, votes: [] },
      { id: "o3", label: "Third",  pollId: "p1", order: 2, votes: [] },
    ];
    const mockPoll = {
      id: "p1", question: "Order test?", authorId: "u1",
      createdAt: new Date(), expiresAt: new Date(Date.now() + 1000),
      options: opts,
    };
    (prisma.poll.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockPoll);

    const result = await getById("p1");
    expect(result.poll.options[0].label).toBe("First");
    expect(result.poll.options[1].label).toBe("Second");
    expect(result.poll.options[2].label).toBe("Third");
  });
});

describe("polls.service — create with custom expiry", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses expiresIn when provided (in hours)", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { create } = await import("../app/src/modules/polls/polls.service");

    const before = Date.now();
    (prisma.poll.create as ReturnType<typeof vi.fn>).mockImplementation((args: { data: { expiresAt: Date } }) => {
      // Check that expiresAt is approximately 24h from now
      const diff = args.data.expiresAt.getTime() - before;
      expect(diff).toBeGreaterThan(23 * 60 * 60 * 1000); // at least 23h
      expect(diff).toBeLessThan(25 * 60 * 60 * 1000);   // at most 25h
      return Promise.resolve({
        id: "p1", question: "Test?", authorId: "u1",
        createdAt: new Date(), expiresAt: args.data.expiresAt,
        options: [{ id: "o1", label: "A", pollId: "p1", order: 0, votes: [] }],
      });
    });

    await create("u1", {
      question: "Test?",
      options: ["A"],
      expiresIn: 24, // 24 hours
    });

    expect(prisma.poll.create).toHaveBeenCalled();
  });
});
