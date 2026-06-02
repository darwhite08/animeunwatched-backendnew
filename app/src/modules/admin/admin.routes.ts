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
import * as jobs       from "./jobs.controller";
import * as deps       from "./dependencies.controller";
import * as security   from "./security.controller";
import * as templates  from "./templates.controller";
import * as adminTeam  from "./adminTeam.controller";
import * as modq       from "./moderationQueue.controller";
import * as billing    from "./billing.controller";
import * as loginHist  from "./loginHistory.controller";
import * as undo       from "./undo.controller";
import * as search     from "./search.controller";
import * as reports    from "./reports.controller";
import * as mailer     from "./mailer.controller";
import * as inspect    from "./inspect.controller";
import * as cRules     from "./contentRules.controller";
import * as modAct     from "./modActivity.controller";
import * as anomalies  from "./anomalies.controller";

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

// M9 — jobs + dependency health
adminRouter.get(   "/jobs",                           requirePermission("settings","read"), jobs.getJobs);
adminRouter.post(  "/jobs/:name/retry",               requirePermission("settings","write"), jobs.retryJob);
adminRouter.get(   "/health/dependencies",            requirePermission("settings","read"), deps.getDependencies);

// M10 — security policies + events
adminRouter.get(   "/security/policies",              requirePermission("security","read"),  security.getPolicies);
adminRouter.patch( "/security/policies",              requirePermissionWithStepUp("security","write"), security.setPolicy);
adminRouter.get(   "/security/events",                requirePermission("security","read"),  security.listSecurityEvents);

// M14 — notification templates + admin alerts
adminRouter.get(   "/notification-templates",         requirePermission("settings","read"),  templates.listTemplates);
adminRouter.get(   "/notification-templates/:id",     requirePermission("settings","read"),  templates.getTemplate);
adminRouter.post(  "/notification-templates",         requirePermission("settings","write"), templates.createTemplate);
adminRouter.patch( "/notification-templates/:id",     requirePermission("settings","write"), templates.updateTemplate);
adminRouter.delete("/notification-templates/:id",     requirePermission("settings","write"), templates.deleteTemplate);
adminRouter.get(   "/alerts",                         requirePermission("settings","read"),  templates.listAdminAlerts);
adminRouter.post(  "/alerts/:id/ack",                 requirePermission("settings","write"), templates.ackAlert);

// M15 — admin team
adminRouter.get(   "/admin-team",                     requirePermission("roles","read"),    adminTeam.listAdminTeam);
adminRouter.post(  "/admin-team/:userId/reviewed",    requirePermissionWithStepUp("roles","write"), adminTeam.markReviewed);

// M7 — generic moderation queue
adminRouter.get(   "/moderation/queue",               requirePermission("moderation","read"), modq.listQueue);
adminRouter.post(  "/moderation/queue",               requirePermission("moderation","act"),  modq.createQueueItem);
adminRouter.patch( "/moderation/queue/:id",           requirePermission("moderation","act"),  modq.reviewQueueItem);

// M5 — Billing
adminRouter.get(   "/billing/provider",                requirePermission("billing","read"),    billing.getProviderStatus);
adminRouter.get(   "/billing/plans",                   requirePermission("billing","read"),    billing.listPlans);
adminRouter.post(  "/billing/plans",                   requirePermissionWithStepUp("billing","refund"), billing.createPlan);
adminRouter.get(   "/billing/subscriptions",           requirePermission("billing","read"),    billing.listSubscriptions);
adminRouter.get(   "/billing/subscriptions/:id",       requirePermission("billing","read"),    billing.getSubscription);
adminRouter.post(  "/billing/subscriptions/:id/change-plan",   requirePermissionWithStepUp("billing","refund"), billing.changePlan);
adminRouter.post(  "/billing/invoices/:id/refund",             requirePermissionWithStepUp("billing","refund"), billing.refundInvoice);
adminRouter.post(  "/billing/subscriptions/:id/credit",        requirePermission("billing","credit"),           billing.creditSubscription);
adminRouter.post(  "/billing/subscriptions/:id/extend-trial",  requirePermission("billing","credit"),           billing.extendTrial);
adminRouter.post(  "/billing/subscriptions/:id/cancel",        requirePermissionWithStepUp("billing","refund"), billing.cancelSubscription);

