import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { badRequest } from "../../lib/errors";
import * as service from "./events.service";

const createSchema = z.object({
  title: z.string().trim().min(3).max(120),
  description: z.string().max(2000).optional(),
  kind: z.enum(["WATCH_PARTY", "AMA", "GAME_NIGHT", "GENERAL"]).optional(),
  animeMalId: z.number().int().positive().optional(),
  episodeNumber: z.number().int().positive().optional(),
  startsAt: z.string().min(1),
  endsAt: z.string().optional(),
  location: z.string().max(500).optional(),
});
const updateSchema = createSchema.partial();
const rsvpSchema = z.object({ status: z.enum(["GOING", "MAYBE", "NOT_GOING"]) });

const uid = (res: Response): string => res.locals.user.id;

export async function listClubEvents(req: Request, res: Response, next: NextFunction) {
  try {
    const filter = req.query.filter === "past" ? "past" : "upcoming";
    res.json(await service.listClubEvents(req.params.slug as string, res.locals.user?.id, filter));
  } catch (e) { next(e); }
}
export async function createClubEvent(req: Request, res: Response, next: NextFunction) {
  try {
    const dto = createSchema.parse(req.body);
    res.status(201).json(await service.createClubEvent(uid(res), req.params.slug as string, dto));
  } catch (e) { next(e); }
}
export async function getEvent(req: Request, res: Response, next: NextFunction) {
  try { res.json(await service.getEvent(req.params.id as string, res.locals.user?.id)); } catch (e) { next(e); }
}
export async function updateEvent(req: Request, res: Response, next: NextFunction) {
  try {
    const patch = updateSchema.parse(req.body);
    res.json(await service.updateEvent(uid(res), req.params.id as string, patch));
  } catch (e) { next(e); }
}
export async function deleteEvent(req: Request, res: Response, next: NextFunction) {
  try { res.json(await service.deleteEvent(uid(res), req.params.id as string)); } catch (e) { next(e); }
}
export async function rsvp(req: Request, res: Response, next: NextFunction) {
  try {
    const { status } = rsvpSchema.parse(req.body);
    res.json(await service.rsvp(uid(res), req.params.id as string, status));
  } catch (e) { next(e); void badRequest; }
}
