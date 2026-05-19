/**
 * Polls controller tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

vi.mock("../app/src/modules/polls/polls.service", () => ({
  list:    vi.fn().mockResolvedValue({ data: [], meta: {} }),
  create:  vi.fn().mockResolvedValue({ poll: { id: "p1" } }),
  getById: vi.fn().mockResolvedValue({ poll: { id: "p1" } }),
  vote:    vi.fn().mockResolvedValue({ poll: { id: "p1", totalVotes: 1 } }),
}));

vi.mock("../app/src/modules/polls/polls.schema", () => ({
  createPollSchema: { parse: vi.fn().mockReturnValue({
    question: "Best anime?",
    options: ["A", "B"],
  }) },
  voteSchema: { parse: vi.fn().mockReturnValue({ optionId: "opt-1" }) },
}));

function makeReq(body = {}, params = {}, query = {}): Request {
  return { body, params, query, headers: {} } as unknown as Request;
}

function makeRes(): Response & { locals: Record<string, unknown> } {
  return {
    locals: { user: { id: "user-1" } },
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as any;
}

describe("polls controller", () => {
  beforeEach(() => vi.clearAllMocks());

  it("listPolls returns 200", async () => {
    const { listPolls } = await import("../app/src/modules/polls/polls.controller");
    const res = makeRes();
    const next = vi.fn();

    await listPolls(makeReq({}, {}, { page: "1" }), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("createPoll returns 201", async () => {
    const { createPoll } = await import("../app/src/modules/polls/polls.controller");
    const res = makeRes();
    const next = vi.fn();

    await createPoll(makeReq({ question: "Best?", options: ["A", "B"] }), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("getPollById returns 200", async () => {
    const { getPollById } = await import("../app/src/modules/polls/polls.controller");
    const res = makeRes();
    const next = vi.fn();

    await getPollById(makeReq({}, { id: "poll-1" }), res, next);

    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("votePoll returns 200", async () => {
    const { votePoll } = await import("../app/src/modules/polls/polls.controller");
    const res = makeRes();
    const next = vi.fn();

    await votePoll(makeReq({ optionId: "opt-1" }, { id: "poll-1" }), res, next);

    expect(res.status).toHaveBeenCalledWith(200);
  });
});