// M2 — login history (per user)
adminRouter.get(   "/users/:userId/login-history",     requirePermission("users","read"),      loginHist.getLoginHistory);

// Undo system
adminRouter.get(   "/undo/recent",                     requirePermission("audit","read"),      undo.getUndoable);
adminRouter.post(  "/undo/:auditId",                   requirePermissionWithStepUp("audit","read"), undo.undoAction);

// Global search (command palette)
adminRouter.get(   "/search",                          requirePermission("users","read"),      search.globalSearch);

// M13 — reports
adminRouter.get(   "/reports",                         requirePermission("audit","read"),      reports.listReportNames);
adminRouter.get(   "/reports/:name",                   requirePermission("audit","read"),      reports.getReport);
adminRouter.get(   "/reports/:name/export",            requirePermission("audit","export"),    reports.exportReport);
adminRouter.get(   "/reports/schedules/list",          requirePermission("audit","read"),      reports.listSchedules);
adminRouter.post(  "/reports/schedules",               requirePermission("audit","export"),    reports.createSchedule);
adminRouter.delete("/reports/schedules/:id",           requirePermission("audit","export"),    reports.deleteSchedule);
adminRouter.post(  "/reports/schedules/:id/run",       requirePermission("audit","export"),    reports.runScheduleNow);

// Public webhook receiver (no auth — but the body must be a valid provider event)
adminRouter.post(  "/billing/webhooks/:provider",      billing.receiveBillingWebhook);

// Mailer status + test-send
adminRouter.get(   "/mailer/status",                   requirePermission("settings","read"),  mailer.getMailerStatus);
adminRouter.post(  "/mailer/test",                     requirePermission("settings","write"), mailer.sendTestEmail);

// Inspection / forensics
adminRouter.get(   "/inspect/search",                  requirePermission("audit","read"),     inspect.inspectSearch);
adminRouter.get(   "/inspect/ip/:ip",                  requirePermission("security","read"),  inspect.getIpDossier);
adminRouter.get(   "/inspect/users/:userId/risk",      requirePermission("users","read"),     inspect.getUserRisk);
adminRouter.get(   "/inspect/users/:userId/similar",   requirePermission("users","read"),     inspect.findSimilarAccounts);
adminRouter.get(   "/inspect/ip-blocks",               requirePermission("security","read"),  inspect.listIpBlocks);
adminRouter.post(  "/inspect/ip-blocks",               requirePermissionWithStepUp("security","write"), inspect.manualBlockIp);
adminRouter.delete("/inspect/ip-blocks/:ip",           requirePermissionWithStepUp("security","write"), inspect.unblockIp);

// Content auto-flag rules
adminRouter.get(   "/content/rules",                   requirePermission("moderation","read"), cRules.listRules);
adminRouter.post(  "/content/rules",                   requirePermission("moderation","act"),  cRules.createRule);
adminRouter.patch( "/content/rules/:id",               requirePermission("moderation","act"),  cRules.updateRule);
adminRouter.delete("/content/rules/:id",               requirePermission("moderation","act"),  cRules.deleteRule);
adminRouter.post(  "/content/rules/test",              requirePermission("moderation","read"), cRules.testRule);

// Moderator activity dashboard + bulk queue actions
adminRouter.get(   "/moderation/activity",             requirePermission("moderation","read"), modAct.getModActivity);
adminRouter.post(  "/moderation/bulk",                 requirePermission("moderation","act"),  modAct.bulkModerate);

// Anomalies (impossible travel, new country, VPN, IP churn, concurrent country)
adminRouter.get(   "/anomalies",                       requirePermission("security","read"),  anomalies.listAnomalies);
adminRouter.post(  "/anomalies/:id/ack",               requirePermission("security","write"), anomalies.ackAnomaly);
adminRouter.post(  "/anomalies/bulk-ack",              requirePermission("security","write"), anomalies.bulkAckAnomalies);
adminRouter.post(  "/anomalies/scan",                  requirePermission("security","write"), anomalies.triggerScan);

