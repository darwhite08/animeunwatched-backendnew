import { randomUUID } from "crypto";
import { notFound, conflict, badReq } from "../../lib/errors";
import type { CreatePollDto } from "./polls.schema";

// ─── In-memory store for polls (replace with Prisma when schema is extended) ──

type PollOption = { id: string; label: string; votes: number };
type Poll = {
  id: string;
  question: string;
  options: PollOption[];
  authorId: string;
  createdAt: Date;
  expiresAt: Date;
  totalVotes: number;
};

const pollStore = new Map<string, Poll>();

// Track which user voted on which poll (userId -> Set of pollIds)
const voteTracker = new Map<string, Set<string>>();

// ─── Pagination helper ────────────────────────────────────────────────────────

function meta(total: number, page: number, limit: number) {
  return { total, page, limit, pages: Math.ceil(total / limit) };
}

// ─── list ─────────────────────────────────────────────────────────────────────

export async function list(page = 1, limit = 20) {
  const allPolls = Array.from(pollStore.values()).sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );

  const total = allPolls.length;
  const skip = (page - 1) * limit;
  const data = allPolls.slice(skip, skip + limit);

  return { data, meta: meta(total, page, limit) };
}

// ─── create ───────────────────────────────────────────────────────────────────

export async function create(authorId: string, dto: CreatePollDto) {
  const pollId = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + dto.expiresInDays * 24 * 60 * 60 * 1000);

  const poll: Poll = {
    id: pollId,
    question: dto.question,
    options: dto.options.map((label) => ({ id: randomUUID(), label, votes: 0 })),
    authorId,
    createdAt: now,
    expiresAt,
    totalVotes: 0,
  };

  pollStore.set(pollId, poll);
  return { poll };
}

// ─── getById ──────────────────────────────────────────────────────────────────

export async function getById(id: string) {
  const poll = pollStore.get(id);
  if (!poll) throw notFound("Poll not found");
  return { poll };
}

// ─── vote ─────────────────────────────────────────────────────────────────────

export async function vote(pollId: string, userId: string, optionId: string) {
  const poll = pollStore.get(pollId);
  if (!poll) throw notFound("Poll not found");

  if (new Date() > poll.expiresAt) {
    throw badReq("This poll has expired");
  }

  const userVotes = voteTracker.get(userId);
  if (userVotes && userVotes.has(pollId)) {
    throw conflict("You have already voted on this poll");
  }

  const option = poll.options.find((o) => o.id === optionId);
  if (!option) throw notFound("Option not found");

  option.votes += 1;
  poll.totalVotes += 1;

  if (!voteTracker.has(userId)) {
    voteTracker.set(userId, new Set());
  }
  voteTracker.get(userId)!.add(pollId);

  return { poll };
}
