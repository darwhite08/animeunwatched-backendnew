import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import { requireAdmin } from "../../middlewares/requireAdmin";
import { requirePermission, requirePermissionWithStepUp } from "../../lib/permissions";
import * as ctrl       from "./admin.controller";
import * as users      from "./users.controller";
import * as roles      from "./roles.controller";
import * as auditCtrl  from "./auditLog.controller";
import * as stepup     from "./stepup.controller";

export const adminRouter = Router();

// Every admin route requires a valid Bearer token AND legacy role=ADMIN.
// Fine-grained permission checks layer on top via requirePermission(...).
adminRouter.use(requireAuth, requireAdmin);

// Headline / overview
adminRouter.get("/stats",              ctrl.getStats);
adminRouter.get("/health",             ctrl.getPlatformHealth);
adminRouter.get("/metrics/overview",   ctrl.getMetricsOverview);
adminRouter.get("/analytics/live",     ctrl.getAnalyticsLive);
adminRouter.get("/ga/realtime",        ctrl.getGAAnalyticsLive);
adminRouter.get("/metrics/timeseries", ctrl.getTimeSeries);
adminRouter.get("/metrics/top",        ctrl.getTopPerformers);
adminRouter.get("/metrics/funnel",     ctrl.getFunnel);
adminRouter.get("/metrics/system",     ctrl.getSystemMetrics);

// Users — read
adminRouter.get("/users",                  requirePermission("users","read"),  ctrl.listUsers);
adminRouter.get("/users/recent",           requirePermission("users","read"),  ctrl.getRecentUsers);
adminRouter.get("/users/:userId",          requirePermission("users","read"),  ctrl.getUserDetail);

// Users — mutations
adminRouter.patch( "/users/:userId",                  requirePermission("users","update"),           users.patchUser);
adminRouter.post(  "/users/:userId/ban",              requirePermission("users","suspend"),          ctrl.banUser);
adminRouter.post(  "/users/:userId/unban",            requirePermission("users","suspend"),          ctrl.unbanUser);
adminRouter.post(  "/users/:userId/role",             requirePermissionWithStepUp("users","role"),   ctrl.setUserRole);
adminRouter.post(  "/users/:userId/password-reset",   requirePermission("users","reset_password"),   users.passwordReset);
adminRouter.post(  "/users/:userId/mfa-reset",        requirePermission("users","reset_mfa"),        users.resetMfa);
adminRouter.post(  "/users/:userId/revoke-sessions",  requirePermission("users","revoke_sessions"),  users.revokeSessions);
adminRouter.get(   "/users/:userId/sessions",         requirePermission("users","read"),             users.getUserSessions);
adminRouter.delete("/users/:userId",                  requirePermissionWithStepUp("users","delete"), users.softDelete);
adminRouter.post(  "/users/bulk",                     requirePermission("users","suspend"),          users.bulkAction);

// Invites
adminRouter.get(   "/invites",                        requirePermission("users","read"),   users.listInvites);
adminRouter.post(  "/invites",                        requirePermission("users","create"), users.createInvite);
adminRouter.delete("/invites/:inviteId",              requirePermission("users","create"), users.revokeInvite);

// RBAC
adminRouter.get(   "/permissions",                    requirePermission("roles","read"),            roles.listPermissions);
adminRouter.get(   "/roles",                          requirePermission("roles","read"),            roles.listRoles);
adminRouter.post(  "/roles",                          requirePermissionWithStepUp("roles","write"), roles.createRole);
adminRouter.patch( "/roles/:roleId",                  requirePermissionWithStepUp("roles","write"), roles.updateRole);
adminRouter.delete("/roles/:roleId",                  requirePermissionWithStepUp("roles","write"), roles.deleteRole);
adminRouter.get(   "/roles/diff",                     requirePermission("roles","read"),            roles.diffRoles);
adminRouter.get(   "/users/:userId/admin-roles",      requirePermission("roles","read"),            roles.getUserRoles);
adminRouter.post(  "/users/:userId/admin-roles",      requirePermissionWithStepUp("roles","write"), roles.grantUserRole);
adminRouter.delete("/users/:userId/admin-roles",      requirePermissionWithStepUp("roles","write"), roles.revokeUserRole);

// Moderation queue
adminRouter.get("/reports",                requirePermission("moderation","read"), ctrl.listReports);
adminRouter.patch("/reports/:reportId",    requirePermission("moderation","act"),  ctrl.resolveReport);

// Legacy audit (SecurityEvent — auth events)
adminRouter.get("/audit",                  requirePermission("audit","read"), ctrl.listAuditLog);

// Admin AuditLog (hash-chained, append-only)
adminRouter.get("/audit/admin",            requirePermission("audit","read"),   auditCtrl.listAuditLog);
adminRouter.get("/audit/admin/export",     requirePermission("audit","export"), auditCtrl.exportAuditLog);
adminRouter.get("/audit/admin/verify",     requirePermission("audit","read"),   auditCtrl.verifyAuditChain);

// Step-up authentication — no extra permission gate; the password+TOTP IS the gate
adminRouter.post("/stepup",                stepup.requestStepUp);
