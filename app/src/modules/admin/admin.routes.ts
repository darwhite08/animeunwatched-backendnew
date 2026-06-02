import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import { requireAdmin } from "../../middlewares/requireAdmin";
import { requirePermission, requirePermissionWithStepUp } from "../../lib/permissions";
import * as ctrl       from "./admin.controller";
import * as users      from "./users.controller";
import * as roles      from "./roles.controller";
import * as auditCtrl  from "./auditLog.controller";
import * as stepup     from "./stepup.controller";
import * as flags      from "./flags.controller";
import * as ents       from "./entitlements.controller";
import * as imp        from "./impersonation.controller";
import * as content    from "./content.controller";
import * as dsr        from "./dsr.controller";
import * as apiKeys    from "./apiKeys.controller";
import * as webhooks   from "./webhooks.controller";
import * as ann        from "./announcements.controller";
import * as settings   from "./settings.controller";

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

// Feature flags & overrides
adminRouter.get(   "/flags",                          requirePermission("flags","read"),            flags.listFlags);
adminRouter.post(  "/flags",                          requirePermissionWithStepUp("flags","write"), flags.createFlag);
adminRouter.patch( "/flags/:flagId",                  requirePermission("flags","write"),           flags.updateFlag);
adminRouter.delete("/flags/:flagId",                  requirePermissionWithStepUp("flags","write"), flags.deleteFlag);
adminRouter.post(  "/flags/:flagId/kill",             requirePermissionWithStepUp("flags","kill"),  flags.killFlag);
adminRouter.post(  "/flags/:flagId/revive",           requirePermissionWithStepUp("flags","kill"),  flags.reviveFlag);
adminRouter.get(   "/flags/:flagId/overrides",        requirePermission("flags","read"),            flags.listOverrides);
adminRouter.post(  "/flags/:flagId/overrides",        requirePermission("flags","write"),           flags.createOverride);
adminRouter.delete("/flags/overrides/:overrideId",    requirePermission("flags","write"),           flags.deleteOverride);
adminRouter.get(   "/flags/evaluate/:key",            requirePermission("flags","read"),            flags.evaluateFlag);

// Entitlements
adminRouter.get(   "/entitlements",                   requirePermission("entitlements","read"),  ents.listEntitlements);
adminRouter.post(  "/entitlements",                   requirePermission("entitlements","write"), ents.grantEntitlement);
adminRouter.delete("/entitlements/:id",               requirePermission("entitlements","write"), ents.revokeEntitlement);

// Impersonation
adminRouter.post(  "/impersonation/start",            requirePermissionWithStepUp("impersonation","start"), imp.startImpersonation);
adminRouter.post(  "/impersonation/stop",             imp.stopImpersonation);
adminRouter.get(   "/impersonation/active",           requirePermission("impersonation","start"),           imp.listActive);

// Content & moderation
adminRouter.get(   "/content/posts",                  requirePermission("moderation","read"), content.listPosts);
adminRouter.delete("/content/posts/:postId",          requirePermission("moderation","act"),  content.deletePost);
adminRouter.get(   "/content/clubs",                  requirePermission("moderation","read"), content.listClubs);
adminRouter.delete("/content/clubs/:clubId",          requirePermission("moderation","act"),  content.deleteClub);
adminRouter.post(  "/users/:userId/shadow-ban",       requirePermission("moderation","act"),  content.shadowBanUser);
adminRouter.delete("/users/:userId/shadow-ban",       requirePermission("moderation","act"),  content.unshadowBanUser);

// DSR (Data Subject Requests) — high-risk → step-up
adminRouter.get(   "/dsr/export/:userId",             requirePermissionWithStepUp("dsr","export"), dsr.exportUserData);
adminRouter.delete("/dsr/:userId",                    requirePermissionWithStepUp("dsr","delete"), dsr.deleteUserData);

// API keys
adminRouter.get(   "/api-keys",                       requirePermission("api_keys","read"),         apiKeys.listApiKeys);
adminRouter.post(  "/api-keys",                       requirePermissionWithStepUp("api_keys","write"), apiKeys.createApiKey);
adminRouter.post(  "/api-keys/:keyId/rotate",         requirePermissionWithStepUp("api_keys","write"), apiKeys.rotateApiKey);
adminRouter.delete("/api-keys/:keyId",                requirePermissionWithStepUp("api_keys","write"), apiKeys.revokeApiKey);

// Webhooks
adminRouter.get(   "/webhooks",                       requirePermission("webhooks","read"),  webhooks.listEndpoints);
adminRouter.post(  "/webhooks",                       requirePermission("webhooks","write"), webhooks.createEndpoint);
adminRouter.patch( "/webhooks/:endpointId",           requirePermission("webhooks","write"), webhooks.updateEndpoint);
adminRouter.delete("/webhooks/:endpointId",           requirePermission("webhooks","write"), webhooks.deleteEndpoint);
adminRouter.get(   "/webhooks/deliveries",            requirePermission("webhooks","read"),  webhooks.listDeliveries);
adminRouter.post(  "/webhooks/deliveries/:deliveryId/replay", requirePermission("webhooks","replay"), webhooks.replayDelivery);

// Announcements
adminRouter.get(   "/announcements",                  requirePermission("settings","read"),  ann.listAnnouncements);
adminRouter.post(  "/announcements",                  requirePermission("settings","write"), ann.createAnnouncement);
adminRouter.post(  "/announcements/:id/publish",      requirePermission("settings","write"), ann.publishAnnouncement);
adminRouter.delete("/announcements/:id",              requirePermission("settings","write"), ann.deleteAnnouncement);

// Settings
adminRouter.get(   "/settings",                       requirePermission("settings","read"),  settings.listSettings);
adminRouter.get(   "/settings/:key",                  requirePermission("settings","read"),  settings.getSetting);
adminRouter.put(   "/settings/:key",                  requirePermission("settings","write"), settings.upsertSetting);
adminRouter.delete("/settings/:key",                  requirePermission("settings","write"), settings.deleteSetting);

