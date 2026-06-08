import { notFound, conflict, badReq } from "../../lib/errors";
import { prisma } from "../../config/prisma";
import type { CreatePollDto } from "./polls.schema";

function meta(total: number, page: number, limit: number) {
  return { total, page, limit, pages: Math.ceil(total / limit) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatPoll(poll: any) {
  const options = (poll.options ?? []).map((o: any) => ({
    id: o.id, label: o.label, votes: Array.isArray(o.votes) ? o.votes.length : 0,
  }));
  const totalVotes = options.reduce((s: number, o: any) => s + o.votes, 0);
  return { id: poll.id, question: poll.question, options, authorId: poll.authorId, createdAt: poll.createdAt, expiresAt: poll.expiresAt, totalVotes };
}

const pollInclude = { options: { include: { votes: true }, orderBy: { order: "asc" as const } } };

export async function list(page = 1, limit = 20) {
  const skip = (page - 1) * limit;
  const [polls, total] = await prisma.$transaction([
    prisma.poll.findMany({ skip, take: limit, orderBy: { createdAt: "desc" }, include: pollInclude }),
    prisma.poll.count(),
  ]);
  return { data: polls.map(formatPoll), meta: meta(total, page, limit) };
}

export async function create(authorId: string, dto: CreatePollDto, clubId?: string) {
  const hours = dto.expiresIn ?? ((dto.expiresInDays ?? 7) * 24);
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
  const poll = await prisma.poll.create({
    data: { question: dto.question, authorId, expiresAt, ...(clubId ? { clubId } : {}), options: { create: dto.options.map((label, i) => ({ label, order: i })) } },
    include: pollInclude,
  });
  return { poll: formatPoll(poll) };
}

/** Club-scoped poll list with the caller's vote marked (myVote). */
export async function listForClub(clubId: string, userId?: string) {
  const polls = await prisma.poll.findMany({ where: { clubId }, orderBy: { createdAt: "desc" }, take: 50, include: pollInclude });
  let myVotes = new Map<string, string>();
  if (userId && polls.length) {
    const votes = await prisma.pollVote.findMany({ where: { userId, pollId: { in: polls.map((p) => p.id) } }, select: { pollId: true, optionId: true } });
    myVotes = new Map(votes.map((v) => [v.pollId, v.optionId]));
  }
  return { polls: polls.map((p) => ({ ...formatPoll(p), myVote: myVotes.get(p.id) ?? null })) };
}

export async function getById(id: string) {
  const poll = await prisma.poll.findUnique({ where: { id }, include: pollInclude });
  if (!poll) throw notFound("Poll not found");
  return { poll: formatPoll(poll) };
}

export async function vote(pollId: string, userId: string, optionId: string) {
  const poll = await prisma.poll.findUnique({ where: { id: pollId }, include: { options: true } });
  if (!poll) throw notFound("Poll not found");
  if (new Date() > poll.expiresAt) throw badReq("This poll has expired");

  const existing = await prisma.pollVote.findUnique({ where: { userId_pollId: { userId, pollId } } });
  if (existing) throw conflict("You have already voted on this poll");

  if (!poll.options.find(o => o.id === optionId)) throw notFound("Option not found");

  await prisma.pollVote.create({ data: { userId, pollId, optionId } });
  const updated = await prisma.poll.findUnique({ where: { id: pollId }, include: pollInclude });
  if (!updated) throw notFound("Poll not found after voting");
  return { poll: formatPoll(updated) };
}
