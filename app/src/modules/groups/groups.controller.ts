import { NextFunction, Request, Response } from "express";
import { badRequest } from "../../lib/errors";
import * as service from "./groups.service";
import * as S from "./groups.schema";

const uid = (res: Response): string => res.locals.user.id;

function parse<T>(schema: { safeParse: (i: unknown) => { success: boolean; data?: T; error?: unknown } }, req: Request): T {
  const r = schema.safeParse({ params: req.params, query: req.query, body: req.body });
  if (!r.success) throw badRequest("Invalid request");
  return r.data as T;
}

export async function create(req: Request, res: Response, next: NextFunction) {
  try { const { body } = parse(S.createGroupSchema, req) as any; res.status(201).json(await service.createGroup(uid(res), body)); }
  catch (e) { next(e); }
}
export async function list(req: Request, res: Response, next: NextFunction) {
  try { const { query } = parse(S.listGroupsSchema, req) as any; res.json(await service.listGroups(uid(res), query)); }
  catch (e) { next(e); }
}
export async function unread(req: Request, res: Response, next: NextFunction) {
  try { res.json(await service.unreadCount(uid(res))); } catch (e) { next(e); }
}
export async function get(req: Request, res: Response, next: NextFunction) {
  try { const { params } = parse(S.groupIdSchema, req) as any; res.json(await service.getGroup(uid(res), params.groupId)); }
  catch (e) { next(e); }
}
export async function devices(req: Request, res: Response, next: NextFunction) {
  try { const { params } = parse(S.groupIdSchema, req) as any; res.json(await service.getGroupDevices(uid(res), params.groupId)); }
  catch (e) { next(e); }
}
export async function messages(req: Request, res: Response, next: NextFunction) {
  try { const { params, query } = parse(S.getMessagesSchema, req) as any; res.json(await service.getMessages(uid(res), params.groupId, query)); }
  catch (e) { next(e); }
}
export async function send(req: Request, res: Response, next: NextFunction) {
  try { const { params, body } = parse(S.sendMessageSchema, req) as any; res.status(201).json(await service.sendGroupMessage(uid(res), params.groupId, body)); }
  catch (e) { next(e); }
}
export async function markRead(req: Request, res: Response, next: NextFunction) {
  try { const { params } = parse(S.groupIdSchema, req) as any; res.json(await service.markRead(uid(res), params.groupId)); }
  catch (e) { next(e); }
}
export async function update(req: Request, res: Response, next: NextFunction) {
  try { const { params, body } = parse(S.updateGroupSchema, req) as any; res.json(await service.updateGroup(uid(res), params.groupId, body)); }
  catch (e) { next(e); }
}
export async function addMembers(req: Request, res: Response, next: NextFunction) {
  try { const { params, body } = parse(S.addMembersSchema, req) as any; res.json(await service.addMembers(uid(res), params.groupId, body.memberIds)); }
  catch (e) { next(e); }
}
export async function removeMember(req: Request, res: Response, next: NextFunction) {
  try { const { params } = parse(S.memberParamSchema, req) as any; res.json(await service.removeMember(uid(res), params.groupId, params.userId)); }
  catch (e) { next(e); }
}
export async function leave(req: Request, res: Response, next: NextFunction) {
  try { const { params } = parse(S.groupIdSchema, req) as any; res.json(await service.leaveGroup(uid(res), params.groupId)); }
  catch (e) { next(e); }
}
export async function setRole(req: Request, res: Response, next: NextFunction) {
  try { const { params, body } = parse(S.setRoleSchema, req) as any; res.json(await service.setRole(uid(res), params.groupId, params.userId, body.role)); }
  catch (e) { next(e); }
}
export async function mute(req: Request, res: Response, next: NextFunction) {
  try { const { params, body } = parse(S.toggleSchema, req) as any; res.json(await service.muteGroup(uid(res), params.groupId, body.mutedUntil ?? null)); }
  catch (e) { next(e); }
}
export async function pin(req: Request, res: Response, next: NextFunction) {
  try { const { params, body } = parse(S.toggleSchema, req) as any; res.json(await service.pinGroup(uid(res), params.groupId, body.value ?? true)); }
  catch (e) { next(e); }
}
export async function archive(req: Request, res: Response, next: NextFunction) {
  try { const { params, body } = parse(S.toggleSchema, req) as any; res.json(await service.archiveGroup(uid(res), params.groupId, body.value ?? true)); }
  catch (e) { next(e); }
}
export async function editMessage(req: Request, res: Response, next: NextFunction) {
  try { const { params, body } = parse(S.editMessageSchema, req) as any; res.json(await service.editMessage(uid(res), params.groupId, params.messageId, body.body)); }
  catch (e) { next(e); }
}
export async function deleteMessage(req: Request, res: Response, next: NextFunction) {
  try { const { params, query } = parse(S.deleteMessageSchema, req) as any; res.json(await service.deleteMessage(uid(res), params.groupId, params.messageId, query.scope)); }
  catch (e) { next(e); }
}
export async function react(req: Request, res: Response, next: NextFunction) {
  try { const { params, body } = parse(S.reactionSchema, req) as any; res.json(await service.setReaction(uid(res), params.groupId, params.messageId, body.emoji)); }
  catch (e) { next(e); }
}
