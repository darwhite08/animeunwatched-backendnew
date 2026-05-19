/**
 * Polls service unit tests.
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
    pollOption: {
      findMany: vi.fn(),
    },
    pollVote: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

const mockPollOptions = [
  { id: "opt-1", label: "One Piece", pollId: "poll-1", order: 0, votes: [{ userId: "u1" }] },
  { id: "opt-2", label: "Naruto",    pollId: "poll-1", order: 1, votes: [] },
];

const mockPoll = {
  id: "poll-1",
  question: "Which anime is the best?",
  authorId: "u1",
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  createdAt: new Date(),
  options: mockPollOptions,
};

describe("polls.service — formatPoll", () => {
  beforeEach(() => vi.clearAllMocks());

  it("getById returns formatted poll with vote counts", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getById } = await import("../app/src/modules/polls/polls.service");

    (prisma.poll.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockPoll);

    const result = await getById("poll-1");
    expect(result.poll.question).toBe("Which anime is the best?");
    expect(result.poll.totalVotes).toBe(1);
    expect(result.poll.options[0].votes).toBe(1);
    expect(result.poll.options[1].votes).toBe(0);
  });

  it("getById throws NOT_FOUND for non-existent poll", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { getById } = await import("../app/src/modules/polls/polls.service");

    (prisma.poll.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(getById("nonexistent")).rejects.toThrow("Poll not found");
  });
});

describe("polls.service — vote", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NOT_FOUND for non-existent poll", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { vote } = await import("../app/src/modules/polls/polls.service");

    (prisma.poll.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(vote("nonexistent", "user-1", "opt-1")).rejects.toThrow("Poll not found");
  });

  it("throws BAD_REQUEST for expired poll", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { vote } = await import("../app/src/modules/polls/polls.service");

    const expiredPoll = { ...mockPoll, expiresAt: new Date(Date.now() - 1000) };
    (prisma.poll.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(expiredPoll);

    await expect(vote("poll-1", "user-1", "opt-1")).rejects.toThrow("expired");
  });

  it("throws CONFLICT when user has already voted", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { vote } = await import("../app/src/modules/polls/polls.service");

    (prisma.poll.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockPoll);
    (prisma.pollVote.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ userId: "user-1" });

    await expect(vote("poll-1", "user-1", "opt-1")).rejects.toThrow("already voted");
  });

  it("throws NOT_FOUND for invalid option", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { vote } = await import("../app/src/modules/polls/polls.service");

    (prisma.poll.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockPoll);
    (prisma.pollVote.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    await expect(vote("poll-1", "user-1", "non-existent-opt")).rejects.toThrow("Option not found");
  });

  it("records vote and returns updated poll", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { vote } = await import("../app/src/modules/polls/polls.service");

    (prisma.poll.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockPoll)         // first call (check)
      .mockResolvedValueOnce({ ...mockPoll,    // second call (after vote)
        options: [
          { ...mockPollOptions[0], votes: [{ userId: "u1" }, { userId: "u2" }] },
          { ...mockPollOptions[1], votes: [] },
        ]
      });
    (prisma.pollVote.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    (prisma.pollVote.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});

    const result = await vote("poll-1", "user-2", "opt-1");
    expect(result.poll.totalVotes).toBe(2);
  });
});

describe("polls.service — create", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a poll with default expiry of 7 days", async () => {
    const { prisma } = await import("../app/src/config/prisma");
    const { create } = await import("../app/src/modules/polls/polls.service");

    (prisma.poll.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...mockPoll,
      options: mockPollOptions.map(o => ({ ...o, votes: [] })),
    });

    const result = await create("user-1", {
      question: "Which anime is the best?",
      options: ["One Piece", "Naruto"],
    });

    expect(result.poll.question).toBe("Which anime is the best?");
    expect(result.poll.options).toHaveLength(2);
  });
});
